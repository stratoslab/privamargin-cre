/**
 * PrivaMargin LTV Monitor — Chainlink CRE Workflow
 *
 * Decentralized, consensus-backed LTV monitoring for Canton margin positions.
 *
 * Architecture:
 *   CRE (decentralized DON):
 *     1. Cron trigger → fetch live prices from CoinGecko (median consensus)
 *     2. Fetch position + vault + link data from PrivaMargin API
 *     3. Compute per-vault LTV (leverage-aware, PnL-adjusted)
 *     4. POST full LTV results back to PrivaMargin API
 *
 *   PrivaMargin server (single-execution):
 *     - Receives consensus-backed LTV results from CRE
 *     - Writes tamper-proof attestations to Canton (private to parties)
 *     - If LTV >= threshold → executes Canton operations:
 *       MarkMarginCalled, SeizeCollateral, LiquidatePosition, USDC settlement
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
} from '@chainlink/cre-sdk';
import type { WorkflowConfig, PositionData, VaultData, BrokerFundLinkData, LTVResult } from './config';
import { COINGECKO_IDS } from './config';
import { parsePrices, computeLTVs } from './ltv';

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
  // Step 4: Post LTV results to PrivaMargin API
  // ------------------------------------------------------------------
  // PrivaMargin writes attestations to Canton (tamper-proof + private).
  // Breached positions trigger Canton liquidation operations directly.

  for (const result of breached) {
    runtime.log(`Liquidation: ${result.positionId} LTV=${(result.currentLTV * 100).toFixed(1)}%`);
  }

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
  ltvResults: LTVResult[],
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
            fund: r.fund,
            broker: r.broker,
            notional: r.notional,
            collateralValue: r.collateralValue,
            pnl: r.pnl,
            currentLTV: r.currentLTV,
            threshold: r.threshold,
            breached: r.breached,
            status: r.status,
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
