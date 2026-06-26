// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../contracts/Verifier.sol";

/// @title  MockVerifier — Configurable test double for Verifier.sol
/// @dev    Used in unit tests to simulate passing and failing proof verification
///         without executing real BN254 elliptic curve pairing operations.
contract MockVerifier is IVerifier {
    bool private _shouldPass;

    constructor(bool shouldPass) {
        _shouldPass = shouldPass;
    }

    /// @inheritdoc IVerifier
    function verify(
        bytes     calldata /* proof */,
        uint256[] calldata /* instances */
    ) external view override returns (bool) {
        return _shouldPass;
    }

    /// @dev Allows tests to flip the result dynamically.
    function setShouldPass(bool shouldPass) external {
        _shouldPass = shouldPass;
    }
}
