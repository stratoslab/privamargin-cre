/**
 * GET /api/cre/vaults?vaultId=xxx — Server-side Canton query for CRE workflow.
 *
 * Returns a single CollateralVault by vaultId.
 * Authentication: X-API-Secret header.
 *
 * Copy the generateJWT and cantonQuery helpers from cre-positions.ts
 * (omitted here for brevity — same pattern).
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

// generateJWT + cantonQuery — same as cre-positions.ts (shared module in prod)

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const secret = request.headers.get('X-API-Secret');
  if (!secret || secret !== env.API_SECRET) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: CORS_HEADERS },
    );
  }

  const url = new URL(request.url);
  const vaultId = url.searchParams.get('vaultId');
  if (!vaultId) {
    return new Response(
      JSON.stringify({ error: 'vaultId query parameter required' }),
      { status: 400, headers: CORS_HEADERS },
    );
  }

  try {
    const templateId = `${env.PACKAGE_ID}:CollateralVault:CollateralVault`;

    // Reuse cantonQuery from shared module
    const generateJWT = async (env: Env) => {
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

    const token = await generateJWT(env);
    const res = await fetch(`https://${env.CANTON_JSON_HOST}/v1/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        templateIds: [templateId],
        query: { vaultId },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canton query ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { result: any[] };
    const results = data.result || [];

    if (results.length === 0) {
      return new Response(
        JSON.stringify({ vault: null }),
        { status: 200, headers: CORS_HEADERS },
      );
    }

    const v = results[0];
    return new Response(
      JSON.stringify({
        vault: {
          contractId: v.contractId,
          vaultId: v.payload.vaultId,
          owner: v.payload.owner,
          operator: v.payload.operator,
          collateralAssets: v.payload.collateralAssets,
          linkedPositions: v.payload.linkedPositions,
        },
      }),
      { status: 200, headers: CORS_HEADERS },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || 'Failed to fetch vault' }),
      { status: 500, headers: CORS_HEADERS },
    );
  }
};
