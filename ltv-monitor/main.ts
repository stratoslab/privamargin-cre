/**
 * PrivaMargin LTV Monitor - Chainlink CRE Workflow
 *
 * Decentralized, consensus-backed LTV monitoring for margin positions.
 *
 * This workflow:
 * 1. Fetches LIVE prices from CoinGecko API (external data source)
 * 2. Computes LTV for margin positions
 * 3. Identifies positions that breach their liquidation threshold
 */

import {
  CronCapability,
  HTTPClient,
  ConfidentialHTTPClient,
  handler,
  Runner,
  type Runtime,
  type NodeRuntime,
} from "@chainlink/cre-sdk";
import type { PositionData, VaultData, BrokerFundLinkData } from "./config";
import { COINGECKO_IDS, FALLBACK_PRICES } from "./config";
import { parsePrices, computeLTVs } from "./ltv";

export type Config = {
  schedule: string;
  coingeckoApiUrl: string;
  chainSelector: string;
  oracleContractAddress: string;
};

// =============================================================================
// Mock Position Data (Canton Network would provide this in production)
// =============================================================================

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
  const config = runtime.config;
  const nodeRuntime = runtime as unknown as NodeRuntime<Config>;

  runtime.log("LTV Monitor cycle starting...");

  // =========================================================================
  // Step 1: Fetch LIVE prices from CoinGecko API (External Data Source)
  // =========================================================================
  const geckoIds = Object.values(COINGECKO_IDS).join(",");
  const priceUrl = config.coingeckoApiUrl + "/simple/price?ids=" + geckoIds + "&vs_currencies=usd";

  runtime.log("Fetching prices from CoinGecko: " + priceUrl);

  const http = new HTTPClient();
  let prices: Record<string, number>;

  try {
    const priceResponse = http
      .sendRequest(nodeRuntime, {
        url: priceUrl,
        method: "GET",
        headers: { Accept: "application/json" },
      })
      .result();

    runtime.log("CoinGecko response status: " + priceResponse.status);

    if (priceResponse.status === 200) {
      const geckoData = JSON.parse(priceResponse.body) as Record<string, { usd?: number }>;
      prices = parsePrices(geckoData);
      runtime.log("LIVE prices fetched successfully");
    } else {
      prices = { ...FALLBACK_PRICES };
      runtime.log("CoinGecko returned " + priceResponse.status + ", using fallback prices");
    }
  } catch (e) {
    prices = { ...FALLBACK_PRICES };
    runtime.log("CoinGecko fetch failed, using fallback prices");
  }

  runtime.log("Prices: ETH=$" + prices["ETH"] + " BTC=$" + prices["BTC"] + " SOL=$" + prices["SOL"]);

  // =========================================================================
  // Step 2: Load positions from Canton Network (via ConfidentialHTTPClient)
  // =========================================================================
  // ConfidentialHTTPClient keeps API secrets encrypted in secure enclave
  // and makes exactly 1 API call (not N duplicates across DON nodes)

  const confidentialHttp = new ConfidentialHTTPClient();
  let positions = MOCK_POSITIONS;
  let vaultMap = MOCK_VAULTS;
  let linkMap = MOCK_LINKS;

  // Fetch positions from Canton Network via PrivaMargin proxy
  // API: https://portal.stratoslab.xyz/api/proxy/query
  // Uses ConfidentialHTTPClient to keep API key encrypted
  try {
    runtime.log("Fetching positions from Canton Network...");
    const posResponse = confidentialHttp
      .sendRequest(nodeRuntime, {
        url: "https://portal.stratoslab.xyz/api/proxy/query",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "{{secrets.CANTON_API_KEY}}"  // Encrypted in CRE secrets
        },
        body: JSON.stringify({
          templateId: "Position",
          filter: {}
        }),
      })
      .result();

    runtime.log("Canton API response status: " + posResponse.status);

    if (posResponse.status === 200) {
      const data = JSON.parse(posResponse.body);
      if (data.positions && data.positions.length > 0) {
        positions = data.positions;
        runtime.log("Positions fetched from Canton: " + positions.length);
      } else {
        runtime.log("No positions from Canton, using mock data");
      }
    } else {
      runtime.log("Canton API returned " + posResponse.status + ", using mock data");
    }
  } catch (e) {
    runtime.log("Canton API error, using mock data");
  }

  runtime.log("Positions loaded: " + positions.length);

  // =========================================================================
  // Step 3: Compute LTV for each position
  // =========================================================================
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

  // =========================================================================
  // Step 4: Report liquidations (on-chain write in production)
  // =========================================================================
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
