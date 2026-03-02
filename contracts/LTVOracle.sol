// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title LTVOracle
 * @notice On-chain LTV attestation and liquidation trigger contract for PrivaMargin.
 *
 * Written to by Chainlink CRE workflow (DON consensus).
 * Read/watched by PrivaMargin server for Canton ledger operations.
 *
 * Flow:
 *   CRE DON → attestLTV() every cycle for all positions
 *   CRE DON → triggerLiquidation() when LTV >= threshold
 *   PrivaMargin → watches LiquidationTriggered event → exercises Canton choices
 */
contract LTVOracle {
    // -----------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------

    event LTVAttested(
        string indexed positionId,
        string vaultId,
        uint256 ltvBps,           // LTV in basis points (8500 = 85%)
        uint256 collateralUsd18,  // Collateral value in 18-decimal USD
        uint256 timestamp
    );

    event LiquidationTriggered(
        string indexed positionId,
        string vaultId,
        string broker,
        string fund,
        uint256 ltvBps,           // Current LTV in basis points
        uint256 thresholdBps,     // Threshold in basis points
        uint256 timestamp
    );

    // -----------------------------------------------------------------
    // State
    // -----------------------------------------------------------------

    /// @notice Address authorized to write attestations (CRE forwarder)
    address public immutable forwarder;

    /// @notice Latest LTV attestation per position
    struct Attestation {
        uint256 ltvBps;
        uint256 collateralUsd18;
        uint256 notionalUsd18;
        int256 pnlUsd18;
        uint256 timestamp;
    }

    mapping(bytes32 => Attestation) public attestations;

    /// @notice Liquidation trigger nonce per position (prevents replay)
    mapping(bytes32 => uint256) public liquidationNonce;

    // -----------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------

    /// @param _forwarder CRE KeystoneForwarder contract address
    constructor(address _forwarder) {
        forwarder = _forwarder;
    }

    modifier onlyForwarder() {
        require(msg.sender == forwarder, "LTVOracle: unauthorized");
        _;
    }

    // -----------------------------------------------------------------
    // Write functions (called by CRE DON via KeystoneForwarder)
    // -----------------------------------------------------------------

    /// @notice Record an LTV attestation for a position.
    ///         Called every monitoring cycle for all open/margin-called positions.
    function attestLTV(
        string calldata positionId,
        string calldata vaultId,
        uint256 ltvBps,
        uint256 collateralUsd18,
        uint256 notionalUsd18,
        uint256 pnlUsd18,
        uint256 timestamp
    ) external onlyForwarder {
        bytes32 key = keccak256(abi.encodePacked(positionId));

        attestations[key] = Attestation({
            ltvBps: ltvBps,
            collateralUsd18: collateralUsd18,
            notionalUsd18: notionalUsd18,
            pnlUsd18: int256(pnlUsd18),
            timestamp: timestamp
        });

        emit LTVAttested(positionId, vaultId, ltvBps, collateralUsd18, timestamp);
    }

    /// @notice Trigger a liquidation for a breached position.
    ///         PrivaMargin server watches this event and executes Canton operations.
    function triggerLiquidation(
        string calldata positionId,
        string calldata vaultId,
        string calldata broker,
        string calldata fund,
        uint256 ltvBps,
        uint256 thresholdBps,
        uint256 timestamp
    ) external onlyForwarder {
        require(ltvBps >= thresholdBps, "LTVOracle: LTV below threshold");

        bytes32 key = keccak256(abi.encodePacked(positionId));
        liquidationNonce[key]++;

        emit LiquidationTriggered(
            positionId, vaultId, broker, fund,
            ltvBps, thresholdBps, timestamp
        );
    }

    // -----------------------------------------------------------------
    // Read functions (for PrivaMargin server / UI verification)
    // -----------------------------------------------------------------

    /// @notice Get the latest attestation for a position.
    function getAttestation(string calldata positionId)
        external view returns (Attestation memory)
    {
        bytes32 key = keccak256(abi.encodePacked(positionId));
        return attestations[key];
    }

    /// @notice Get the liquidation nonce for a position (for replay protection).
    function getLiquidationNonce(string calldata positionId)
        external view returns (uint256)
    {
        bytes32 key = keccak256(abi.encodePacked(positionId));
        return liquidationNonce[key];
    }
}
