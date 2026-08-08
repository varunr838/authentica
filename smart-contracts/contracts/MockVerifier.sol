// MockVerifier.sol
pragma solidity ^0.8.24;

import "./IVerifier.sol";

contract MockVerifier is IVerifier {
    bool private _shouldPass;

    constructor(bool shouldPass) {
        _shouldPass = shouldPass;
    }

    function verifyProof(
        bytes calldata /* proof */,
        uint256[] calldata /* instances */
    ) external returns (bool) {
        return _shouldPass;
    }

    function setShouldPass(bool shouldPass) external {
        _shouldPass = shouldPass;
    }
}