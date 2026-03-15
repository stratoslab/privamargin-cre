/**
 * PrivaMargin LTV Monitor — Chainlink CRE Workflow
 *
 * Decentralized, consensus-backed LTV monitoring for Canton margin positions.
 *
 * Architecture (hybrid model):
 *   CRE (decentralized DON):
 *     1. Cron trigger → fetch live prices from CoinGecko (median consensus)
 *     2. Fetch position + vault + link data from PrivaMargin API
 *     3. Compute per-vault LTV (leverage-aware, PnL-adjusted)
 *     4. Write LTV attestations to LTVOracle EVM contract via report
 *     5. If LTV >= threshold → emit LiquidationTriggered event
 *
 *   PrivaMargin server (single-execution):
 *     - Watches LiquidationTriggered events on LTVOracle
 *     - Executes Canton operations: MarkMarginCalled, SeizeCollateral,
 *       LiquidatePosition, USDC settlement
 *
 * Runtime: TypeScript → WASM via Javy (QuickJS engine)
 * Constraints: No node:crypto, no async/await with SDK calls,
 *              use runtime.now() instead of Date.now(),
 *              use .result() blocking pattern for capabilities.
 */

import {
  cre,
  Runner,
  type Runtime,
  ok,
  text,
  getNetwork,
  prepareReportRequest,
  hexToBase64,
} from '@chainlink/cre-sdk';
import { encodeFunctionData, type Address } from 'viem';
import type { WorkflowConfig, PositionData, VaultData, BrokerFundLinkData } from './config';
import { COINGECKO_IDS, LTV_ORACLE_ABI } from './config';
import { parsePrices, computeLTVs, toBps, toUsd18 } from './ltv';

// ---------------------------------------------------------------------------
// Helper: build multiHeaders for ConfidentialHTTP requests
// ---------------------------------------------------------------------------

function makeHeaders(headers: Record<string, string>) {
  const multi: Record<string, { values: string[] }> = {};
  for (const [key, value] of Object.entries(headers)) {
    multi[key] = { values: [value] };
  }
  return multi;
}

const API_HEADERS = {
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// CRE workflow handler
// ---------------------------------------------------------------------------

const onCronTrigger = (runtime: Runtime<WorkflowConfig>): string => {
  const config = runtime.config;
  const now = runtime.now();
  const timestamp = BigInt(Math.floor(now.getTime() / 1000));

  // ------------------------------------------------------------------
  // Step 1: Fetch live prices via CoinGecko (DON mode — public API)
  // ------------------------------------------------------------------

  const httpClient = new cre.capabilities.HTTPClient();
  const geckoIds = Object.values(COINGECKO_IDS).join(',');
  const priceUrl = `${config.coingeckoApiUrl}/simple/price?ids=${geckoIds}&vs_currencies=usd`;

  let prices: Record<string, number>;
  try {
    // Public API — use regular HTTPClient (no secrets needed)
    const priceResponse = httpClient.sendRequest(
      runtime as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      { url: priceUrl, method: 'GET', headers: { Accept: 'application/json' } },
    ).result();

    if (ok(priceResponse)) {
      const geckoData = JSON.parse(text(priceResponse)) as Record<string, { usd?: number }>;
      prices = parsePrices(geckoData);
    } else {
      prices = parsePrices({});
      runtime.log('CoinGecko fetch failed, using fallback prices');
    }
  } catch {
    prices = parsePrices({});
    runtime.log('CoinGecko fetch exception, using fallback prices');
  }

  runtime.log(`Prices: CC=$${prices['CC']} ETH=$${prices['ETH']} BTC=$${prices['BTC']}`);

  // ------------------------------------------------------------------
  // Step 2: Fetch position + vault + link data from PrivaMargin API
  // ------------------------------------------------------------------
  // Use ConfidentialHTTPClient to keep apiSecret secure in DON enclave.

  const confidentialHttp = new cre.capabilities.ConfidentialHTTPClient();
  const authHeaders = makeHeaders({
    ...API_HEADERS,
    'X-API-Secret': config.apiSecret,
  });

  // 2a: Open + MarginCalled positions
  let positions: PositionData[];
  try {
    const posResponse = confidentialHttp.sendRequest(runtime, {
      request: {
        url: `${config.privamarginApiUrl}/api/cre/positions`,
        method: 'GET',
        multiHeaders: authHeaders,
      },
    }).result();

    if (!ok(posResponse)) {
      runtime.log('Positions fetch failed');
      return 'ERROR: positions fetch failed';
    }
    const posData = JSON.parse(text(posResponse)) as { positions: PositionData[] };
    positions = posData.positions;
  } catch {
    runtime.log('Positions fetch exception');
    return 'ERROR: positions fetch failed';
  }

  if (positions.length === 0) {
    runtime.log('No open positions to monitor');
    notifyCycleComplete(confidentialHttp, runtime, config, now, [], prices, authHeaders);
    return 'OK: 0 positions';
  }

  // 2b: Vaults for unique vaultIds
  const uniqueVaultIds = [...new Set(positions.map(p => p.vaultId))];
  const vaultMap: Record<string, VaultData> = {};

  for (const vaultId of uniqueVaultIds) {
    try {
      const vaultResponse = confidentialHttp.sendRequest(runtime, {
        request: {
          url: `${config.privamarginApiUrl}/api/cre/vaults?vaultId=${vaultId}`,
          method: 'GET',
          multiHeaders: authHeaders,
        },
      }).result();

      if (ok(vaultResponse)) {
        const vaultData = JSON.parse(text(vaultResponse)) as { vault: VaultData | null };
        if (vaultData.vault) {
          vaultMap[vaultId] = vaultData.vault;
        }
      }
    } catch {
      runtime.log(`Vault ${vaultId} fetch failed`);
    }
  }

  // 2c: BrokerFundLink thresholds + leverage
  const linkMap: Record<string, BrokerFundLinkData> = {};
  const brokerFundPairs = [...new Set(positions.map(p => `${p.broker}|${p.fund}`))];

  for (const pair of brokerFundPairs) {
    try {
      const [broker, fund] = pair.split('|');
      const linkResponse = confidentialHttp.sendRequest(runtime, {
        request: {
          url: `${config.privamarginApiUrl}/api/cre/links?broker=${encodeURIComponent(broker)}&fund=${encodeURIComponent(fund)}`,
          method: 'GET',
          multiHeaders: authHeaders,
        },
      }).result();

      if (ok(linkResponse)) {
        const linkData = JSON.parse(text(linkResponse)) as { link: BrokerFundLinkData | null };
        if (linkData.link) {
          linkMap[pair] = linkData.link;
        }
      }
    } catch {
      runtime.log(`Link ${pair} fetch failed`);
    }
  }

  runtime.log(`Data: ${positions.length} positions, ${Object.keys(vaultMap).length} vaults, ${Object.keys(linkMap).length} links`);

  // ------------------------------------------------------------------
  // Step 3: Compute LTV for all positions
  // ------------------------------------------------------------------

  const ltvResults = computeLTVs(positions, vaultMap, linkMap, prices);

  const breached = ltvResults.filter(r => r.breached);
  const healthy = ltvResults.filter(r => !r.breached);

  runtime.log(`LTV: ${healthy.length} healthy, ${breached.length} breached`);

  // ------------------------------------------------------------------
  // Step 4: Write LTV attestations to LTVOracle EVM contract
  // ------------------------------------------------------------------
  // Every position gets an on-chain attestation via report + writeReport.
  // The CRE KeystoneForwarder delivers the report to the contract.

  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });
  if (!network) {
    runtime.log(`Network not found: ${config.chainSelectorName}`);
    return 'ERROR: network not found';
  }

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const oracleAddress = config.oracleContractAddress as Address;

  for (const result of ltvResults) {
    try {
      const callData = encodeFunctionData({
        abi: LTV_ORACLE_ABI,
        functionName: 'attestLTV',
        args: [
          result.positionId,
          result.vaultId,
          BigInt(toBps(result.currentLTV)),
          toUsd18(result.collateralValue),
          toUsd18(result.notional),
          toUsd18(result.pnl),
          timestamp,
        ],
      });

      const report = runtime.report(prepareReportRequest(callData)).result();
      evmClient.writeReport(runtime, {
        receiver: hexToBase64(oracleAddress),
        report,
      }).result();
    } catch {
      runtime.log(`attestLTV failed: ${result.positionId}`);
    }
  }

  // ------------------------------------------------------------------
  // Step 5: Trigger liquidation for breached positions
  // ------------------------------------------------------------------
  // LTVOracle emits LiquidationTriggered — PrivaMargin listener picks
  // this up and executes Canton operations (single execution, not N).

  for (const result of breached) {
    try {
      const callData = encodeFunctionData({
        abi: LTV_ORACLE_ABI,
        functionName: 'triggerLiquidation',
        args: [
          result.positionId,
          result.vaultId,
          result.broker,
          result.fund,
          BigInt(toBps(result.currentLTV)),
          BigInt(toBps(result.threshold)),
          timestamp,
        ],
      });

      const report = runtime.report(prepareReportRequest(callData)).result();
      evmClient.writeReport(runtime, {
        receiver: hexToBase64(oracleAddress),
        report,
      }).result();

      runtime.log(`Liquidation: ${result.positionId} LTV=${(result.currentLTV * 100).toFixed(1)}%`);
    } catch {
      runtime.log(`triggerLiquidation failed: ${result.positionId}`);
    }
  }

  // ------------------------------------------------------------------
  // Step 6: Notify PrivaMargin API of completed cycle
  // ------------------------------------------------------------------

  notifyCycleComplete(confidentialHttp, runtime, config, now, ltvResults, prices, authHeaders);

  return `OK: ${positions.length} positions, ${breached.length} liquidations`;
};

// ---------------------------------------------------------------------------
// Helper: POST cycle-complete to PrivaMargin
// ---------------------------------------------------------------------------

type ConfidentialHTTPClientType = InstanceType<typeof cre.capabilities.ConfidentialHTTPClient>;
type HeadersMap = Record<string, { values: string[] }>;

function notifyCycleComplete(
  httpClient: ConfidentialHTTPClientType,
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  now: Date,
  ltvResults: Array<{ positionId: string; vaultId: string; currentLTV: number; breached: boolean }>,
  prices: Record<string, number>,
  authHeaders: HeadersMap,
): void {
  try {
    httpClient.sendRequest(runtime, {
      request: {
        url: `${config.privamarginApiUrl}/api/cre/cycle-complete`,
        method: 'POST',
        multiHeaders: authHeaders,
        bodyString: JSON.stringify({
          timestamp: now.toISOString(),
          processed: ltvResults.length,
          breached: ltvResults.filter(r => r.breached).length,
          healthy: ltvResults.filter(r => !r.breached).length,
          prices: {
            CC: prices['CC'] || 0,
            ETH: prices['ETH'] || 0,
            BTC: prices['BTC'] || 0,
            USDC: prices['USDC'] || 0,
            SOL: prices['SOL'] || 0,
          },
          results: ltvResults.map(r => ({
            positionId: r.positionId,
            vaultId: r.vaultId,
            currentLTV: r.currentLTV,
            breached: r.breached,
          })),
        }),
      },
    }).result();
  } catch {
    runtime.log('cycle-complete notification failed (non-fatal)');
  }
}

// ---------------------------------------------------------------------------
// Workflow registration via Runner + cre.handler
// ---------------------------------------------------------------------------

const cronTrigger = new cre.capabilities.CronCapability().trigger({
  schedule: '0 */5 * * * *', // Every 5 minutes
});

const workflow = [cre.handler(cronTrigger, onCronTrigger)];

export async function main() {
  const runner = await Runner.newRunner<WorkflowConfig>();
  await runner.run(() => workflow);
}

main();
