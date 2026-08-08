"""
zk_compiler.py  --  Authentica Phase 1
======================================
Reads  artifacts/network.onnx  and  artifacts/input.json  then drives
EZKL to produce:

  artifacts/
    settings.json      -- circuit parameters (scale, logrows ...)
    model.compiled     -- compiled arithmetic circuit
    srs.params         -- Structured Reference String (KZG trusted setup)
    pk.key             -- proving key
    vk.key             -- verification key
    verifier.sol       -- EVM-compatible Solidity verifier contract
    verifier_abi.json  -- ABI for the verifier contract

EZKL 23.x compatibility
------------------------
  In EZKL >= 20, calibrate_settings() and get_srs() are plain synchronous
  functions (return bool), NOT coroutines. Using `await` on them raises:
    TypeError: object bool can't be used in 'await' expression
  This script calls all EZKL functions synchronously and uses asyncio only
  where actually needed.

Each step is guarded so the script is idempotent (re-running skips
artefacts that already exist). Pass --force to rebuild everything.

Usage
-----
  python zk_compiler.py
  python zk_compiler.py --force
"""

import argparse
import asyncio
import json
import pathlib
import sys
import time

try:
    import ezkl
except ImportError:
    print("\n[ERROR] ezkl is not installed.\n  pip install ezkl\n")
    sys.exit(1)

try:
    from rich.console import Console
    from rich.panel import Panel
    console = Console()
    def log(msg, style="cyan"):
        console.print(f"  [bold {style}]>[/bold {style}] {msg}")
    def success(msg):
        console.print(f"  [bold green]OK[/bold green] {msg}")
    def warn(msg):
        console.print(f"  [bold yellow]!![/bold yellow] {msg}")
    def err(msg):
        console.print(f"  [bold red]ERR[/bold red] {msg}")
    def header(title):
        console.print(Panel(f"[bold white]{title}[/bold white]", style="magenta"))
except ImportError:
    def log(msg, style=""): print(f"  > {msg}")
    def success(msg): print(f"  OK {msg}")
    def warn(msg): print(f"  !! {msg}")
    def err(msg): print(f"  ERR {msg}")
    def header(title): print(f"\n{'='*60}\n  {title}\n{'='*60}")


# ── Paths ─────────────────────────────────────────────────────────────────────
ARTIFACT_DIR   = pathlib.Path(__file__).parent / "artifacts"
ONNX_PATH      = ARTIFACT_DIR / "network.onnx"
INPUT_JSON     = ARTIFACT_DIR / "input.json"
SETTINGS_JSON  = ARTIFACT_DIR / "settings.json"
COMPILED_MODEL = ARTIFACT_DIR / "model.compiled"
SRS_PATH       = ARTIFACT_DIR / "srs.params"
PK_PATH        = ARTIFACT_DIR / "pk.key"
VK_PATH        = ARTIFACT_DIR / "vk.key"
VERIFIER_SOL   = ARTIFACT_DIR / "verifier.sol"
VERIFIER_ABI   = ARTIFACT_DIR / "verifier_abi.json"


# ── Helpers ───────────────────────────────────────────────────────────────────
def _check_prerequisites():
    missing = []
    if not ONNX_PATH.exists():
        missing.append(str(ONNX_PATH))
    if not INPUT_JSON.exists():
        missing.append(str(INPUT_JSON))
    if missing:
        err("Missing prerequisites -- run  python model_export.py  first:")
        for m in missing:
            err(f"  {m}")
        sys.exit(1)


def _skip(path, force, label):
    if path.exists() and not force:
        warn(f"Skipping {label} -- artefact exists ({path.name})")
        return True
    return False


class _Timed:
    def __init__(self, label):
        self.label = label
    def __enter__(self):
        self._t = time.perf_counter()
        return self
    def __exit__(self, *_):
        elapsed = time.perf_counter() - self._t
        success(f"{self.label} completed in {elapsed:.1f}s")


# ── Pipeline steps (all SYNCHRONOUS — EZKL 23.x returns bool, not coroutines) ─
def step_gen_settings(force):
    header("Step 1/5 -- Generate Circuit Settings")
    if _skip(SETTINGS_JSON, force, "settings"):
        return
    log("Running ezkl.gen_settings ...")
    with _Timed("gen_settings"):
        res = ezkl.gen_settings(
            model=str(ONNX_PATH),
            output=str(SETTINGS_JSON),
        )
    if not res:
        err("gen_settings returned False -- check ONNX graph.")
        sys.exit(1)
    with open(SETTINGS_JSON) as fh:
        s = json.load(fh)
    run_args = s.get("run_args", {})
    log(f"  logrows = {run_args.get('logrows', '?')}")
    log(f"  scale   = {run_args.get('scale', '?')}")
    success(f"Settings -> {SETTINGS_JSON}")


def step_calibrate(force):
    header("Step 2/5 -- Calibrate Settings")
    log("Running ezkl.calibrate_settings ...")
    log("  (forward-pass warnings about 'decomposition error' are normal during calibration)")
    with _Timed("calibrate_settings"):
        # In EZKL >= 20 this is a plain sync call, NOT a coroutine
        res = ezkl.calibrate_settings(
            data=str(INPUT_JSON),
            model=str(ONNX_PATH),
            settings=str(SETTINGS_JSON),
            target="resources",
        )
    if not res:
        err("calibrate_settings returned False.")
        sys.exit(1)
    success(f"Settings calibrated -> {SETTINGS_JSON}")


def step_compile(force):
    header("Step 3/5 -- Compile Circuit")
    if _skip(COMPILED_MODEL, force, "compiled circuit"):
        return
    log("Running ezkl.compile_circuit ...")
    with _Timed("compile_circuit"):
        res = ezkl.compile_circuit(
            model=str(ONNX_PATH),
            compiled_circuit=str(COMPILED_MODEL),
            settings_path=str(SETTINGS_JSON),
        )
    if not res:
        err("compile_circuit returned False.")
        sys.exit(1)
    success(f"Circuit compiled -> {COMPILED_MODEL}")


def step_srs(force):
    header("Step 4/5 -- Fetch SRS (Trusted Setup Parameters)")
    if _skip(SRS_PATH, force, "SRS"):
        return
    with open(SETTINGS_JSON) as fh:
        settings = json.load(fh)
    logrows = settings.get("run_args", {}).get("logrows", 17)
    log(f"logrows = {logrows}  (determines SRS size)")
    log("Fetching SRS via ezkl.get_srs ...  (may download ~100 MB from Hermez CDN)")

    async def _fetch():
        # get_srs is the only true coroutine in EZKL 23.x
        return await ezkl.get_srs(
            settings_path=str(SETTINGS_JSON),
            logrows=logrows,
            srs_path=str(SRS_PATH),
        )

    with _Timed("get_srs"):
        res = asyncio.run(_fetch())

    if not res:
        err("get_srs returned False -- check network connectivity.")
        sys.exit(1)
    success(f"SRS written -> {SRS_PATH}")


def step_setup_keys(force):
    header("Step 5/5 -- Setup Keys & Solidity Verifier")
    if PK_PATH.exists() and VK_PATH.exists() and VERIFIER_SOL.exists() and not force:
        warn("Skipping key setup -- all artefacts exist.")
        return
    log("Running ezkl.setup ...")
    with _Timed("setup"):
        res = ezkl.setup(
            model=str(COMPILED_MODEL),
            vk_path=str(VK_PATH),
            pk_path=str(PK_PATH),
            srs_path=str(SRS_PATH),
        )
    if not res:
        err("setup returned False.")
        sys.exit(1)
    success(f"Proving key      -> {PK_PATH}")
    success(f"Verification key -> {VK_PATH}")

    log("Running ezkl.create_evm_verifier ...")

    async def _create_verifier():
        return await ezkl.create_evm_verifier(
            vk_path=str(VK_PATH),
            srs_path=str(SRS_PATH),
            settings_path=str(SETTINGS_JSON),
            sol_code_path=str(VERIFIER_SOL),
            abi_path=str(VERIFIER_ABI),
        )

    with _Timed("create_evm_verifier"):
        res = asyncio.run(_create_verifier())
    if not res:
        err("create_evm_verifier returned False.")
        sys.exit(1)
    success(f"Solidity verifier -> {VERIFIER_SOL}")
    success(f"Verifier ABI      -> {VERIFIER_ABI}")


# ── Main ──────────────────────────────────────────────────────────────────────
def main(force=False):
    header("Authentica -- Phase 1: zk-SNARK Circuit Compiler")
    log(f"EZKL version: {ezkl.__version__}")
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    if force:
        warn("--force: rebuilding all artefacts.")
    _check_prerequisites()

    step_gen_settings(force)
    step_calibrate(force)
    step_compile(force)
    step_srs(force)
    step_setup_keys(force)

    header("Compilation Complete")
    log("Generated artefacts:", style="green")
    for path in sorted(ARTIFACT_DIR.iterdir()):
        size_kb = path.stat().st_size / 1024
        log(f"  {path.name:<30} {size_kb:>8.1f} KB", style="white")
    log("\nNext -> run  python proof_generator.py", style="green")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Authentica Phase 1 -- compile ONNX -> zk-SNARK circuit"
    )
    parser.add_argument("--force", action="store_true",
                        help="Rebuild all artefacts even if they exist")
    args = parser.parse_args()
    main(force=args.force)
