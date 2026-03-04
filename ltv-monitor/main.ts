/**
 * PrivaMargin LTV Monitor - Chainlink CRE Workflow
 *
 * Decentralized, consensus-backed LTV monitoring for margin positions.
 */

import {
  CronCapability,
  HTTPClient,
  handler,
  Runner,
  type Runtime,
  type NodeRuntime,
} from "@chainlink/cre-sdk";
import type { PositionData, VaultData, BrokerFundLinkData, LTVResult } from "./config";
import { COINGECKO_IDS } from "./config";
import { parsePrices, computeLTVs, toBps } from "./ltv";

export type Config = {
  schedule: string;
  privamarginApiUrl: string;
  coingeckoApiUrl: string;
  chainSelector: string;
  oracleContractAddress: string;
  apiSecret?: string;
  proverServiceUrl?: string;
};

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const config = runtime.config;
  const nodeRuntime = runtime as unknown as NodeRuntime<Config>;

  runtime.log("LTV Monitor cycle starting...");

  // Step 1: Fetch live prices via CoinGecko
  const geckoIds = Object.values(COINGECKO_IDS).join(",");
  const priceUrl = config.coingeckoApiUrl + "/simple/price?ids=" + geckoIds + "&vs_currencies=usd";

  const http = new HTTPClient();
  const priceResponse = http
    .sendRequest(nodeRuntime, {
      url: priceUrl,
      method: "GET",
      headers: { Accept: "application/json" },
    })
    .result();

  let prices: Record<string, number>;
  try {
    const geckoData = JSON.parse(priceResponse.body) as Record<string, { usd?: number }>;
    prices = parsePrices(geckoData);
  } catch {
    prices = parsePrices({});
    runtime.log("CoinGecko fetch failed, using fallback prices");
  }

  runtime.log("Prices fetched: CC=" + prices["CC"] + " ETH=" + prices["ETH"] + " BTC=" + prices["BTC"]);

  // Step 2: Fetch positions from PrivaMargin API
  const apiHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiSecret) {
    apiHeaders["X-API-Secret"] = config.apiSecret;
  }

  const positionsResponse = http
    .sendRequest(nodeRuntime, {
      url: config.privamarginApiUrl + "/api/cre/positions",
      method: "GET",
      headers: apiHeaders,
    })
    .result();

  let positions: PositionData[];
  try {
    const posData = JSON.parse(positionsResponse.body) as { positions: PositionData[] };
    positions = posData.positions;
  } catch {
    runtime.log("Failed to parse positions response");
    return "ERROR: positions fetch failed";
  }

  if (positions.length === 0) {
    runtime.log("No open positions to monitor");
    return "OK: 0 positions";
  }

  // Simplified: empty vault/link maps for initial test
  const vaultMap: Record<string, VaultData> = {};
  const linkMap: Record<string, BrokerFundLinkData> = {};

  runtime.log("Data loaded: " + positions.length + " positions");

  // Compute LTV
  const ltvResults = computeLTVs(positions, vaultMap, linkMap, prices);
  const breached = ltvResults.filter((r) => r.breached);
  const healthy = ltvResults.filter((r) => !r.breached);

  runtime.log("LTV computed: " + healthy.length + " healthy, " + breached.length + " breached");

  // Step 4: Generate ZK proofs for breached positions (if prover service configured)
  if (config.proverServiceUrl && breached.length > 0) {
    runtime.log("Generating ZK proofs for " + breached.length + " breached positions...");

    for (const result of breached) {
      const position = positions.find((p) => p.positionId === result.positionId);
      if (!position) continue;

      try {
        const proofRequest = {
          positions: [{
            positionId: position.positionId,
            notionalValue: position.notionalValue,
            unrealizedPnL: position.unrealizedPnL || "0",
            ltvThreshold: result.threshold.toString(),
            leverageRatio: "1",
            collateral: [
              { asset: "CC", amount: result.collateralValue.toString() }
            ]
          }],
          prices: prices,
          computedLtvBps: toBps(result.currentLTV),
          timestamp: Math.floor(Date.now() / 1000)
        };

        const proofResponse = http
          .sendRequest(nodeRuntime, {
            url: config.proverServiceUrl + "/api/prove-ltv",
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(proofRequest),
          })
          .result();

        if (proofResponse.status === 200) {
          runtime.log("Proof generated for position " + result.positionId);
        } else {
          runtime.log("Proof generation failed for " + result.positionId + ": " + proofResponse.body);
        }
      } catch {
        runtime.log("Prover service error for " + result.positionId);
      }
    }
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
