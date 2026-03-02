/**
 * GET /api/cre/links?broker=xxx&fund=xxx — BrokerFundLink query for CRE.
 *
 * Returns LTV threshold and leverage ratio for a broker-fund pair.
 * Authentication: X-API-Secret header.
 *
 * Same Canton query pattern as cre-positions.ts and cre-vaults.ts.
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
  const broker = url.searchParams.get('broker');
  const fund = url.searchParams.get('fund');

  if (!broker || !fund) {
    return new Response(
      JSON.stringify({ error: 'broker and fund query parameters required' }),
      { status: 400, headers: CORS_HEADERS },
    );
  }

  try {
    const templateId = `${env.PACKAGE_ID}:BrokerFundLink:BrokerFundLink`;

    // Inline JWT + query (shared module in production)
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
        query: { broker, fund },
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
        JSON.stringify({ link: null }),
        { status: 200, headers: CORS_HEADERS },
      );
    }

    const l = results[0].payload;
    return new Response(
      JSON.stringify({
        link: {
          broker: l.broker,
          fund: l.fund,
          ltvThreshold: l.ltvThreshold,
          leverageRatio: l.leverageRatio,
        },
      }),
      { status: 200, headers: CORS_HEADERS },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || 'Failed to fetch link' }),
      { status: 500, headers: CORS_HEADERS },
    );
  }
};
