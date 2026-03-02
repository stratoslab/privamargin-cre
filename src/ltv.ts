/**
 * LTV computation logic — pure functions, no SDK dependencies.
 *
 * Extracted so the same math can run in CRE WASM, unit tests,
 * and the existing PrivaMargin browser-side monitor.
 */

import {
  type PositionData,
  type VaultData,
  type VaultAsset,
  type BrokerFundLinkData,
  type LTVResult,
  COINGECKO_IDS,
  FALLBACK_PRICES,
} from './config';

// ---------------------------------------------------------------------------
// Price helpers
// ---------------------------------------------------------------------------

/**
 * Parse CoinGecko /simple/price response into a symbol→USD map.
 * Falls back to hardcoded prices for any missing symbol.
 */
export function parsePrices(
  geckoResponse: Record<string, { usd?: number }>,
): Record<string, number> {
  const prices: Record<string, number> = { ...FALLBACK_PRICES };

  for (const [symbol, geckoId] of Object.entries(COINGECKO_IDS)) {
    const price = geckoResponse[geckoId]?.usd;
    if (price && price > 0) {
      prices[symbol] = price;
    }
  }

  return prices;
}

// ---------------------------------------------------------------------------
// Vault valuation
// ---------------------------------------------------------------------------

/**
 * Resolve the pricing symbol for a vault asset.
 * assetId format: "ETH-1234567890" or "CC-9876543210" → extract prefix.
 */
function resolveSymbol(assetId: string, assetType: string): string {
  if (assetId) {
    const parts = assetId.split('-');
    const symbolParts: string[] = [];
    for (const part of parts) {
      // Stop at numeric-only segments (timestamp suffixes)
      if (/^\d{10,}$/.test(part)) break;
      symbolParts.push(part);
    }
    if (symbolParts.length > 0) {
      const sym = symbolParts.join('-');
      if (FALLBACK_PRICES[sym] !== undefined) return sym;
    }
  }

  switch (assetType) {
    case 'Stablecoin': return 'USDC';
    case 'CantonCoin': return 'CC';
    case 'Cryptocurrency': return 'ETH';
    default: return assetType;
  }
}

/** Calculate total USD value of a vault's collateral using live prices. */
export function calculateVaultValue(
  assets: VaultAsset[],
  prices: Record<string, number>,
): number {
  let total = 0;
  for (const asset of assets) {
    const amount = parseFloat(asset.amount) || 0;
    const symbol = resolveSymbol(asset.assetId, asset.assetType);
    const price = prices[symbol] || 1;
    total += amount * price;
  }
  return total;
}

// ---------------------------------------------------------------------------
// PnL calculation
// ---------------------------------------------------------------------------

/** Extract traded asset symbol from position description ("LONG 10 ETH" → "ETH"). */
export function extractAssetSymbol(description: string): string | null {
  const parts = description.trim().split(/\s+/);
  const symbol = parts[parts.length - 1];
  return symbol && COINGECKO_IDS[symbol] ? symbol : null;
}

/** Calculate unrealized PnL for a single position. */
export function calculatePnL(
  direction: string | null,
  entryPrice: number,
  units: number,
  currentPrice: number,
): number {
  if (!entryPrice || !units || !currentPrice) return 0;
  return direction === 'Short'
    ? units * (entryPrice - currentPrice)
    : units * (currentPrice - entryPrice);
}

// ---------------------------------------------------------------------------
// LTV computation (aggregate per vault, leverage-aware)
// ---------------------------------------------------------------------------

/**
 * Compute LTV for all positions.
 *
 * LTV formula (per vault, shared across positions):
 *   effectiveCollateral = vaultValue + sum(PnL of all positions on vault)
 *   LTV = totalNotional / (effectiveCollateral * leverageRatio)
 *
 * A position is "breached" when LTV >= the BrokerFundLink threshold.
 */
export function computeLTVs(
  positions: PositionData[],
  vaults: Record<string, VaultData>,
  links: Record<string, BrokerFundLinkData>,
  prices: Record<string, number>,
): LTVResult[] {
  // Per-position PnL
  const positionPnLs: Record<string, number> = {};
  for (const pos of positions) {
    const entryPrice = parseFloat(pos.entryPrice || '0') || 0;
    const units = parseFloat(pos.units || '0') || 0;
    const assetSymbol = extractAssetSymbol(pos.description);
    const currentPrice = assetSymbol ? (prices[assetSymbol] || 0) : 0;
    positionPnLs[pos.contractId] = calculatePnL(pos.direction, entryPrice, units, currentPrice);
  }

  // Aggregate notional + PnL per vault
  const vaultAggregates: Record<string, { totalNotional: number; totalPnL: number }> = {};
  for (const pos of positions) {
    const vid = pos.vaultId;
    if (!vaultAggregates[vid]) vaultAggregates[vid] = { totalNotional: 0, totalPnL: 0 };
    vaultAggregates[vid].totalNotional += parseFloat(pos.notionalValue) || 0;
    vaultAggregates[vid].totalPnL += positionPnLs[pos.contractId] || 0;
  }

  return positions.map((pos) => {
    const vault = vaults[pos.vaultId];
    const notional = parseFloat(pos.notionalValue) || 0;
    const collateralValue = vault
      ? calculateVaultValue(vault.collateralAssets, prices)
      : 0;

    const pnl = positionPnLs[pos.contractId] || 0;
    const agg = vaultAggregates[pos.vaultId];
    const effectiveCollateral = collateralValue + (agg?.totalPnL || 0);
    const totalNotional = agg?.totalNotional || notional;

    // Resolve threshold + leverage from BrokerFundLink
    const linkKey = `${pos.broker}|${pos.fund}`;
    const link = links[linkKey];
    const threshold = link ? (parseFloat(link.ltvThreshold) || 0.8) : 0.8;
    const leverageRatio = link?.leverageRatio != null
      ? (parseFloat(link.leverageRatio) || 1)
      : 1;

    const ltv = effectiveCollateral > 0
      ? totalNotional / (effectiveCollateral * leverageRatio)
      : (totalNotional > 0 ? 999 : 0);

    return {
      positionId: pos.positionId,
      vaultId: pos.vaultId,
      fund: pos.fund,
      broker: pos.broker,
      notional,
      collateralValue,
      pnl,
      currentLTV: ltv === Infinity ? 999 : ltv,
      threshold,
      breached: ltv >= threshold,
      status: pos.status,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers for EVM contract encoding
// ---------------------------------------------------------------------------

/** Convert a decimal (e.g. 0.85) to basis points (8500). */
export function toBps(value: number): number {
  return Math.round(value * 10000);
}

/** Convert USD amount to 18-decimal fixed point for Solidity uint256. */
export function toUsd18(value: number): bigint {
  // Truncate to 6 decimal places to avoid floating point noise
  const truncated = Math.round(value * 1e6) / 1e6;
  return BigInt(Math.round(truncated * 1e18));
}
