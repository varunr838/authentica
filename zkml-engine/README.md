# zkml-engine — Authentica Phase 1

> **Zero-Knowledge Machine Learning Core**
> Cryptographically prove a neural network ran correctly — without revealing the model weights or the raw input.

---

## What this does

| Script | Purpose |
|---|---|
| `model_export.py` | Defines & trains a tiny CNN (PixelationFilter), exports `network.onnx` + `input.json` |
| `zk_compiler.py` | Compiles the ONNX model into a Halo2 zk-SNARK circuit via EZKL; produces `verifier.sol` |
| `proof_generator.py` | Given a new image frame, generates a cryptographic proof (`proof.json`) |

---

## Architecture

```
image frame
    │
    ▼
[ PixelationFilter CNN ]  ←── tiny 16×16 greyscale patch CNN
    │
    ▼ (ONNX export)
network.onnx
    │
    ▼ (EZKL circuit compilation)
model.compiled  ──┬──  pk.key   (prover key)
settings.json     │    vk.key   (verifier key)
srs.params        │    verifier.sol  (EVM Solidity contract)
    │             │
    ▼             │
[ Proof Generator ] ── witness.json (private execution trace)
    │
    ▼
proof.json  ──►  on-chain verifier.sol  →  VALID / INVALID
```

---

## Quick Start

### 1. Install dependencies

```bash
cd zkml-engine
pip install -r requirements.txt
```

> **Note:** `ezkl` is a Rust-backed Python wheel. On Windows you may need
> the latest MSVC runtime. If the wheel build fails, try:
> `pip install ezkl --pre` or use WSL2.

### 2. Train & export the model

```bash
python model_export.py
```

Writes to `artifacts/`:
- `network.onnx` — the exported model graph
- `input.json`   — sample witness input

### 3. Compile into a zk-SNARK circuit

```bash
python zk_compiler.py
```

Writes to `artifacts/`:
- `settings.json`     — circuit parameters
- `model.compiled`    — Halo2 arithmetic circuit
- `srs.params`        — KZG trusted setup (downloaded from Hermez ceremony)
- `pk.key`            — proving key
- `vk.key`            — verification key
- `verifier.sol`      — Solidity on-chain verifier contract
- `verifier_abi.json` — ABI for the verifier

> First run fetches the SRS from the Hermez CDN (~few MB). Subsequent runs
> are fully offline.

To force a full rebuild:
```bash
python zk_compiler.py --force
```

### 4. Generate a proof

```bash
# From a real image frame
python proof_generator.py --image path/to/frame.png --verify

# From the sample input
python proof_generator.py --verify
```

Writes `artifacts/proof.json` — the cryptographic proof the backend
submits to the on-chain verifier.

---

## Artifact Directory

```
zkml-engine/
├── artifacts/
│   ├── network.onnx          ← ONNX model graph
│   ├── input.json            ← sample input tensor
│   ├── settings.json         ← circuit settings
│   ├── model.compiled        ← compiled Halo2 circuit
│   ├── srs.params            ← KZG trusted setup
│   ├── pk.key                ← proving key
│   ├── vk.key                ← verification key
│   ├── verifier.sol          ← EVM Solidity verifier
│   ├── verifier_abi.json     ← verifier ABI
│   ├── witness.json          ← execution trace (private)
│   └── proof.json            ← final zk-SNARK proof
├── model_export.py
├── zk_compiler.py
├── proof_generator.py
└── requirements.txt
```

---

## Key Concepts

### Why a tiny model?
zk-SNARK circuits scale with the number of arithmetic gates, which grows
linearly with model parameters and nonlinear operations. The 16×16 greyscale
PixelationFilter has **~2,000 parameters** — tractable for proof generation
on CPU in minutes. A ResNet-50 would take days.

### What is the SRS?
The Structured Reference String (KZG params from the Hermez ceremony) is
the "public parameters" shared by all provers and verifiers. EZKL
automatically selects the right size based on `logrows`.

### What is `verifier.sol`?
An auto-generated Solidity contract. Deploy it to any EVM chain (Ethereum,
Polygon, etc.) and any node can call `verify(proof, instances)` to
cryptographically confirm a computation happened correctly — with no
trusted third party.

---

## Next Phases
- **Phase 2** — Camera attestation pipeline (C2PA + Secure Enclave signatures)
- **Phase 3** — FastAPI backend that accepts frames and returns `proof.json`
- **Phase 4** — Blockchain anchoring (Merkle roots + block hashes)
- **Phase 5** — Frontend dashboard
