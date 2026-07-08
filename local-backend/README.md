# local-backend — Authentica Phase 3

> **The Publisher Backend**
> A local FastAPI server that orchestrates the full pipeline: raw video → privacy filter → zk-SNARK proof → blockchain.

---

## Architecture

```
 [Raw Video]
      │
      │  POST /upload
      ▼
 ┌─────────────┐
 │   main.py   │  FastAPI orchestrator
 │  (router)   │
 └──────┬──────┘
        │  background task
        ▼
 ┌──────────────────────┐
 │  video_processor.py  │
 │                      │──► OpenCV: extract frames
 │  VideoProcessor       │──► onnxruntime: predict pixelation per frame
 │                      │──► OpenCV: apply pixelation + write video
 │                      │──► EZKL: proof_generator.py (subprocess)
 └──────────────────────┘
        │
        │  (blurred_video.mp4  +  proof.json  +  video_hash)
        ▼
 ┌────────────────────────┐
 │  blockchain_publisher  │──► web3.py: connect to RPC
 │                        │──► Parse proof.json (bytes + instances)
 │  BlockchainPublisher   │──► Compute SHA-256(blurred_video)
 │                        │──► Sign & send publishVideo() tx
 └────────────────────────┘
        │
        │  tx_hash + receipt
        ▼
  GET /export → ZIP (blurred_video.mp4 + proof.json + metadata.json)
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/upload` | Upload raw video → returns `job_id` |
| `POST` | `/process/{job_id}` | Start full pipeline (add `?publish=false` to skip chain) |
| `GET` | `/status/{job_id}` | Poll job progress |
| `GET` | `/export/{job_id}` | Download ZIP when `status=done` |
| `GET` | `/jobs` | List all jobs in session |
| `GET` | `/` | Health check |

---

## Quick Start

### Prerequisites

### 1. Install

```bash
cd local-backend
pip install -r requirements.txt
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env — at minimum set WEB3_RPC_URL and PUBLISHER_PRIVATE_KEY
```

### 3. Start a local blockchain (if testing locally)

```bash
# Terminal 1
cd ../smart-contracts
npm run node

# Terminal 2
npm run deploy:local
```

### 4. Run the backend

```bash
uvicorn main:app --reload --port 8000
```

API docs available at: **http://localhost:8000/docs**

---

## Full Pipeline Walk-through

```bash
# 1. Upload your video
curl -X POST http://localhost:8000/upload \
     -F "file=@/path/to/raw_video.mp4"
# → {"job_id": "abc123…", "filename": "raw_video.mp4", …}

# 2. Start the pipeline (with blockchain publish)
curl -X POST http://localhost:8000/process/abc123

# 3. Poll until done
curl http://localhost:8000/status/abc123
# → {"status": "done", "video_hash": "0x…", "tx_hash": "0x…"}

# 4. Download the export ZIP
curl -OJ http://localhost:8000/export/abc123
```

---

## File Layout

```
local-backend/
├── main.py               ← FastAPI routes & job store
├── video_processor.py    ← OpenCV + ONNX + EZKL proof pipeline
├── blockchain_publisher.py ← web3.py transaction signing
├── requirements.txt
├── .env.example
├── uploads/              ← raw uploaded videos (auto-created)
└── output/
    └── <job_id>/
        ├── blurred_video.mp4
        ├── proof.json
        ├── keyframe.png
        ├── ezkl_input.json
        └── video_hash.txt
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WEB3_RPC_URL` | `http://127.0.0.1:8545` | Ethereum RPC endpoint |
| `PUBLISHER_PRIVATE_KEY` | *(required)* | Wallet key for signing txs |
| `CHAIN_ID` | `1337` | Network chain ID |
| `NETWORK_NAME` | `localhost` | Must match `deployments/<name>.json` |
| `ZKML_ENGINE_DIR` | `../zkml-engine` | Path to Phase 1 engine |
| `CONTRACTS_DIR` | `../smart-contracts` | Path to Phase 2 contracts |
| `GAS_LIMIT` | `800000` | Gas limit for `publishVideo` tx |

---

## Job Status Flow

```
PENDING → PROCESSING → PUBLISHING → DONE
                    ↘
                     FAILED  (error field populated)
```

---

## Notes on the Proof Parser

EZKL `proof.json` varies slightly across versions. `blockchain_publisher.py` handles:
- `proof` as hex string (`"0xabc…"`)
- `proof` as list of byte ints
- `instances` as nested lists of hex strings or plain ints

---