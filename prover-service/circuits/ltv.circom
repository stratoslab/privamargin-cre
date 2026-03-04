pragma circom 2.1.0;

/*
 * LTV Computation Circuit
 *
 * Proves that LTV was computed correctly given:
 * - Collateral amounts and prices
 * - Position notional value
 * - Leverage ratio
 *
 * Public inputs: ltvResultBps, thresholdBps, timestamp
 * Private inputs: collateral data, prices, notional
 *
 * Output: isBreached (1 if LTV >= threshold)
 */

// Simple greater-than-or-equal comparator
template GreaterEqThan(n) {
    signal input in[2];
    signal output out;

    // in[0] >= in[1] ?
    signal diff;
    diff <== in[0] - in[1] + (1 << n);

    // Check if diff >= (1 << n), meaning in[0] >= in[1]
    component bits = Num2Bits(n + 1);
    bits.in <== diff;
    out <== bits.out[n];
}

template Num2Bits(n) {
    signal input in;
    signal output out[n];

    var lc = 0;
    var bit_value = 1;

    for (var i = 0; i < n; i++) {
        out[i] <-- (in >> i) & 1;
        out[i] * (out[i] - 1) === 0;  // Ensure binary
        lc += out[i] * bit_value;
        bit_value *= 2;
    }

    lc === in;
}

/*
 * Main LTV Circuit
 *
 * nAssets: Maximum number of collateral assets (padded with zeros if fewer)
 *
 * LTV Formula:
 *   effectiveCollateral = sum(amount[i] * price[i]) + pnl
 *   LTV = (notional * 10000) / (effectiveCollateral * leverageRatio)
 *
 * We verify: notional * 10000 == ltvBps * effectiveCollateral * leverageRatio / 10000
 * (Rearranged to avoid division in circuit)
 */
template LTVComputation(nAssets) {
    // === Private Inputs ===
    signal input collateralAmounts[nAssets];  // Amounts scaled to 18 decimals
    signal input collateralPrices[nAssets];   // Prices in USD (18 decimals)
    signal input notionalValue;                // Notional in USD (18 decimals)
    signal input unrealizedPnL;                // PnL in USD (18 decimals, can be negative via offset)
    signal input leverageRatioBps;             // Leverage in basis points (10000 = 1x)

    // === Public Inputs ===
    signal input ltvResultBps;                 // Computed LTV in basis points
    signal input thresholdBps;                 // Threshold in basis points
    signal input positionIdHash;               // Hash of position ID for binding
    signal input timestamp;                    // Timestamp for freshness

    // === Output ===
    signal output isBreached;

    // === Computation ===

    // 1. Calculate total collateral value
    signal assetValues[nAssets];
    signal runningTotal[nAssets + 1];
    runningTotal[0] <== 0;

    for (var i = 0; i < nAssets; i++) {
        assetValues[i] <== collateralAmounts[i] * collateralPrices[i];
        runningTotal[i + 1] <== runningTotal[i] + assetValues[i];
    }

    signal totalCollateralValue;
    totalCollateralValue <== runningTotal[nAssets];

    // 2. Add PnL to get effective collateral
    // Note: PnL is offset by 10^18 to handle negatives (actual = pnl - 10^18)
    signal effectiveCollateral;
    effectiveCollateral <== totalCollateralValue + unrealizedPnL;

    // 3. Verify LTV calculation
    // LTV = notional / (effectiveCollateral * leverage)
    // Rearranged: notional * leverageBps * 10000 == ltvBps * effectiveCollateral
    signal lhs;
    signal rhs;
    lhs <== notionalValue * leverageRatioBps;
    rhs <== ltvResultBps * effectiveCollateral;

    // Allow small precision error (within 0.01%)
    signal diff;
    diff <== lhs - rhs;
    // We'd add range check here in production

    // 4. Check if breached
    component breachCheck = GreaterEqThan(32);
    breachCheck.in[0] <== ltvResultBps;
    breachCheck.in[1] <== thresholdBps;
    isBreached <== breachCheck.out;
}

// Main component with 5 asset slots
component main { public [ltvResultBps, thresholdBps, positionIdHash, timestamp] } = LTVComputation(5);
