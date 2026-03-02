/**
 * Configuration and types for PrivaMargin CRE workflow.
 *
 * CRE workflows compile to WASM (QuickJS) — no node:crypto, no async/await
 * with SDK capabilities. All SDK calls use .result() blocking pattern.
 */

// ---------------------------------------------------------------------------
// Workflow configuration — injected via CRE secrets / env
// ---------------------------------------------------------------------------

export interface WorkflowConfig {
  /** PrivaMargin API base URL (Cloudflare Pages deployment) */
  privamarginApiUrl: string;

  /** API secret for authenticated PrivaMargin endpoints */
  apiSecret: string;

  /** EVM chain selector for LTVOracle contract writes */
  chainSelector: string;

  /** LTVOracle contract address on target EVM chain */
  oracleContractAddress: string;

  /** CoinGecko API base (default: https://api.coingecko.com/api/v3) */
  coingeckoApiUrl: string;
}

// ---------------------------------------------------------------------------
// Canton / Daml data types (mirrored from PrivaMargin)
// ---------------------------------------------------------------------------

export interface PositionData {
  contractId: string;
  positionId: string;
  fund: string;
  broker: string;
  operator: string;
  vaultId: string;
  description: string;
  notionalValue: string;
  currentLTV: string;
  status: 'Open' | 'MarginCalled' | 'Liquidated' | 'Closed';
  direction: 'Long' | 'Short' | null;
  entryPrice: string | null;
  units: string | null;
  unrealizedPnL: string | null;
}

export interface VaultAsset {
  assetId: string;
  assetType: string;
  amount: string;
  valueUSD: string;
}

export interface VaultData {
  contractId: string;
  vaultId: string;
  owner: string;
  operator: string;
  collateralAssets: VaultAsset[];
  linkedPositions: string[];
}

export interface BrokerFundLinkData {
  broker: string;
  fund: string;
  ltvThreshold: string;
  leverageRatio: string | null;
}

// ---------------------------------------------------------------------------
// LTV computation output
// ---------------------------------------------------------------------------

export interface LTVResult {
  positionId: string;
  vaultId: string;
  fund: string;
  broker: string;
  notional: number;
  collateralValue: number;
  pnl: number;
  currentLTV: number;
  threshold: number;
  breached: boolean;
  status: string;
}

// ---------------------------------------------------------------------------
// LTVOracle contract ABI (Solidity events + functions)
// ---------------------------------------------------------------------------

export const LTV_ORACLE_ABI = [
  // Write: record an LTV attestation (called every cycle for all positions)
  'function attestLTV(string positionId, string vaultId, uint256 ltvBps, uint256 collateralUsd18, uint256 notionalUsd18, uint256 pnlUsd18, uint256 timestamp)',

  // Write: emit a liquidation trigger (called when LTV >= threshold)
  'function triggerLiquidation(string positionId, string vaultId, string broker, string fund, uint256 ltvBps, uint256 thresholdBps, uint256 timestamp)',

  // Events (PrivaMargin listener watches these)
  'event LTVAttested(string indexed positionId, string vaultId, uint256 ltvBps, uint256 collateralUsd18, uint256 timestamp)',
  'event LiquidationTriggered(string indexed positionId, string vaultId, string broker, string fund, uint256 ltvBps, uint256 thresholdBps, uint256 timestamp)',
] as const;

// ---------------------------------------------------------------------------
// Price feed constants
// ---------------------------------------------------------------------------

export const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  CC: 'canton-network',
  USDC: 'usd-coin',
  USDT: 'tether',
  TRX: 'tron',
  TON: 'the-open-network',
};

export const FALLBACK_PRICES: Record<string, number> = {
  CC: 0.158,
  CUSD: 1.0,
  CUSDC: 1.0,
  USDC: 1.0,
  USDT: 1.0,
  BTC: 95000,
  ETH: 3500,
  SOL: 180,
  TRX: 0.25,
  TON: 5.50,
};
