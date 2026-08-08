// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ============================================================
//  contracts/VideoRegistry.sol  —  Authentica Phase 2
// ============================================================
//
//  The on-chain immutable database of verified media.
//
//  Core flow:
//
//    Off-chain:
//      1. Camera captures a video frame.
//      2. Privacy filter (PixelationFilter CNN) processes the frame.
//      3. proof_generator.py produces proof.json.
//      4. Backend computes SHA-256 of the blurred video.
//
//    On-chain (this contract):
//      5. publishVideo(videoHash, proof, instances) is called.
//      6. VideoRegistry calls Verifier.verifyProof(proof, instances).
//      7. If valid → record is stored permanently; VideoVerified is emitted.
//      8. Anyone can call isVerified(videoHash) to check authenticity.
//
// ============================================================

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
// Import only the interface — NOT Verifier.sol directly.
// Importing Verifier.sol would force the 1427-line Halo2Verifier assembly
// into the same compilation unit as VideoRegistry, overwhelming the Yul
// stack optimizer and causing "too deep in the stack" errors.
import "./IVerifier.sol";

/// @title  VideoRegistry — Authentica immutable media authenticity ledger
/// @author Authentica Team
/// @notice Stores SHA-256 hashes of privacy-filtered videos and links each
///         hash to a cryptographic zk-SNARK proof that the privacy filter
///         was applied correctly — without revealing the original footage.
contract VideoRegistry is Ownable, ReentrancyGuard, Pausable {

    // ── Custom errors ─────────────────────────────────────────────────────────
    error InvalidProof();
    error VideoAlreadyRegistered(bytes32 videoHash);
    error ZeroHash();
    error EmptyProof();
    error EmptyInstances();
    error ZeroAddress();

    // ── Data structures ───────────────────────────────────────────────────────

    /// @notice On-chain record for a verified video.
    struct VideoRecord {
        bytes32   videoHash;        // SHA-256 of the blurred output video
        address   publisher;        // wallet that called publishVideo
        uint64    timestamp;        // block.timestamp at publication
        uint64    blockNumber;      // block.number at publication
        bytes32   proofDigest;      // keccak256(proof) — compact on-chain fingerprint
        uint256[] instances;        // public instances from the zk circuit (model outputs)
        bool      verified;         // always true if it exists — acts as existence flag
    }

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice The EZKL-generated zk-SNARK verifier contract (referenced via interface).
    IVerifier public verifier;

    /// @notice videoHash → VideoRecord
    mapping(bytes32 => VideoRecord) private _records;

    /// @notice All registered video hashes in insertion order.
    bytes32[] private _allHashes;

    /// @notice Total count of verified videos.
    uint256 public totalVideos;

    // ── Events ────────────────────────────────────────────────────────────────

    /// @notice Emitted every time a video is successfully verified and recorded.
    /// @param  videoHash    SHA-256 of the blurred video.
    /// @param  publisher    Wallet that submitted the proof.
    /// @param  proofDigest  keccak256(proof) — compact on-chain fingerprint.
    /// @param  timestamp    Unix timestamp of the block.
    /// @param  instances    Public outputs of the zk circuit.
    event VideoVerified(
        bytes32 indexed videoHash,
        address indexed publisher,
        bytes32         proofDigest,
        uint64          timestamp,
        uint256[]       instances
    );

    /// @notice Emitted when the verifier contract address is updated by the owner.
    event VerifierUpdated(address indexed oldVerifier, address indexed newVerifier);

    // ── Constructor ───────────────────────────────────────────────────────────

    /// @param _verifier  Address of the deployed Verifier.sol contract.
    constructor(address _verifier) Ownable(msg.sender) {
        if (_verifier == address(0)) revert ZeroAddress();
        verifier = IVerifier(_verifier);
    }

    // ── Core: publishVideo ────────────────────────────────────────────────────

    /// @notice Submit a zk-SNARK proof that the PixelationFilter CNN was applied
    ///         to a video and store the verified record permanently.
    ///
    /// @dev    Calls Verifier.verifyProof() — if it returns false the tx reverts.
    ///         Gas note: the BN254 pairing check in the real EZKL verifier
    ///         costs ~600 000 gas.  Plan accordingly.
    ///
    /// @param  videoHash  keccak256 / SHA-256 of the blurred output video bytes.
    ///                    Computed off-chain by the backend.
    /// @param  proof      The full zk-SNARK proof bytes from proof_generator.py
    ///                    (i.e., the serialised contents of artifacts/proof.json).
    /// @param  instances  The public instances array from the zk circuit.
    ///                    These are the quantised output logits of the PixelationFilter.
    ///                    The Verifier uses them to reconstruct the public input commitment.
    function publishVideo(
        bytes32   videoHash,
        bytes     calldata proof,
        uint256[] calldata instances
    )
        external
        nonReentrant
        whenNotPaused
    {
        // ── Input validation ──────────────────────────────────────────────────
        if (videoHash == bytes32(0))          revert ZeroHash();
        if (proof.length == 0)                revert EmptyProof();
        if (instances.length == 0)            revert EmptyInstances();
        if (_records[videoHash].verified)     revert VideoAlreadyRegistered(videoHash);

        // ── zk-SNARK verification ─────────────────────────────────────────────
        // This is the critical step. The Verifier contract performs elliptic
        // curve pairing operations (BN254) to confirm the proof is valid without
        // needing to know the original unblurred video or the model weights.
        bool valid = verifier.verifyProof(proof, instances);
        if (!valid) revert InvalidProof();

        // ── Persist record ────────────────────────────────────────────────────
        bytes32 proofDigest = keccak256(proof);

        _records[videoHash] = VideoRecord({
            videoHash:   videoHash,
            publisher:   msg.sender,
            timestamp:   uint64(block.timestamp),
            blockNumber: uint64(block.number),
            proofDigest: proofDigest,
            instances:   instances,
            verified:    true
        });

        _allHashes.push(videoHash);
        unchecked { ++totalVideos; }

        // ── Emit ──────────────────────────────────────────────────────────────
        emit VideoVerified(
            videoHash,
            msg.sender,
            proofDigest,
            uint64(block.timestamp),
            instances
        );
    }

    // ── View: authenticity checks ─────────────────────────────────────────────

    /// @notice Returns true if the video hash was successfully verified on-chain.
    /// @param  videoHash  SHA-256 of the video to check.
    function isVerified(bytes32 videoHash) external view returns (bool) {
        return _records[videoHash].verified;
    }

    /// @notice Returns the full VideoRecord for a given hash.
    /// @dev    Reverts with a zero-value struct if the hash is not registered.
    function getRecord(bytes32 videoHash)
        external
        view
        returns (VideoRecord memory)
    {
        return _records[videoHash];
    }

    /// @notice Returns the publisher address for a verified video.
    ///         Returns address(0) if the video is not registered.
    function getPublisher(bytes32 videoHash) external view returns (address) {
        return _records[videoHash].publisher;
    }

    /// @notice Returns the on-chain timestamp when the video was verified.
    ///         Returns 0 if the video is not registered.
    function getTimestamp(bytes32 videoHash) external view returns (uint64) {
        return _records[videoHash].timestamp;
    }

    /// @notice Returns the public instances (zk circuit outputs) for a video.
    function getInstances(bytes32 videoHash)
        external
        view
        returns (uint256[] memory)
    {
        return _records[videoHash].instances;
    }

    /// @notice Paginated list of all registered video hashes.
    /// @param  offset  Starting index.
    /// @param  limit   Maximum number of entries to return.
    function getHashes(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory result)
    {
        uint256 total = _allHashes.length;
        if (offset >= total) return new bytes32[](0);

        uint256 end    = offset + limit;
        if (end > total) end = total;
        uint256 count  = end - offset;

        result = new bytes32[](count);
        for (uint256 i = 0; i < count; ) {
            result[i] = _allHashes[offset + i];
            unchecked { ++i; }
        }
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// @notice Replace the Verifier contract (e.g. when a new zkML model is deployed).
    /// @dev    Only callable by the contract owner.
    ///         Emits VerifierUpdated.
    function setVerifier(address _newVerifier) external onlyOwner {
        if (_newVerifier == address(0)) revert ZeroAddress();
        address old = address(verifier);
        verifier = IVerifier(_newVerifier);
        emit VerifierUpdated(old, _newVerifier);
    }

    /// @notice Pause all new video submissions.
    ///         Existing records are unaffected and remain queryable.
    function pause()   external onlyOwner { _pause(); }

    /// @notice Resume video submissions.
    function unpause() external onlyOwner { _unpause(); }
}
