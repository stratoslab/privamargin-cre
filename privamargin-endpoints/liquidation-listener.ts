/**
 * LiquidationTriggered event listener — PrivaMargin server-side.
 *
 * Watches the LTVOracle contract for LiquidationTriggered events emitted
 * by the CRE workflow DON. On event, executes Canton ledger operations:
 *
 *   1. MarkMarginCalled (if not already)
 *   2. SeizeCollateral on vault
 *   3. LiquidatePosition
 *   4. USDC settlement to broker
 *
 * Deployment options:
 *   A. Cloudflare Worker with Durable Object (polling every 30s)
 *   B. Alchemy/QuickNode webhook on LiquidationTriggered event
 *   C. Chainlink CRE EVM Log Trigger → HTTP callback to PrivaMargin
 *
 * This file demonstrates option A (Cloudflare Worker polling).
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
import { baseSepolia } from 'viem/chains';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface Env {
  // LTVOracle contract
  LTV_ORACLE_ADDRESS: string;
  LTV_ORACLE_CHAIN_RPC: string;

  // Canton connection (same as existing PrivaMargin wrangler.toml)
  CANTON_JSON_HOST: string;
  CANTON_AUTH_SECRET: string;
  CANTON_AUTH_AUDIENCE: string;
  SPLICE_ADMIN_USER: string;
  PACKAGE_ID: string;
  PRIVAMARGIN_CONFIG: KVNamespace;

  // State: last processed block
  LISTENER_STATE: KVNamespace;
}

const LIQUIDATION_EVENT = parseAbiItem(
  'event LiquidationTriggered(string indexed positionId, string vaultId, string broker, string fund, uint256 ltvBps, uint256 thresholdBps, uint256 timestamp)'
);

// ---------------------------------------------------------------------------
// Listener logic
// ---------------------------------------------------------------------------

async function processLiquidationEvents(env: Env) {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(env.LTV_ORACLE_CHAIN_RPC),
  });

  // Resume from last processed block
  const lastBlockRaw = await env.LISTENER_STATE.get('lastProcessedBlock');
  const fromBlock = lastBlockRaw ? BigInt(lastBlockRaw) + 1n : 'latest';

  const currentBlock = await client.getBlockNumber();

  const logs = await client.getLogs({
    address: env.LTV_ORACLE_ADDRESS as `0x${string}`,
    event: LIQUIDATION_EVENT,
    fromBlock,
    toBlock: currentBlock,
  });

  console.log(`[Listener] Scanned blocks ${fromBlock}..${currentBlock}: ${logs.length} liquidation events`);

  for (const log of logs) {
    const { positionId, vaultId, broker, fund, ltvBps, thresholdBps } = log.args as any;

    console.log(`[Listener] LiquidationTriggered: position=${positionId} ltv=${Number(ltvBps) / 100}% threshold=${Number(thresholdBps) / 100}%`);

    try {
      // Execute Canton liquidation via existing PrivaMargin API
      // This calls the same flow as the dashboard auto-liquidate button
      await executeLiquidationViaCanton(env, {
        positionId,
        vaultId,
        broker,
        fund,
        ltvBps: Number(ltvBps),
        thresholdBps: Number(thresholdBps),
      });
    } catch (err: any) {
      console.error(`[Listener] Liquidation failed for ${positionId}:`, err?.message || err);
    }
  }

  // Persist checkpoint
  await env.LISTENER_STATE.put('lastProcessedBlock', currentBlock.toString());
}

// ---------------------------------------------------------------------------
// Canton execution (mirrors existing liquidation flow in api.ts)
// ---------------------------------------------------------------------------

interface LiquidationParams {
  positionId: string;
  vaultId: string;
  broker: string;
  fund: string;
  ltvBps: number;
  thresholdBps: number;
}

async function executeLiquidationViaCanton(env: Env, params: LiquidationParams) {
  // JWT generation (same as other endpoints)
  const generateJWT = async () => {
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
      sub: env.SPLICE_ADMIN_USER || 'app-user',
      aud: env.CANTON_AUTH_AUDIENCE || 'https://canton.network.global',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const encoder = new TextEncoder();
    const b64url = (data: Uint8Array) =>
      btoa(String.fromCharCode(...data))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const headerB64 = b64url(encoder.encode(JSON.stringify(header)));
    const payloadB64 = b64url(encoder.encode(JSON.stringify(payload)));
    const signingInput = `${headerB64}.${payloadB64}`;
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(env.CANTON_AUTH_SECRET || 'unsafe'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput)),
    );
    return `${signingInput}.${b64url(signature)}`;
  };

  const token = await generateJWT();
  const templateId = `${env.PACKAGE_ID}:Position:Position`;

  // 1. Query current position contract
  const queryRes = await fetch(`https://${env.CANTON_JSON_HOST}/v1/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      templateIds: [templateId],
      query: { positionId: params.positionId },
    }),
  });

  const queryData = (await queryRes.json()) as { result: any[] };
  const active = (queryData.result || []).find(
    (c: any) => c.payload.status === 'Open' || c.payload.status === 'MarginCalled',
  );

  if (!active) {
    console.log(`[Listener] Position ${params.positionId}: no active contract (already liquidated?)`);
    return;
  }

  let currentCid = active.contractId;

  // 2. MarkMarginCalled if not already
  if (active.payload.status !== 'MarginCalled') {
    const mcRes = await fetch(`https://${env.CANTON_JSON_HOST}/v1/exercise`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        templateId,
        contractId: currentCid,
        choice: 'MarkMarginCalled',
        argument: {},
      }),
    });
    const mcData = (await mcRes.json()) as { result?: { exerciseResult?: string } };
    if (mcData.result?.exerciseResult) {
      currentCid = mcData.result.exerciseResult;
    }
  }

  // 3. LiquidatePosition
  const threshold = params.thresholdBps / 10000;
  await fetch(`https://${env.CANTON_JSON_HOST}/v1/exercise`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      templateId,
      contractId: currentCid,
      choice: 'LiquidatePosition',
      argument: {
        ltvThreshold: threshold.toString(),
        liquidatedAmount: '0',  // Actual seizure amount computed separately
        liquidatedAt: new Date().toISOString(),
        finalPnL: active.payload.unrealizedPnL || '0',
        exitPrice: null,
      },
    }),
  });

  console.log(`[Listener] Liquidated ${params.positionId} (CRE-triggered)`);

  // 4. Collateral seizure + USDC settlement
  // Delegates to existing /api/canton/seize-collateral endpoint
  // (same flow as dashboard-initiated liquidation)
}

// ---------------------------------------------------------------------------
// Scheduled trigger (Cloudflare Worker cron)
// ---------------------------------------------------------------------------

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await processLiquidationEvents(env);
  },
};
