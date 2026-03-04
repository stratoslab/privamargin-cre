#!/bin/bash
# LTV Circuit Setup Script
# Compiles the circom circuit and generates proving/verification keys

set -e

CIRCUIT_NAME="ltv"
CIRCUITS_DIR="circuits"
BUILD_DIR="build"
PTAU_FILE="powersOfTau28_hez_final_14.ptau"

echo "=== LTV Circuit Setup ==="

# Check dependencies
command -v circom >/dev/null 2>&1 || { echo "Error: circom not installed. Run: npm install -g circom"; exit 1; }
command -v snarkjs >/dev/null 2>&1 || { echo "Error: snarkjs not installed. Run: npm install -g snarkjs"; exit 1; }

# Create build directory
mkdir -p $BUILD_DIR

# Step 1: Download Powers of Tau (if not exists)
if [ ! -f "$BUILD_DIR/$PTAU_FILE" ]; then
    echo "Downloading Powers of Tau..."
    curl -L -o "$BUILD_DIR/$PTAU_FILE" \
        "https://hermez.s3-eu-west-1.amazonaws.com/$PTAU_FILE"
fi

# Step 2: Compile circuit
echo "Compiling circuit..."
circom "$CIRCUITS_DIR/$CIRCUIT_NAME.circom" \
    --r1cs --wasm --sym \
    -o $BUILD_DIR

# Step 3: Generate zkey (Groth16 setup)
echo "Generating proving key (this may take a while)..."
snarkjs groth16 setup \
    "$BUILD_DIR/$CIRCUIT_NAME.r1cs" \
    "$BUILD_DIR/$PTAU_FILE" \
    "$BUILD_DIR/${CIRCUIT_NAME}_0000.zkey"

# Step 4: Contribute to ceremony (for production, use multiple contributors)
echo "Contributing to trusted setup..."
snarkjs zkey contribute \
    "$BUILD_DIR/${CIRCUIT_NAME}_0000.zkey" \
    "$BUILD_DIR/${CIRCUIT_NAME}_final.zkey" \
    --name="PrivaMargin Contribution" \
    -v -e="$(head -c 64 /dev/urandom | xxd -p)"

# Step 5: Export verification key
echo "Exporting verification key..."
snarkjs zkey export verificationkey \
    "$BUILD_DIR/${CIRCUIT_NAME}_final.zkey" \
    "$BUILD_DIR/verification_key.json"

# Step 6: Generate Solidity verifier
echo "Generating Solidity verifier..."
mkdir -p contracts
snarkjs zkey export solidityverifier \
    "$BUILD_DIR/${CIRCUIT_NAME}_final.zkey" \
    "contracts/LTVVerifier.sol"

# Step 7: Copy artifacts for deployment
echo "Copying artifacts..."
mkdir -p circuits/compiled
cp "$BUILD_DIR/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm" circuits/compiled/
cp "$BUILD_DIR/${CIRCUIT_NAME}_final.zkey" circuits/compiled/
cp "$BUILD_DIR/verification_key.json" circuits/compiled/

echo ""
echo "=== Setup Complete ==="
echo "Artifacts:"
echo "  - circuits/compiled/$CIRCUIT_NAME.wasm (for proof generation)"
echo "  - circuits/compiled/${CIRCUIT_NAME}_final.zkey (proving key)"
echo "  - circuits/compiled/verification_key.json (for off-chain verification)"
echo "  - contracts/LTVVerifier.sol (Solidity verifier)"
