/**
 * LTV Prover Service
 *
 * Generates Groth16 proofs for LTV computations.
 * Deployed as a Cloudflare Worker or standalone Node.js service.
 */

// Note: In production, snarkjs would be imported and wasm/zkey files loaded
// For Cloudflare Workers, you may need to use a different approach (e.g., Durable Objects)
// or run this as a Node.js service

interface Position {
  positionId: string;
  notionalValue: string;
  unrealizedPnL: string;
  ltvThreshold: string;
  leverageRatio: string;
  collateral: Array<{
    asset: string;
    amount: string;
  }>;
}

interface Prices {
  [asset: string]: number;
}

interface ProveRequest {
  positions: Position[];
  prices: Prices;
  computedLtvBps: number;
  timestamp: number;
}

interface ProofResult {
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  };
  publicSignals: string[];
  calldata: string;
  verified: boolean;
}

// Simulated proof generation (replace with actual snarkjs in production)
async function generateProof(
  positions: Position[],
  prices: Prices,
  ltvBps: number,
  timestamp: number
): Promise<ProofResult> {
  // In production:
  // const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  //   circuitInputs,
  //   "circuits/ltv.wasm",
  //   "circuits/ltv_final.zkey"
  // );

  // Hash position ID for circuit input
  const positionIdHash = hashPositionId(positions[0]?.positionId || "");

  // Prepare circuit inputs
  const circuitInputs = prepareCircuitInputs(positions, prices, ltvBps, timestamp);

  // Placeholder proof (replace with actual snarkjs call)
  const proof = {
    pi_a: [
      "0x" + "1".repeat(64),
      "0x" + "2".repeat(64),
      "0x01"
    ],
    pi_b: [
      ["0x" + "3".repeat(64), "0x" + "4".repeat(64)],
      ["0x" + "5".repeat(64), "0x" + "6".repeat(64)],
      ["0x01", "0x00"]
    ],
    pi_c: [
      "0x" + "7".repeat(64),
      "0x" + "8".repeat(64),
      "0x01"
    ],
    protocol: "groth16",
    curve: "bn128"
  };

  const publicSignals = [
    ltvBps.toString(),
    (parseFloat(positions[0]?.ltvThreshold || "0.8") * 10000).toString(),
    positionIdHash,
    timestamp.toString()
  ];

  // Generate Solidity calldata
  const calldata = generateSolidityCalldata(proof, publicSignals);

  return {
    proof,
    publicSignals,
    calldata,
    verified: true // Would be actual verification in production
  };
}

function hashPositionId(positionId: string): string {
  // Simple hash for demo (use proper hashing in production)
  let hash = 0;
  for (let i = 0; i < positionId.length; i++) {
    const char = positionId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString();
}

function prepareCircuitInputs(
  positions: Position[],
  prices: Prices,
  ltvBps: number,
  timestamp: number
) {
  const position = positions[0];
  if (!position) throw new Error("No positions provided");

  // Pad collateral to 5 assets
  const collateralAmounts: string[] = [];
  const collateralPrices: string[] = [];

  for (let i = 0; i < 5; i++) {
    if (position.collateral[i]) {
      const asset = position.collateral[i].asset;
      const amount = position.collateral[i].amount;
      collateralAmounts.push(toWei(amount));
      collateralPrices.push(toWei(prices[asset]?.toString() || "0"));
    } else {
      collateralAmounts.push("0");
      collateralPrices.push("0");
    }
  }

  return {
    collateralAmounts,
    collateralPrices,
    notionalValue: toWei(position.notionalValue),
    unrealizedPnL: toWei(position.unrealizedPnL || "0"),
    leverageRatioBps: Math.floor(parseFloat(position.leverageRatio || "1") * 10000).toString(),
    ltvResultBps: ltvBps.toString(),
    thresholdBps: Math.floor(parseFloat(position.ltvThreshold || "0.8") * 10000).toString(),
    positionIdHash: hashPositionId(position.positionId),
    timestamp: timestamp.toString()
  };
}

function toWei(value: string): string {
  // Convert to 18 decimal representation
  const num = parseFloat(value);
  return Math.floor(num * 1e18).toString();
}

function generateSolidityCalldata(proof: any, publicSignals: string[]): string {
  // Format for Solidity verifier
  // verifyProof(uint[2] a, uint[2][2] b, uint[2] c, uint[N] input)
  return JSON.stringify({
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [[proof.pi_b[0][0], proof.pi_b[0][1]], [proof.pi_b[1][0], proof.pi_b[1][1]]],
    c: [proof.pi_c[0], proof.pi_c[1]],
    input: publicSignals
  });
}

// Calculate expected LTV for validation
function calculateExpectedLTV(positions: Position[], prices: Prices): number {
  const position = positions[0];
  if (!position) return 0;

  let totalCollateral = 0;
  for (const col of position.collateral) {
    const price = prices[col.asset] || 0;
    totalCollateral += parseFloat(col.amount) * price;
  }

  const pnl = parseFloat(position.unrealizedPnL || "0");
  const effectiveCollateral = totalCollateral + pnl;
  const notional = parseFloat(position.notionalValue);
  const leverage = parseFloat(position.leverageRatio || "1");

  if (effectiveCollateral <= 0) return 10000; // Max LTV if no collateral

  const ltv = notional / (effectiveCollateral * leverage);
  return Math.floor(ltv * 10000); // Return as basis points
}

// Main handler
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (url.pathname === "/api/prove-ltv" && request.method === "POST") {
      try {
        const body: ProveRequest = await request.json();
        const { positions, prices, computedLtvBps, timestamp } = body;

        // Validate inputs
        if (!positions?.length) {
          return new Response(
            JSON.stringify({ error: "No positions provided" }),
            { status: 400, headers }
          );
        }

        // Verify computed LTV matches our calculation
        const expectedLtvBps = calculateExpectedLTV(positions, prices);
        const tolerance = 100; // 1% tolerance for rounding
        if (Math.abs(expectedLtvBps - computedLtvBps) > tolerance) {
          return new Response(
            JSON.stringify({
              error: "LTV mismatch",
              expected: expectedLtvBps,
              received: computedLtvBps
            }),
            { status: 400, headers }
          );
        }

        // Generate proof
        const result = await generateProof(
          positions,
          prices,
          computedLtvBps,
          timestamp || Math.floor(Date.now() / 1000)
        );

        return new Response(JSON.stringify(result), { headers });

      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          { status: 500, headers }
        );
      }
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "ltv-prover" }),
        { headers }
      );
    }

    return new Response(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers }
    );
  }
};
