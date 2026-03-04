/**
 * PrivaMargin LTV Monitor - Chainlink CRE Workflow
 *
 * Decentralized, consensus-backed LTV monitoring for margin positions.
 */

import {
  CronCapability,
  handler,
  Runner,
  type Runtime,
} from "@chainlink/cre-sdk";
import type { PositionData, VaultData, BrokerFundLinkData } from "./config";
import { FALLBACK_PRICES } from "./config";
import { computeLTVs, toBps } from "./ltv";

export type Config = {
  schedule: string;
  chainSelector: string;
  oracleContractAddress: string;
};

// =============================================================================
// Mock Data
// =============================================================================

const MOCK_PRICES: Record<string, number> = {
  CC: 0.158,
  ETH: 3500,
  BTC: 95000,
  USDC: 1.0,
  USDT: 1.0,
  SOL: 180,
};

const MOCK_POSITIONS: PositionData[] = [
  {
    contractId: "contract-001",
    positionId: "pos-001",
    fund: "AlphaFund",
    broker: "BrokerX",
    operator: "operator-1",
    vaultId: "vault-001",
    description: "LONG 10 ETH",
    notionalValue: "35000",
    currentLTV: "0.70",
    status: "Open",
    direction: "Long",
    entryPrice: "3200",
    units: "10",
    unrealizedPnL: "3000",
  },
  {
    contractId: "contract-002",
    positionId: "pos-002",
    fund: "AlphaFund",
    broker: "BrokerX",
    operator: "operator-1",
    vaultId: "vault-002",
    description: "SHORT 5 ETH",
    notionalValue: "17500",
    currentLTV: "0.85",
    status: "Open",
    direction: "Short",
    entryPrice: "3600",
    units: "5",
    unrealizedPnL: "500",
  },
  {
    contractId: "contract-003",
    positionId: "pos-003",
    fund: "BetaFund",
    broker: "BrokerY",
    operator: "operator-2",
    vaultId: "vault-003",
    description: "LONG 1 BTC",
    notionalValue: "95000",
    currentLTV: "0.60",
    status: "Open",
    direction: "Long",
    entryPrice: "90000",
    units: "1",
    unrealizedPnL: "5000",
  },
];

const MOCK_VAULTS: Record<string, VaultData> = {
  "vault-001": {
    contractId: "vault-contract-001",
    vaultId: "vault-001",
    owner: "AlphaFund",
    operator: "operator-1",
    collateralAssets: [
      { assetId: "ETH-1234567890", assetType: "Cryptocurrency", amount: "15", valueUSD: "52500" },
      { assetId: "USDC-9876543210", assetType: "Stablecoin", amount: "10000", valueUSD: "10000" },
    ],
    linkedPositions: ["pos-001"],
  },
  "vault-002": {
    contractId: "vault-contract-002",
    vaultId: "vault-002",
    owner: "AlphaFund",
    operator: "operator-1",
    collateralAssets: [
      { assetId: "CC-1111111111", assetType: "CantonCoin", amount: "100000", valueUSD: "15800" },
    ],
    linkedPositions: ["pos-002"],
  },
  "vault-003": {
    contractId: "vault-contract-003",
    vaultId: "vault-003",
    owner: "BetaFund",
    operator: "operator-2",
    collateralAssets: [
      { assetId: "BTC-2222222222", assetType: "Cryptocurrency", amount: "2", valueUSD: "190000" },
    ],
    linkedPositions: ["pos-003"],
  },
};

const MOCK_LINKS: Record<string, BrokerFundLinkData> = {
  "BrokerX|AlphaFund": {
    broker: "BrokerX",
    fund: "AlphaFund",
    ltvThreshold: "0.80",
    leverageRatio: "5",
  },
  "BrokerY|BetaFund": {
    broker: "BrokerY",
    fund: "BetaFund",
    ltvThreshold: "0.75",
    leverageRatio: "3",
  },
};

// =============================================================================
// Workflow Handler
// =============================================================================

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  runtime.log("LTV Monitor cycle starting...");

  // Use mock data
  const prices = { ...FALLBACK_PRICES, ...MOCK_PRICES };
  const positions = MOCK_POSITIONS;
  const vaultMap = MOCK_VAULTS;
  const linkMap = MOCK_LINKS;

  runtime.log("Prices: CC=" + prices["CC"] + " ETH=" + prices["ETH"] + " BTC=" + prices["BTC"]);
  runtime.log("Positions loaded: " + positions.length);

  // Compute LTV
  const ltvResults = computeLTVs(positions, vaultMap, linkMap, prices);
  const breached = ltvResults.filter((r) => r.breached);
  const healthy = ltvResults.filter((r) => !r.breached);

  runtime.log("LTV Results:");
  for (const r of ltvResults) {
    const status = r.breached ? "BREACHED" : "healthy";
    runtime.log(
      "  " + r.positionId + ": LTV=" + (r.currentLTV * 100).toFixed(2) + "% threshold=" + (r.threshold * 100).toFixed(0) + "% [" + status + "]"
    );
  }

  runtime.log("Summary: " + healthy.length + " healthy, " + breached.length + " breached");

  if (breached.length > 0) {
    runtime.log("Liquidation required for: " + breached.map((b) => b.positionId).join(", "));
  }

  return "OK: " + positions.length + " positions, " + breached.length + " liquidations";
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();

  return [
    handler(cron.trigger({ schedule: config.schedule }), onCronTrigger),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
