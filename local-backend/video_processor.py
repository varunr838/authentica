"""
video_processor.py  —  Authentica Phase 3
==========================================
Handles all OpenCV video work:

  1. Extract every frame from the raw input video.
  2. For each frame, run the ONNX PixelationFilter model to predict
     the required pixelation intensity.
  3. Apply a pixelation effect proportional to the model output.
  4. Rebuild the video from the processed frames and save as
     output/blurred_video.mp4.

The module is also the bridge to the EZKL proof generator:
  5. Pick one representative "key-frame" (the middle frame), build an
     EZKL input.json from it, and call proof_generator.py to produce
     output/proof.json.

Design notes
------------
- Intentionally synchronous — FastAPI runs it in a thread pool via
  `asyncio.to_thread()` so the event loop stays free.
- The ONNX model (network.onnx) runs locally; no GPU required.
- Frame resize → 16×16 greyscale (matching the Phase 1 model spec).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import pathlib
import shutil
import subprocess
import sys
import tempfile
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger("authentica.video_processor")

# ── Paths ─────────────────────────────────────────────────────────────────────
_HERE          = pathlib.Path(__file__).parent
ZKML_DIR       = (_HERE / ".." / "zkml-engine").resolve()
ARTIFACTS_DIR  = ZKML_DIR / "artifacts"
ONNX_MODEL     = ARTIFACTS_DIR / "network.onnx"
OUTPUT_DIR     = _HERE / "output"

# Match Phase 1 model spec exactly
_PATCH_H   = 16
_PATCH_W   = 16
_CHANNELS  = 1          # greyscale
_N_CLASSES = 16         # pixelation intensity bins


# ── ONNX session (lazy singleton) ────────────────────────────────────────────
_ort_session: Any = None


def _get_ort_session() -> Any:
    global _ort_session
    if _ort_session is None:
        try:
            import onnxruntime as ort
        except ImportError:
            raise RuntimeError(
                "onnxruntime not installed. Run: pip install onnxruntime"
            )
        if not ONNX_MODEL.exists():
            raise FileNotFoundError(
                f"ONNX model not found at {ONNX_MODEL}. "
                "Run `python model_export.py` in zkml-engine/ first."
            )
        _ort_session = ort.InferenceSession(str(ONNX_MODEL))
        logger.info("ONNX session loaded from %s", ONNX_MODEL)
    return _ort_session


# ── Frame preprocessing ───────────────────────────────────────────────────────
def _preprocess_frame(frame_bgr: np.ndarray) -> np.ndarray:
    """
    BGR frame → float32 tensor of shape (1, 1, 16, 16) normalised to [-1, 1].
    Matches the preprocessing in model_export.py / proof_generator.py.
    """
    grey    = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    resized = cv2.resize(grey, (_PATCH_W, _PATCH_H), interpolation=cv2.INTER_AREA)
    tensor  = (resized.astype(np.float32) / 127.5) - 1.0
    return tensor[np.newaxis, np.newaxis, :, :]          # (1, 1, 16, 16)


# ── Model inference ───────────────────────────────────────────────────────────
def _predict_intensity(frame_bgr: np.ndarray) -> int:
    """
    Run the PixelationFilter model on a frame.
    Returns the argmax class [0..15] — higher = more pixelation needed.
    """
    session  = _get_ort_session()
    tensor   = _preprocess_frame(frame_bgr)
    outputs  = session.run(None, {"input": tensor})
    logits   = outputs[0][0]                             # shape (16,)
    return int(np.argmax(logits))


# ── Pixelation effect ─────────────────────────────────────────────────────────
def _apply_pixelation(frame_bgr: np.ndarray, intensity: int) -> np.ndarray:
    """
    Apply a privacy pixelation effect to the frame.

    intensity 0      → no change
    intensity 1–4    → mild blur (Gaussian)
    intensity 5–9    → moderate pixel-block effect
    intensity 10–15  → heavy pixel-block effect
    """
    if intensity == 0:
        return frame_bgr

    h, w = frame_bgr.shape[:2]

    if intensity <= 4:
        # Gaussian blur proportional to intensity
        ksize = max(3, intensity * 4 + 1) | 1      # must be odd
        return cv2.GaussianBlur(frame_bgr, (ksize, ksize), 0)

    # Pixel-block (mosaic) effect
    # Block size scales linearly: intensity 5 → 8px, 15 → 40px
    block = max(4, int((intensity - 4) * 3.5))
    small = cv2.resize(frame_bgr, (max(1, w // block), max(1, h // block)),
                       interpolation=cv2.INTER_LINEAR)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)


# ── Core pipeline ─────────────────────────────────────────────────────────────
class VideoProcessor:
    """
    Orchestrates the full video-processing pipeline for one job.

    Usage:
        vp = VideoProcessor(raw_video_path, job_id)
        result = vp.run()          # synchronous — run via asyncio.to_thread()
    """

    def __init__(self, raw_video_path: pathlib.Path, job_id: str) -> None:
        self.raw_path   = pathlib.Path(raw_video_path)
        self.job_id     = job_id
        self.job_dir    = OUTPUT_DIR / job_id
        self.job_dir.mkdir(parents=True, exist_ok=True)

        self.blurred_path   = self.job_dir / "blurred_video.mp4"
        self.keyframe_path  = self.job_dir / "keyframe.png"
        self.input_json     = self.job_dir / "ezkl_input.json"
        self.proof_json     = self.job_dir / "proof.json"
        self.video_hash_txt = self.job_dir / "video_hash.txt"

    # ── Step 1: read video ────────────────────────────────────────────────────
    def _open_video(self) -> tuple[cv2.VideoCapture, dict]:
        cap = cv2.VideoCapture(str(self.raw_path))
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {self.raw_path}")

        meta = {
            "fps":        cap.get(cv2.CAP_PROP_FPS) or 25.0,
            "width":  int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            "total":  int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
        }
        logger.info(
            "Opened video: %dx%d @ %.1f fps, %d frames",
            meta["width"], meta["height"], meta["fps"], meta["total"]
        )
        return cap, meta

    # ── Step 2: process frames ────────────────────────────────────────────────
    def _process_frames(
        self,
        cap: cv2.VideoCapture,
        meta: dict,
        writer: cv2.VideoWriter,
    ) -> tuple[np.ndarray, int]:
        """
        Read → infer → apply pixelation → write each frame.
        Returns the keyframe (middle frame) and its frame index.
        """
        total        = meta["total"] if meta["total"] > 0 else float("inf")
        keyframe_idx = max(0, (meta["total"] - 1) // 2)
        keyframe     = None
        idx          = 0

        while True:
            ok, frame = cap.read()
            if not ok:
                break

            intensity     = _predict_intensity(frame)
            blurred_frame = _apply_pixelation(frame, intensity)
            writer.write(blurred_frame)

            if idx == keyframe_idx:
                keyframe = frame.copy()
                cv2.imwrite(str(self.keyframe_path), blurred_frame)
                logger.debug("Saved keyframe at index %d (intensity=%d)", idx, intensity)

            if (idx + 1) % 30 == 0:
                logger.info("Processed %d / %s frames", idx + 1, total)

            idx += 1

        if keyframe is None:
            raise RuntimeError("Video contained no readable frames.")

        logger.info("Finished processing %d frames", idx)
        return keyframe, keyframe_idx

    # ── Step 3: build EZKL input.json ─────────────────────────────────────────
    def _build_ezkl_input(self, keyframe: np.ndarray) -> None:
        """
        Serialise the keyframe into the JSON format EZKL expects.
        The proof will be generated for this specific frame.
        """
        tensor = _preprocess_frame(keyframe)          # (1, 1, 16, 16) float32
        payload = {
            "input_shapes": [[_CHANNELS, _PATCH_H, _PATCH_W]],
            "input_data":   [tensor.flatten().tolist()],
        }
        with open(self.input_json, "w") as fh:
            json.dump(payload, fh, indent=2)
        logger.info("EZKL input JSON → %s", self.input_json)

    # ── Step 4: generate zk-SNARK proof ───────────────────────────────────────
    def _generate_proof(self) -> None:
        """
        Invoke proof_generator.py as a subprocess (same Python interpreter).
        The script reads the compiled circuit artefacts and the input.json we
        just built, then writes proof.json to the zkml-engine/artifacts dir.
        We copy the result into our job directory.
        """
        proof_script = ZKML_DIR / "proof_generator.py"
        if not proof_script.exists():
            raise FileNotFoundError(
                f"proof_generator.py not found at {proof_script}."
            )

        cmd = [
            sys.executable,
            str(proof_script),
            "--json", str(self.input_json),
            "--verify",
        ]
        logger.info("Invoking proof_generator: %s", " ".join(cmd))
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(ZKML_DIR),
        )

        if result.returncode != 0:
            logger.error("proof_generator stderr:\n%s", result.stderr)
            raise RuntimeError(
                f"Proof generation failed (exit {result.returncode}):\n"
                + result.stderr[-2000:]
            )

        logger.info("Proof generator stdout:\n%s", result.stdout[-1000:])

        # Copy proof from zkml-engine/artifacts/ → job dir
        src = ARTIFACTS_DIR / "proof.json"
        if not src.exists():
            raise FileNotFoundError(f"proof.json not produced at {src}")
        shutil.copy2(src, self.proof_json)
        logger.info("Proof copied → %s", self.proof_json)

    # ── Step 5: hash the blurred video ────────────────────────────────────────
    def _hash_video(self) -> str:
        """
        Compute SHA-256 of the blurred_video.mp4 byte-for-byte.
        Returns the hex digest (64-char string).
        Saves to video_hash.txt for the blockchain publisher.
        """
        sha256 = hashlib.sha256()
        with open(self.blurred_path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                sha256.update(chunk)
        digest = sha256.hexdigest()
        self.video_hash_txt.write_text(digest)
        logger.info("SHA-256 of blurred video: %s", digest)
        return digest

    # ── Orchestrator ──────────────────────────────────────────────────────────
    def run(self) -> dict:
        """
        Execute the full pipeline synchronously.

        Returns a result dict consumed by main.py:
        {
            "job_id":         str,
            "blurred_video":  str (path),
            "proof_json":     str (path),
            "keyframe":       str (path),
            "video_hash":     str (hex SHA-256),
            "frame_count":    int,
        }
        """
        logger.info("=== VideoProcessor.run() | job=%s ===", self.job_id)

        # 1. Open source video
        cap, meta = self._open_video()

        # 2. Setup VideoWriter for blurred output
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(
            str(self.blurred_path),
            fourcc,
            meta["fps"],
            (meta["width"], meta["height"]),
        )
        if not writer.isOpened():
            cap.release()
            raise RuntimeError("cv2.VideoWriter failed to open — check codec support.")

        try:
            # 3. Process frames
            keyframe, _ = self._process_frames(cap, meta, writer)
        finally:
            cap.release()
            writer.release()

        # 4. EZKL input + proof
        self._build_ezkl_input(keyframe)
        self._generate_proof()

        # 5. Hash the blurred output
        video_hash = self._hash_video()

        return {
            "job_id":        self.job_id,
            "blurred_video": str(self.blurred_path),
            "proof_json":    str(self.proof_json),
            "keyframe":      str(self.keyframe_path),
            "video_hash":    video_hash,
            "frame_count":   meta["total"],
        }


# ── Convenience async wrapper ─────────────────────────────────────────────────
async def process_video_async(
    raw_video_path: pathlib.Path,
    job_id: str,
) -> dict:
    """Run VideoProcessor.run() in a thread pool so FastAPI stays async."""
    processor = VideoProcessor(raw_video_path, job_id)
    return await asyncio.to_thread(processor.run)
