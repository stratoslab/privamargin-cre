/**
 * GET /api/cre/positions — Server-side Canton query for CRE workflow.
 *
 * Returns all Open + MarginCalled positions from the Canton ledger.
 * Deployed as a Cloudflare Pages Function in stratos-privamargin.
 *
 * CRE DON nodes call this independently — the response is deterministic
 * (same Canton ledger state → same contract list) so consensus passes.
 *
 * Authentication: X-API-Secret header must match env.API_SECRET.
 */

interface Env {
  API_SECRET: string;
  CANTON_JSON_HOST: string;
  CANTON_AUTH_SECRET: string;
  CANTON_AUTH_AUDIENCE: string;
  SPLICE_ADMIN_USER: string;
  PACKAGE_ID: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Secret',
  'Content-Type': 'application/json',
};

async function generateJWT(env: Env): Promise<string> {
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
}

async function cantonQuery(env: Env, templateId: string, filter?: Record<string, unknown>) {
  const token = await generateJWT(env);
  const body: Record<string, unknown> = { templateIds: [templateId] };
  if (filter) body.query = filter;

  const res = await fetch(`https://${env.CANTON_JSON_HOST}/v1/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Canton query ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { result: unknown[] };
  return data.result || [];
}

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  // Verify API secret
  const secret = request.headers.get('X-API-Secret');
  if (!secret || secret !== env.API_SECRET) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: CORS_HEADERS },
    );
  }

  try {
    const templateId = `${env.PACKAGE_ID}:Position:Position`;
    const [openResults, mcResults] = await Promise.all([
      cantonQuery(env, templateId, { status: 'Open' }),
      cantonQuery(env, templateId, { status: 'MarginCalled' }),
    ]);

    // Flatten to a consistent shape for CRE
    const positions = [...openResults, ...mcResults].map((c: any) => ({
      contractId: c.contractId,
      positionId: c.payload.positionId,
      fund: c.payload.fund,
      broker: c.payload.broker,
      operator: c.payload.operator,
      vaultId: c.payload.vaultId,
      description: c.payload.description,
      notionalValue: c.payload.notionalValue,
      currentLTV: c.payload.currentLTV,
      status: c.payload.status,
      direction: c.payload.direction,
      entryPrice: c.payload.entryPrice,
      units: c.payload.units,
      unrealizedPnL: c.payload.unrealizedPnL,
    }));

    return new Response(
      JSON.stringify({ positions }),
      { status: 200, headers: CORS_HEADERS },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || 'Failed to fetch positions' }),
      { status: 500, headers: CORS_HEADERS },
    );
  }
};
