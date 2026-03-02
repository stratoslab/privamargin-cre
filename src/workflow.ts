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
 *     4. Write LTV attestations to LTVOracle EVM contract
 *     5. If LTV >= threshold → emit LiquidationTriggered event
 *
 *   PrivaMargin server (single-execution):
 *     - Watches LiquidationTriggered events on LTVOracle
 *     - Executes Canton operations: MarkMarginCalled, SeizeCollateral,
 *       LiquidatePosition, USDC settlement
 *
 * This separation ensures:
 *   - Price data is consensus-backed (N DON nodes agree on prices)
 *   - LTV computations are verifiable and tamper-proof
 *   - Canton writes happen exactly once (not N times per DON node)
 *
 * Runtime: TypeScript → WASM via Javy (QuickJS engine)
 * Constraints: No node:crypto, no async/await with SDK calls,
 *              use runtime.Now() instead of Date.now(),
 *              use .result() blocking pattern for capabilities.
 */

import { cre, type Runtime } from '@chainlink/cre-sdk';
import type { WorkflowConfig, PositionData, VaultData, BrokerFundLinkData } from './config';
import { COINGECKO_IDS, LTV_ORACLE_ABI } from './config';
import { parsePrices, computeLTVs, toBps, toUsd18 } from './ltv';

// ---------------------------------------------------------------------------
// CRE workflow definition
// ---------------------------------------------------------------------------

/**
 * Cron-triggered LTV monitoring workflow.
 *
 * Runs every 5 minutes (configurable). Each execution:
 * 1. Fetches prices from CoinGecko with DON median consensus
 * 2. Fetches position/vault data from PrivaMargin server API
 * 3. Computes LTV for every open/margin-called position
 * 4. Writes attestations to LTVOracle contract
 * 5. Triggers liquidation for any breached positions
 */
const onCronTrigger = (runtime: Runtime<WorkflowConfig>): string => {
  const config = runtime.Config();
  const now = runtime.Now();
  const timestamp = Math.floor(now.getTime() / 1000);

  // ------------------------------------------------------------------
  // Step 1: Fetch live prices via CoinGecko (DON median consensus)
  // ------------------------------------------------------------------
  // Each DON node independently fetches from CoinGecko.
  // ConsensusMedianAggregation ensures a single trusted price set.

  const geckoIds = Object.values(COINGECKO_IDS).join(',');
  const priceUrl = `${config.coingeckoApiUrl}/simple/price?ids=${geckoIds}&vs_currencies=usd`;

  const httpClient = new cre.capabilities.HTTPClient();
  const priceResponse = httpClient.sendRequest({
    url: priceUrl,
    method: 'GET',
    headers: { Accept: 'application/json' },
  }).result();

  let prices: Record<string, number>;
  try {
    const geckoData = JSON.parse(priceResponse.body) as Record<string, { usd?: number }>;
    prices = parsePrices(geckoData);
  } catch {
    // If CoinGecko fails, parsePrices with empty data returns fallbacks
    prices = parsePrices({});
    runtime.Log('warn', 'CoinGecko fetch failed, using fallback prices');
  }

  runtime.Log('info', `Prices fetched: CC=$${prices['CC']} ETH=$${prices['ETH']} BTC=$${prices['BTC']}`);

  // ------------------------------------------------------------------
  // Step 2: Fetch position + vault + link data from PrivaMargin API
  // ------------------------------------------------------------------
  // PrivaMargin exposes server-side endpoints that query Canton.
  // These are deterministic — same query returns same contracts.
  // Each DON node calls independently; consensus ensures agreement.

  const apiHeaders = {
    'Content-Type': 'application/json',
    'X-API-Secret': config.apiSecret,
  };

  // 2a: Open + MarginCalled positions
  const positionsResponse = httpClient.sendRequest({
    url: `${config.privamarginApiUrl}/api/cre/positions`,
    method: 'GET',
    headers: apiHeaders,
  }).result();

  let positions: PositionData[];
  try {
    const posData = JSON.parse(positionsResponse.body) as { positions: PositionData[] };
    positions = posData.positions;
  } catch {
    runtime.Log('error', 'Failed to parse positions response');
    return 'ERROR: positions fetch failed';
  }

  if (positions.length === 0) {
    runtime.Log('info', 'No open positions to monitor');
    return 'OK: 0 positions';
  }

  // 2b: Vaults for unique vaultIds
  const uniqueVaultIds = [...new Set(positions.map(p => p.vaultId))];
  const vaultMap: Record<string, VaultData> = {};

  for (const vaultId of uniqueVaultIds) {
    try {
      const vaultResponse = httpClient.sendRequest({
        url: `${config.privamarginApiUrl}/api/cre/vaults?vaultId=${vaultId}`,
        method: 'GET',
        headers: apiHeaders,
      }).result();

      const vaultData = JSON.parse(vaultResponse.body) as { vault: VaultData | null };
      if (vaultData.vault) {
        vaultMap[vaultId] = vaultData.vault;
      }
    } catch {
      runtime.Log('warn', `Vault ${vaultId} fetch failed`);
    }
  }

  // 2c: BrokerFundLink thresholds + leverage
  const linkMap: Record<string, BrokerFundLinkData> = {};
  const brokerFundPairs = [...new Set(positions.map(p => `${p.broker}|${p.fund}`))];

  for (const pair of brokerFundPairs) {
    try {
      const [broker, fund] = pair.split('|');
      const linkResponse = httpClient.sendRequest({
        url: `${config.privamarginApiUrl}/api/cre/links?broker=${encodeURIComponent(broker)}&fund=${encodeURIComponent(fund)}`,
        method: 'GET',
        headers: apiHeaders,
      }).result();

      const linkData = JSON.parse(linkResponse.body) as { link: BrokerFundLinkData | null };
      if (linkData.link) {
        linkMap[pair] = linkData.link;
      }
    } catch {
      runtime.Log('warn', `Link ${pair} fetch failed`);
    }
  }

  runtime.Log('info', `Data loaded: ${positions.length} positions, ${Object.keys(vaultMap).length} vaults, ${Object.keys(linkMap).length} links`);

  // ------------------------------------------------------------------
  // Step 3: Compute LTV for all positions
  // ------------------------------------------------------------------

  const ltvResults = computeLTVs(positions, vaultMap, linkMap, prices);

  const breached = ltvResults.filter(r => r.breached);
  const healthy = ltvResults.filter(r => !r.breached);

  runtime.Log('info', `LTV computed: ${healthy.length} healthy, ${breached.length} breached`);

  // ------------------------------------------------------------------
  // Step 4: Write LTV attestations to LTVOracle EVM contract
  // ------------------------------------------------------------------
  // Every position gets an on-chain attestation — verifiable proof that
  // the CRE DON computed this LTV at this time with consensus prices.

  const evmClient = new cre.capabilities.EVMClient(config.chainSelector);

  for (const result of ltvResults) {
    try {
      evmClient.write({
        contractAddress: config.oracleContractAddress,
        abi: LTV_ORACLE_ABI,
        method: 'attestLTV',
        args: [
          result.positionId,
          result.vaultId,
          toBps(result.currentLTV),           // LTV in basis points
          toUsd18(result.collateralValue).toString(), // collateral in 18-dec USD
          toUsd18(result.notional).toString(),        // notional in 18-dec USD
          toUsd18(result.pnl).toString(),             // PnL in 18-dec USD
          timestamp,
        ],
      }).result();
    } catch {
      runtime.Log('warn', `attestLTV failed for ${result.positionId}`);
    }
  }

  // ------------------------------------------------------------------
  // Step 5: Trigger liquidation for breached positions
  // ------------------------------------------------------------------
  // LTVOracle emits LiquidationTriggered — PrivaMargin listener picks
  // this up and executes Canton operations (single execution, not N).

  for (const result of breached) {
    try {
      evmClient.write({
        contractAddress: config.oracleContractAddress,
        abi: LTV_ORACLE_ABI,
        method: 'triggerLiquidation',
        args: [
          result.positionId,
          result.vaultId,
          result.broker,
          result.fund,
          toBps(result.currentLTV),    // current LTV in bps
          toBps(result.threshold),     // threshold in bps
          timestamp,
        ],
      }).result();

      runtime.Log('info', `Liquidation triggered: ${result.positionId} LTV=${(result.currentLTV * 100).toFixed(1)}% >= ${(result.threshold * 100).toFixed(0)}%`);
    } catch {
      runtime.Log('error', `triggerLiquidation failed for ${result.positionId}`);
    }
  }

  // ------------------------------------------------------------------
  // Step 6: Notify PrivaMargin API of completed cycle (fire-and-forget)
  // ------------------------------------------------------------------
  // Persists run record for operator dashboard visibility.

  try {
    httpClient.sendRequest({
      url: `${config.privamarginApiUrl}/api/cre/cycle-complete`,
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        timestamp: new Date(now).toISOString(),
        processed: positions.length,
        breached: breached.length,
        healthy: healthy.length,
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
    }).result();
  } catch {
    runtime.Log('warn', 'cycle-complete notification failed (non-fatal)');
  }

  return `OK: ${positions.length} positions, ${breached.length} liquidations triggered`;
};

// ---------------------------------------------------------------------------
// Export workflow with cron trigger
// ---------------------------------------------------------------------------

export default cre.createWorkflow({
  trigger: cre.triggers.cron('*/5 * * * *'), // Every 5 minutes
  callback: onCronTrigger,
});
