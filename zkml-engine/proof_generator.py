"""
proof_generator.py  —  Authentica Phase 1
==========================================
Used by the backend at inference time.

Given a raw image frame (PNG/JPG or a raw tensor), this script:

  1. Pre-processes the image into the same tensor format the circuit expects.
  2. Writes a witness input JSON.
  3. Calls EZKL to generate the witness (execution trace).
  4. Calls EZKL to generate the zk-SNARK proof.
  5. Optionally verifies the proof locally before handing it off.

Outputs written to artifacts/
  witness.json   — the full witness (private execution trace)
  proof.json     — the final zk-SNARK proof  ← what the backend sends on-chain

Usage
-----
  # Use a real image (PNG / JPG)
  python proof_generator.py --image path/to/frame.png

  # Use a pre-built input.json (e.g. the sample from model_export.py)
  python proof_generator.py --json artifacts/input.json

  # Verify the generated proof locally after generation
  python proof_generator.py --image frame.png --verify
"""

import argparse
import asyncio
import json
import pathlib
import sys
import time

if sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

import numpy as np

try:
    import ezkl
except ImportError:
    print("\n[ERROR] ezkl not installed — run: pip install ezkl\n")
    sys.exit(1)

try:
    from rich.console import Console
    from rich.panel import Panel
    console = Console()
    def log(msg, style="cyan"):
        console.print(f"  [bold {style}]▶[/bold {style}] {msg}")
    def success(msg):
        console.print(f"  [bold green]✓[/bold green] {msg}")
    def warn(msg):
        console.print(f"  [bold yellow]⚠[/bold yellow] {msg}")
    def err(msg):
        console.print(f"  [bold red]✗[/bold red] {msg}")
    def header(title):
        console.print(Panel(f"[bold white]{title}[/bold white]", style="blue"))
except ImportError:
    def log(msg, style=""): print(f"  ▶ {msg}")
    def success(msg): print(f"  ✓ {msg}")
    def warn(msg): print(f"  ⚠ {msg}")
    def err(msg): print(f"  ✗ {msg}")
    def header(title): print(f"\n{'='*60}\n  {title}\n{'='*60}")


# ── Paths ─────────────────────────────────────────────────────────────────────
ARTIFACT_DIR    = pathlib.Path(__file__).parent / "artifacts"
COMPILED_MODEL  = ARTIFACT_DIR / "model.compiled"
SETTINGS_JSON   = ARTIFACT_DIR / "settings.json"
PK_PATH         = ARTIFACT_DIR / "pk.key"
VK_PATH         = ARTIFACT_DIR / "vk.key"
SRS_PATH        = ARTIFACT_DIR / "srs.params"
WITNESS_JSON    = ARTIFACT_DIR / "witness.json"
PROOF_JSON      = ARTIFACT_DIR / "proof.json"

# Model input spec — must match model_export.py
PATCH_H, PATCH_W = 16, 16
IN_CHANNELS      = 1       # greyscale


# ── Helpers ───────────────────────────────────────────────────────────────────
def _check_compiled_artefacts():
    required = [COMPILED_MODEL, SETTINGS_JSON, PK_PATH, VK_PATH, SRS_PATH]
    missing  = [str(p) for p in required if not p.exists()]
    if missing:
        err("Missing compiled artefacts — run python zk_compiler.py first:")
        for m in missing:
            err(f"  {m}")
        sys.exit(1)


class _Timed:
    def __init__(self, label):
        self.label = label
    def __enter__(self):
        self._t = time.perf_counter()
        return self
    def __exit__(self, *_):
        elapsed = time.perf_counter() - self._t
        success(f"{self.label} completed in {elapsed:.2f}s")


# ── Image → input tensor ──────────────────────────────────────────────────────
def image_to_tensor(image_path: str) -> np.ndarray:
    """
    Load an image (any format PIL supports), convert to greyscale,
    resize to PATCH_H × PATCH_W, and normalise to [-1, 1].
    Returns ndarray of shape (1, IN_CHANNELS, PATCH_H, PATCH_W).
    """
    try:
        from PIL import Image
    except ImportError:
        err("Pillow not installed — run: pip install Pillow")
        sys.exit(1)

    img = Image.open(image_path).convert("L")          # greyscale
    img = img.resize((PATCH_W, PATCH_H), Image.LANCZOS)
    arr = np.array(img, dtype=np.float32) / 127.5 - 1.0  # [-1, 1]
    return arr[np.newaxis, np.newaxis, :, :]             # (1,1,H,W)


# ── Build input JSON ──────────────────────────────────────────────────────────
def build_input_json(tensor: np.ndarray, out_path: pathlib.Path) -> None:
    """
    Serialise the input tensor to the JSON format EZKL expects:
      { "input_shapes": [...], "input_data": [[...flattened floats...]] }
    """
    payload = {
        "input_shapes": [[IN_CHANNELS, PATCH_H, PATCH_W]],
        "input_data":   [tensor.flatten().tolist()],
    }
    with open(out_path, "w") as fh:
        json.dump(payload, fh, indent=2)
    log(f"Input JSON written → {out_path}")


# ── EZKL proof pipeline ───────────────────────────────────────────────────────
async def generate_witness(input_json: pathlib.Path) -> None:
    """
    Gen-witness: run the arithmetic circuit on the inputs and record every
    intermediate value (the witness / execution trace).
    This is the private data — never shared with the verifier.
    """
    log("Generating witness (execution trace) …")
    with _Timed("gen_witness"):
        res = ezkl.gen_witness(
            data=str(input_json),
            model=str(COMPILED_MODEL),
            output=str(WITNESS_JSON),
        )
    if not res:
        err("gen_witness returned False — check inputs and compiled circuit.")
        sys.exit(1)
    success(f"Witness → {WITNESS_JSON}")


async def generate_proof() -> None:
    """
    Prove: use the witness + proving key to generate the zk-SNARK proof.
    The proof is a short cryptographic object (typically a few KB) that
    mathematically certifies the computation was executed correctly.
    """
    log("Generating zk-SNARK proof …  (this is the slow step)")
    with _Timed("prove"):
        res = ezkl.prove(
            witness=str(WITNESS_JSON),
            model=str(COMPILED_MODEL),
            pk_path=str(PK_PATH),
            proof_path=str(PROOF_JSON),
            srs_path=str(SRS_PATH),
        )
    if not res:
        err("prove returned False — check witness and keys.")
        sys.exit(1)
    proof_size = PROOF_JSON.stat().st_size / 1024
    success(f"Proof → {PROOF_JSON}  ({proof_size:.1f} KB)")


async def verify_proof_local() -> bool:
    """
    Local verification — mirrors what the on-chain Solidity contract does.
    Returns True if the proof is valid.
    """
    log("Verifying proof locally …")
    with _Timed("verify"):
        valid = ezkl.verify(
            proof_path=str(PROOF_JSON),
            settings_path=str(SETTINGS_JSON),
            vk_path=str(VK_PATH),
            srs_path=str(SRS_PATH),
        )
    if valid:
        success("LOCAL VERIFICATION PASSED ✓  — proof is cryptographically valid.")
    else:
        err("LOCAL VERIFICATION FAILED ✗  — proof may be corrupted or tampered.")
    return valid


def summarise_proof() -> None:
    """Print key fields from proof.json for human inspection."""
    header("Proof Summary")
    with open(PROOF_JSON) as fh:
        proof = json.load(fh)

    instances = proof.get("instances", [])
    log(f"Public instances (outputs): {len(instances)} element(s)")
    for i, inst in enumerate(instances[:3]):       # show first 3 only
        log(f"  [{i}] {str(inst)[:80]} …")

    transcript_len = len(str(proof.get("proof", "")))
    log(f"Proof transcript length: {transcript_len} chars")
    log("This proof.json is what the backend submits to the on-chain verifier.")


# ── Entry point ───────────────────────────────────────────────────────────────
async def main(image_path=None, input_json_path=None, do_verify=False):
    header("Authentica — Phase 1: Proof Generator")
    log(f"EZKL version: {ezkl.__version__}")
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    _check_compiled_artefacts()

    # ── Resolve input ─────────────────────────────────────────────────────
    if image_path:
        log(f"Loading image: {image_path}")
        tensor     = image_to_tensor(image_path)
        input_json = ARTIFACT_DIR / "proof_input.json"
        build_input_json(tensor, input_json)
    elif input_json_path:
        input_json = pathlib.Path(input_json_path)
        if not input_json.exists():
            err(f"Input JSON not found: {input_json}")
            sys.exit(1)
        log(f"Using existing input JSON: {input_json}")
    else:
        # Fall back to the sample input from model_export.py
        sample = ARTIFACT_DIR / "input.json"
        if not sample.exists():
            err("No input provided and artifacts/input.json not found.")
            err("Run with --image <path> or --json <path>")
            sys.exit(1)
        warn(f"No input specified — using sample: {sample}")
        input_json = sample

    # ── Pipeline ──────────────────────────────────────────────────────────
    header("Step 1/2 — Generate Witness")
    await generate_witness(input_json)

    header("Step 2/2 — Generate Proof")
    await generate_proof()

    # ── Optional local verification ───────────────────────────────────────
    if do_verify:
        header("Optional — Local Proof Verification")
        await verify_proof_local()

    summarise_proof()

    header("Done")
    log(f"proof.json path: {PROOF_JSON}", style="green")
    log("The backend can now submit this proof to the on-chain verifier.", style="green")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Authentica Phase 1 — generate a zk-SNARK proof for a media frame"
    )
    grp = parser.add_mutually_exclusive_group()
    grp.add_argument("--image", metavar="PATH",
                     help="Path to an input image (PNG/JPG). Resized to 16×16 greyscale.")
    grp.add_argument("--json", metavar="PATH",
                     help="Path to a pre-built EZKL input JSON file.")
    parser.add_argument("--verify", action="store_true",
                        help="Run local proof verification after generation.")
    args = parser.parse_args()

    asyncio.run(main(
        image_path=args.image,
        input_json_path=args.json,
        do_verify=args.verify,
    ))
