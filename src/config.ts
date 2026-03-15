/**
 * Configuration and types for PrivaMargin CRE workflow.
 *
 * CRE workflows compile to WASM (QuickJS) — no node:crypto, no async/await
 * with SDK capabilities. All SDK calls use .result() blocking pattern.
 */

// ---------------------------------------------------------------------------
// Workflow configuration — loaded from config.json, secrets via CRE CLI
// ---------------------------------------------------------------------------

export interface WorkflowConfig {
  /** PrivaMargin API base URL (Cloudflare Worker deployment) */
  privamarginApiUrl: string;

  /** API secret for authenticated PrivaMargin endpoints */
  apiSecret: string;

  /** EVM chain selector name (e.g. 'ethereum-testnet-sepolia-base-1') */
  chainSelectorName: string;

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
// LTVOracle contract ABI (viem format for encodeFunctionData)
// ---------------------------------------------------------------------------

export const LTV_ORACLE_ABI = [
  {
    name: 'attestLTV',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'positionId', type: 'string' },
      { name: 'vaultId', type: 'string' },
      { name: 'ltvBps', type: 'uint256' },
      { name: 'collateralUsd18', type: 'uint256' },
      { name: 'notionalUsd18', type: 'uint256' },
      { name: 'pnlUsd18', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'triggerLiquidation',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'positionId', type: 'string' },
      { name: 'vaultId', type: 'string' },
      { name: 'broker', type: 'string' },
      { name: 'fund', type: 'string' },
      { name: 'ltvBps', type: 'uint256' },
      { name: 'thresholdBps', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'LTVAttested',
    type: 'event' as const,
    inputs: [
      { name: 'positionId', type: 'string', indexed: true },
      { name: 'vaultId', type: 'string', indexed: false },
      { name: 'ltvBps', type: 'uint256', indexed: false },
      { name: 'collateralUsd18', type: 'uint256', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'LiquidationTriggered',
    type: 'event' as const,
    inputs: [
      { name: 'positionId', type: 'string', indexed: true },
      { name: 'vaultId', type: 'string', indexed: false },
      { name: 'broker', type: 'string', indexed: false },
      { name: 'fund', type: 'string', indexed: false },
      { name: 'ltvBps', type: 'uint256', indexed: false },
      { name: 'thresholdBps', type: 'uint256', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
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
