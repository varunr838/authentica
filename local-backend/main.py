"""
main.py  —  Authentica Phase 3
================================
FastAPI application — the orchestrator that bridges raw video,
the zkML proof engine, and the Ethereum blockchain.

Endpoints
---------
  POST /upload           Accept a raw video file upload.
  POST /process/{job_id} Trigger the full pipeline:
                           • OpenCV pixelation filter (via video_processor.py)
                           • EZKL proof generation  (via proof_generator.py)
                           • Blockchain publication (via blockchain_publisher.py)
  GET  /status/{job_id}  Poll job progress / result.
  GET  /export/{job_id}  Download blurred_video.mp4 + proof.json as a ZIP.

Run
---
  uvicorn main:app --reload --port 8000
"""
# --- Add these imports at the top of main.py ---
from __future__ import annotations
import hashlib
from sqlalchemy.orm import Session
from fastapi import Depends

import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from database import models
from database.database import engine, get_db

models.Base.metadata.create_all(bind=engine)


import asyncio
import io
import logging
import pathlib
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from enum import Enum
from typing import Optional

import aiofiles
from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    HTTPException,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from video_processor import process_video_async
from blockchain_publisher import publish_async

load_dotenv()

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(name)-35s  %(levelname)-8s  %(message)s",
)
logger = logging.getLogger("authentica.main")

# ── Paths ─────────────────────────────────────────────────────────────────────
_HERE      = pathlib.Path(__file__).parent
UPLOAD_DIR = _HERE / "uploads"
OUTPUT_DIR = _HERE / "output"
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# ── Models ────────────────────────────────────────────────────────────────────
class JobStatus(str, Enum):
    PENDING    = "pending"
    PROCESSING = "processing"
    PUBLISHING = "publishing"
    DONE       = "done"
    FAILED     = "failed"


class JobRecord(BaseModel):
    job_id:       str
    status:       JobStatus        = JobStatus.PENDING
    filename:     str              = ""
    raw_path:     str              = ""
    created_at:   float            = 0.0
    updated_at:   float            = 0.0
    # Populated after processing
    blurred_video: Optional[str]   = None
    proof_json:    Optional[str]   = None
    video_hash:    Optional[str]   = None
    frame_count:   Optional[int]   = None
    # Populated after blockchain publish
    tx_hash:       Optional[str]   = None
    block_number:  Optional[int]   = None
    gas_used:      Optional[int]   = None
    error:         Optional[str]   = None

    class Config:
        use_enum_values = True


class UploadResponse(BaseModel):
    job_id:   str
    filename: str
    size_mb:  float
    message:  str


class ProcessResponse(BaseModel):
    job_id:  str
    status:  str
    message: str


class StatusResponse(BaseModel):
    job_id:       str
    status:       str
    video_hash:   Optional[str]   = None
    tx_hash:      Optional[str]   = None
    block_number: Optional[int]   = None
    gas_used:     Optional[int]   = None
    frame_count:  Optional[int]   = None
    error:        Optional[str]   = None


# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Authentica Publisher Backend starting …")
    logger.info("Upload dir  : %s", UPLOAD_DIR)
    logger.info("Output dir  : %s", OUTPUT_DIR)
    yield
    logger.info("Authentica Publisher Backend shutting down.")


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title       = "Authentica — Publisher Backend",
    description = (
        "Phase 3 orchestrator: upload raw video → apply privacy filter → "
        "generate zk-SNARK proof → publish to blockchain."
    ),
    version     = "1.0.0",
    lifespan    = lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins     = ["*"],
    allow_credentials = True,
    allow_methods     = ["*"],
    allow_headers     = ["*"],
)


# ── Internal helpers ──────────────────────────────────────────────────────────
def _get_job(job_id: str) -> JobRecord:
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job '{job_id}' not found.",
        )
    return job


def _update_job(job: JobRecord, **kwargs) -> None:
    for k, v in kwargs.items():
        setattr(job, k, v)
    job.updated_at = time.time()


# ── Background pipeline task ──────────────────────────────────────────────────
async def _run_pipeline(job: JobRecord, publish: bool) -> None:
    """
    Full async pipeline for one job:
      1. video_processor.py  → blurred video + proof.json
      2. blockchain_publisher.py → on-chain tx  (if publish=True)
    Runs as a FastAPI BackgroundTask.
    """
    try:
        # ── Step 1: Video processing + proof generation ────────────────────
        _update_job(job, status=JobStatus.PROCESSING)
        logger.info("[%s] Starting video processing …", job.job_id)

        result = await process_video_async(
            raw_video_path=pathlib.Path(job.raw_path),
            job_id=job.job_id,
        )

        _update_job(
            job,
            blurred_video = result["blurred_video"],
            proof_json    = result["proof_json"],
            video_hash    = result["video_hash"],
            frame_count   = result["frame_count"],
        )
        logger.info("[%s] Video processing complete.", job.job_id)

        # ── Step 2: Blockchain publication ─────────────────────────────────
        if publish:
            _update_job(job, status=JobStatus.PUBLISHING)
            logger.info("[%s] Publishing to blockchain …", job.job_id)

            bc_result = await publish_async(
                proof_json_path    = pathlib.Path(result["proof_json"]),
                blurred_video_path = pathlib.Path(result["blurred_video"]),
            )
            _update_job(
                job,
                tx_hash      = bc_result["tx_hash"],
                block_number = bc_result["block_number"],
                gas_used     = bc_result["gas_used"],
            )
            logger.info("[%s] Blockchain tx: %s", job.job_id, bc_result["tx_hash"])

        _update_job(job, status=JobStatus.DONE)
        logger.info("[%s] Pipeline complete.", job.job_id)

    except Exception as exc:
        logger.exception("[%s] Pipeline failed: %s", job.job_id, exc)
        _update_job(job, status=JobStatus.FAILED, error=str(exc))


# ── Routes ────────────────────────────────────────────────────────────────────

# ── POST /upload ──────────────────────────────────────────────────────────────
@app.post(
    "/upload",
    response_model = UploadResponse,
    status_code    = status.HTTP_201_CREATED,
    summary        = "Upload a raw video file",
    tags           = ["pipeline"],
)
async def upload_video(file: UploadFile = File(...)) -> UploadResponse:
    """
    Accept a raw video (MP4, AVI, MOV, MKV).
    Returns a `job_id` that is used in all subsequent calls.

    The file is saved to `uploads/<job_id>_<filename>` and a JobRecord
    is created in the in-memory job store.
    """
    allowed = {".mp4", ".avi", ".mov", ".mkv", ".webm"}
    suffix  = pathlib.Path(file.filename or "video.mp4").suffix.lower()
    if suffix not in allowed:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file type '{suffix}'. Allowed: {allowed}",
        )

    job_id   = str(uuid.uuid4())
    safe_name = f"{job_id}{suffix}"
    dest      = UPLOAD_DIR / safe_name

    # Stream to disk asynchronously
    async with aiofiles.open(dest, "wb") as out:
        while chunk := await file.read(1 << 20):   # 1 MB chunks
            await out.write(chunk)

    size_mb = dest.stat().st_size / (1024 ** 2)
    now     = time.time()

    job = JobRecord(
        job_id     = job_id,
        status     = JobStatus.PENDING,
        filename   = file.filename or safe_name,
        raw_path   = str(dest),
        created_at = now,
        updated_at = now,
    )
    _JOBS[job_id] = job
    logger.info("Uploaded %s (%.2f MB) → job=%s", file.filename, size_mb, job_id)

    return UploadResponse(
        job_id   = job_id,
        filename = file.filename or safe_name,
        size_mb  = round(size_mb, 3),
        message  = (
            f"Video uploaded successfully. "
            f"Call POST /process/{job_id} to start the pipeline."
        ),
    )


# ── POST /process/{job_id} ────────────────────────────────────────────────────
@app.post(
    "/process/{job_id}",
    response_model = ProcessResponse,
    summary        = "Trigger the full pipeline for an uploaded video",
    tags           = ["pipeline"],
)
async def process_video(
    job_id:           str,
    background_tasks: BackgroundTasks,
    publish:          bool = True,
) -> ProcessResponse:
    """
    Trigger the full pipeline:
      1. OpenCV pixelation filter + ONNX model inference
      2. EZKL zk-SNARK proof generation
      3. (Optional) Blockchain publication — set `?publish=false` to skip

    The pipeline runs as a background task.
    Poll `GET /status/{job_id}` to check progress.
    """
    job = _get_job(job_id)

    if job.status not in (JobStatus.PENDING, JobStatus.FAILED):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Job '{job_id}' is already in status '{job.status}'. "
                "Cannot re-trigger a running or completed job."
            ),
        )

    background_tasks.add_task(_run_pipeline, job, publish)

    return ProcessResponse(
        job_id  = job_id,
        status  = JobStatus.PROCESSING,
        message = (
            "Pipeline started in background. "
            f"Poll GET /status/{job_id} for progress. "
            + ("Blockchain publication enabled." if publish else "Blockchain publication SKIPPED.")
        ),
    )


# ── GET /status/{job_id} ──────────────────────────────────────────────────────
@app.get(
    "/status/{job_id}",
    response_model = StatusResponse,
    summary        = "Poll the status of a pipeline job",
    tags           = ["pipeline"],
)
async def get_status(job_id: str) -> StatusResponse:
    """
    Returns the current status of the job.

    Status values: `pending` → `processing` → `publishing` → `done` | `failed`
    """
    job = _get_job(job_id)
    return StatusResponse(
        job_id       = job.job_id,
        status       = job.status,
        video_hash   = job.video_hash,
        tx_hash      = job.tx_hash,
        block_number = job.block_number,
        gas_used     = job.gas_used,
        frame_count  = job.frame_count,
        error        = job.error,
    )


# ── GET /export/{job_id} ──────────────────────────────────────────────────────
@app.get(
    "/export/{job_id}",
    summary = "Download the output ZIP (blurred video + proof.json)",
    tags    = ["pipeline"],
)
async def export_artifacts(job_id: str) -> StreamingResponse:
    """
    Returns a ZIP file containing:
      • `blurred_video.mp4`  — the privacy-filtered video
      • `proof.json`         — the zk-SNARK proof (submit this on-chain)
      • `metadata.json`      — job summary (video hash, tx hash, timestamps)

    Only available once the job status is `done`.
    """
    job = _get_job(job_id)

    if job.status != JobStatus.DONE:
        raise HTTPException(
            status_code=status.HTTP_425_TOO_EARLY,
            detail=(
                f"Job '{job_id}' is not complete yet (status='{job.status}'). "
                "Wait for status=done before exporting."
            ),
        )

    # Validate files exist
    blurred = pathlib.Path(job.blurred_video)
    proof   = pathlib.Path(job.proof_json)
    for p in (blurred, proof):
        if not p.exists():
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Expected output file not found: {p}",
            )

    # Build metadata.json content
    import json as _json
    metadata = {
        "job_id":       job.job_id,
        "filename":     job.filename,
        "video_hash":   job.video_hash,
        "frame_count":  job.frame_count,
        "tx_hash":      job.tx_hash,
        "block_number": job.block_number,
        "gas_used":     job.gas_used,
        "created_at":   job.created_at,
        "exported_at":  time.time(),
    }

    # Stream ZIP into memory
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(blurred, "blurred_video.mp4")
        zf.write(proof,   "proof.json")
        zf.writestr("metadata.json", _json.dumps(metadata, indent=2))
    zip_buffer.seek(0)

    filename = f"authentica_export_{job_id[:8]}.zip"
    logger.info("Exporting artifacts for job %s → %s", job_id, filename)

    return StreamingResponse(
        zip_buffer,
        media_type = "application/zip",
        headers    = {"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── GET /jobs ─────────────────────────────────────────────────────────────────
@app.get(
    "/jobs",
    summary = "List all jobs",
    tags    = ["admin"],
)
async def list_jobs() -> JSONResponse:
    """Returns a summary of all pipeline jobs in the current session."""
    return JSONResponse(
        content={
            "total": len(_JOBS),
            "jobs": [
                {
                    "job_id":     j.job_id,
                    "status":     j.status,
                    "filename":   j.filename,
                    "video_hash": j.video_hash,
                    "tx_hash":    j.tx_hash,
                    "created_at": j.created_at,
                }
                for j in _JOBS.values()
            ],
        }
    )


# ── GET / (health check) ──────────────────────────────────────────────────────
@app.get("/", tags=["health"])
async def health() -> dict:
    return {
        "service": "Authentica Publisher Backend",
        "phase":   3,
        "status":  "ok",
        "jobs":    len(_JOBS),
    }


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    import os

    uvicorn.run(
        "main:app",
        host    = os.getenv("HOST", "0.0.0.0"),
        port    = int(os.getenv("PORT", "8000")),
        reload  = True,
        log_level = "info",
    )
