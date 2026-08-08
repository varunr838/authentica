"""
blockchain_publisher.py  —  Authentica Phase 3
===============================================
Reads proof.json + the blurred video hash and submits them to the
VideoRegistry.sol smart contract via web3.py.

Flow
----
  1. Load deployment addresses from smart-contracts/deployments/<network>.json
  2. Load VideoRegistry ABI from smart-contracts/artifacts/
  3. Parse proof.json produced by EZKL:
       • proof bytes  → raw hex bytes
       • instances    → list[int]  (quantised circuit output values)
  4. Compute SHA-256 of blurred_video.mp4 as a bytes32
  5. Sign and broadcast a `publishVideo(videoHash, proof, instances)` tx
  6. Wait for the receipt and return structured result

Environment variables (loaded from .env)
-----------------------------------------
  WEB3_RPC_URL         Ethereum RPC endpoint
  PUBLISHER_PRIVATE_KEY  Wallet private key (hex with or without 0x)
  CHAIN_ID             e.g. 1337 (local) or 11155111 (Sepolia)
  NETWORK_NAME         Must match a file in smart-contracts/deployments/
  GAS_LIMIT            Override gas limit (optional)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import pathlib
from typing import Any

from dotenv import load_dotenv

logger = logging.getLogger("authentica.blockchain_publisher")

load_dotenv()

# ── Paths ─────────────────────────────────────────────────────────────────────
_HERE          = pathlib.Path(__file__).parent
CONTRACTS_DIR  = (_HERE / ".." / "smart-contracts").resolve()

# ── Env ───────────────────────────────────────────────────────────────────────
RPC_URL     = os.getenv("WEB3_RPC_URL",          "http://127.0.0.1:8545")
PRIVATE_KEY = os.getenv("PUBLISHER_PRIVATE_KEY", "0x" + "0" * 64)
CHAIN_ID    = int(os.getenv("CHAIN_ID",          "1337"))
NETWORK     = os.getenv("NETWORK_NAME",          "localhost")
GAS_LIMIT   = int(os.getenv("GAS_LIMIT",         "15000000"))


# ── ABI / address loaders ─────────────────────────────────────────────────────
def _load_deployment() -> dict:
    """
    Load the deployment record saved by scripts/deploy.js.
    Returns the full JSON object from deployments/<network>.json.
    """
    deploy_file = CONTRACTS_DIR / "deployments" / f"{NETWORK}.json"
    if not deploy_file.exists():
        raise FileNotFoundError(
            f"Deployment record not found: {deploy_file}\n"
            f"Run `npm run deploy:{NETWORK}` in smart-contracts/ first."
        )
    with open(deploy_file) as fh:
        data = json.load(fh)
    logger.info("Loaded deployment from %s", deploy_file)
    return data


def _load_abi(contract_name: str) -> list:
    """
    Load the ABI from the Hardhat artifacts directory.
    Path pattern: artifacts/contracts/<Name>.sol/<Name>.json
    """
    abi_file = (
        CONTRACTS_DIR
        / "artifacts"
        / "contracts"
        / f"{contract_name}.sol"
        / f"{contract_name}.json"
    )
    if not abi_file.exists():
        raise FileNotFoundError(
            f"ABI not found: {abi_file}\n"
            f"Run `npm run compile` in smart-contracts/ first."
        )
    with open(abi_file) as fh:
        artifact = json.load(fh)
    return artifact["abi"]


# ── Proof parsing ─────────────────────────────────────────────────────────────
def _parse_proof(proof_json_path: pathlib.Path) -> tuple[bytes, list[int]]:
    """
    Parse the proof.json file produced by EZKL's proof_generator.py.

    EZKL proof.json structure (v9.x):
    {
        "proof": "0xabcdef…",          ← hex-encoded proof transcript
        "instances": [["0x1234…", …]]  ← nested list of hex field elements
    }

    Returns
    -------
    proof_bytes : bytes   — raw proof bytes for on-chain submission
    instances   : list[int] — flattened list of public inputs as Python ints
    """
    with open(proof_json_path) as fh:
        data = json.load(fh)

    # ── Proof bytes ───────────────────────────────────────────────────────
    raw_proof = data.get("proof", "")
    if isinstance(raw_proof, str):
        hex_str    = raw_proof.removeprefix("0x")
        proof_bytes = bytes.fromhex(hex_str)
    elif isinstance(raw_proof, list):
        # Some EZKL versions return a list of byte ints
        proof_bytes = bytes(raw_proof)
    else:
        raise ValueError(f"Unexpected proof type: {type(raw_proof)}")

    # ── Instances ─────────────────────────────────────────────────────────
    raw_instances = data.get("instances", [])
    instances: list[int] = []

    def _le_hex_to_int(h: str) -> int:
        """Convert an EZKL little-endian hex field element to a Python int."""
        hex_str = h.removeprefix("0x")
        if len(hex_str) % 2:
            hex_str = "0" + hex_str
        return int(bytes.fromhex(hex_str)[::-1].hex(), 16)

    for row in raw_instances:
        if isinstance(row, list):
            for elem in row:
                # EZKL field elements are little-endian hex strings
                if isinstance(elem, str):
                    instances.append(_le_hex_to_int(elem))
                else:
                    instances.append(int(elem))
        elif isinstance(row, (str, int)):
            if isinstance(row, str):
                instances.append(_le_hex_to_int(row))
            else:
                instances.append(int(row))

    if not instances:
        raise ValueError(
            "proof.json contains no instances — has the circuit been compiled with "
            "public outputs? Check zk_compiler.py settings."
        )

    logger.info(
        "Parsed proof: %d bytes, %d public instances", len(proof_bytes), len(instances)
    )
    return proof_bytes, instances


# ── Video hash ────────────────────────────────────────────────────────────────
def _compute_video_hash(blurred_video_path: pathlib.Path) -> bytes:
    """
    Compute SHA-256 of the blurred video and return it as a 32-byte value
    suitable for a Solidity bytes32 parameter.
    """
    sha256 = hashlib.sha256()
    with open(blurred_video_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            sha256.update(chunk)
    digest_bytes = sha256.digest()    # 32 raw bytes
    logger.info("Video SHA-256: 0x%s", digest_bytes.hex())
    return digest_bytes


# ── Publisher ─────────────────────────────────────────────────────────────────
class BlockchainPublisher:
    """
    Wraps web3.py to publish a verified video record on-chain.

    Usage (sync):
        bp     = BlockchainPublisher()
        result = bp.publish(proof_json_path, blurred_video_path)

    Usage (async via FastAPI):
        result = await publish_async(proof_json_path, blurred_video_path)
    """

    def __init__(self) -> None:
        try:
            from web3 import Web3
        except ImportError:
            raise RuntimeError("web3 not installed. Run: pip install web3")

        from web3 import Web3
        from eth_account import Account

        self._Web3   = Web3
        self._Account = Account

        # Connect
        self.w3 = Web3(Web3.HTTPProvider(RPC_URL))
        if not self.w3.is_connected():
            raise ConnectionError(
                f"Cannot connect to Ethereum node at {RPC_URL}.\n"
                "Is the node running? (npx hardhat node)"
            )
        logger.info("Connected to %s (chainId=%d)", RPC_URL, CHAIN_ID)

        # Signer
        pk = PRIVATE_KEY if PRIVATE_KEY.startswith("0x") else f"0x{PRIVATE_KEY}"
        self.account = Account.from_key(pk)
        logger.info("Publisher address: %s", self.account.address)

        # Contract
        deployment  = _load_deployment()
        registry_addr = deployment["videoRegistry"]["address"]
        registry_abi  = _load_abi("VideoRegistry")

        self.registry = self.w3.eth.contract(
            address=Web3.to_checksum_address(registry_addr),
            abi=registry_abi,
        )
        logger.info("VideoRegistry @ %s", registry_addr)

    # ── Balance check ─────────────────────────────────────────────────────────
    def _check_balance(self) -> None:
        balance = self.w3.eth.get_balance(self.account.address)
        eth_val = self.w3.from_wei(balance, "ether")
        logger.info("Publisher balance: %.6f ETH", eth_val)
        if balance == 0:
            raise RuntimeError(
                f"Publisher wallet {self.account.address} has 0 ETH.\n"
                "Fund it with test ETH before publishing."
            )

    # ── Build & send transaction ──────────────────────────────────────────────
    def _build_tx(
        self,
        video_hash_bytes32: bytes,
        proof_bytes:        bytes,
        instances:          list[int],
    ) -> dict:
        """Construct the raw transaction dict for publishVideo()."""
        nonce     = self.w3.eth.get_transaction_count(self.account.address)
        gas_price = self.w3.eth.gas_price

        # Build function call
        fn_call = self.registry.functions.publishVideo(
            video_hash_bytes32,
            proof_bytes,
            instances,
        )

        tx = fn_call.build_transaction({
            "chainId":  CHAIN_ID,
            "from":     self.account.address,
            "nonce":    nonce,
            "gas":      GAS_LIMIT,
            "gasPrice": gas_price,
        })
        return tx

    def _send_tx(self, tx: dict) -> str:
        """Sign and broadcast the transaction. Returns the tx hash hex."""
        signed = self.w3.eth.account.sign_transaction(tx, private_key=self.account.key)
        tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        logger.info("Transaction sent: 0x%s", tx_hash.hex())
        return "0x" + tx_hash.hex()

    # ── Main publish method ───────────────────────────────────────────────────
    def publish(
        self,
        proof_json_path:    pathlib.Path,
        blurred_video_path: pathlib.Path,
    ) -> dict:
        """
        Full publish pipeline.

        Returns a result dict:
        {
            "tx_hash":        "0x…",
            "block_number":   int,
            "gas_used":       int,
            "video_hash":     "0x…" (hex SHA-256),
            "registry":       "0x…" (contract address),
            "publisher":      "0x…" (wallet address),
            "status":         "success" | "failed",
        }
        """
        self._check_balance()

        # 1. Parse proof
        proof_bytes, instances = _parse_proof(proof_json_path)

        # 2. Hash video
        video_hash_bytes = _compute_video_hash(blurred_video_path)

        # 3. Build tx
        logger.info("Building publishVideo transaction …")
        tx = self._build_tx(video_hash_bytes, proof_bytes, instances)

        # 4. Send
        tx_hash = self._send_tx(tx)

        # 5. Wait for receipt
        logger.info("Waiting for transaction receipt …")
        receipt = self.w3.eth.wait_for_transaction_receipt(
            bytes.fromhex(tx_hash.removeprefix("0x")),
            timeout=300,         # 5 min — real chains can be slow
        )

        status  = "success" if receipt.status == 1 else "failed"
        gas_used = receipt.gasUsed

        logger.info(
            "Tx %s — status=%s, block=%d, gas=%d",
            tx_hash, status, receipt.blockNumber, gas_used
        )

        if status == "failed":
            raise RuntimeError(
                f"On-chain transaction reverted (tx={tx_hash}).\n"
                "Possible causes:\n"
                "  • Stub verifier still deployed (verify() always returns false)\n"
                "  • Video hash already registered\n"
                "  • Proof is invalid or instances mismatch"
            )

        return {
            "tx_hash":      tx_hash,
            "block_number": receipt.blockNumber,
            "gas_used":     gas_used,
            "video_hash":   "0x" + video_hash_bytes.hex(),
            "registry":     self.registry.address,
            "publisher":    self.account.address,
            "status":       status,
        }


# ── Async wrapper ─────────────────────────────────────────────────────────────
async def publish_async(
    proof_json_path:    pathlib.Path,
    blurred_video_path: pathlib.Path,
) -> dict:
    """
    Async wrapper: runs BlockchainPublisher.publish() in a thread pool.
    Suitable for calling from FastAPI route handlers.
    """
    publisher = BlockchainPublisher()
    return await asyncio.to_thread(
        publisher.publish,
        proof_json_path,
        blurred_video_path,
    )
