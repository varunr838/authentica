"""
model_export.py  —  Authentica Phase 1
======================================
Defines, trains (on synthetic data), and exports a lightweight
Convolutional Pixelation Filter as an ONNX graph.

The model is intentionally tiny so that:
  • EZKL can compile it into a zk-SNARK circuit in reasonable time.
  • Proof generation stays tractable on consumer hardware.

Architecture
------------
  Input  : (1, 1, 16, 16)  — greyscale 16×16 patch
  Conv1  : 4 filters, 3×3, ReLU
  Pool   : 2×2 average pool
  Conv2  : 8 filters, 3×3, ReLU
  FC     : → 16 logits  (represents pixelation intensity bins)
  Output : (1, 16)

Usage
-----
  python model_export.py
  → writes: artifacts/network.onnx
            artifacts/input.json
"""

import json
import os
import pathlib
import sys

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset

# ── EZKL import (soft) ──────────────────────────────────────────────────────
try:
    import ezkl  # noqa: F401
    EZKL_AVAILABLE = True
except ImportError:
    EZKL_AVAILABLE = False

# ── Rich console (soft) ─────────────────────────────────────────────────────
try:
    from rich.console import Console
    from rich.panel import Panel
    console = Console()
    def log(msg: str, style: str = "cyan") -> None:  # noqa: E302
        console.print(f"  [bold {style}]▶[/bold {style}] {msg}")
    def success(msg: str) -> None:  # noqa: E302
        console.print(f"  [bold green]✓[/bold green] {msg}")
    def header(title: str) -> None:  # noqa: E302
        console.print(Panel(f"[bold white]{title}[/bold white]", style="blue"))
except ImportError:
    def log(msg: str, style: str = "") -> None:  # type: ignore
        print(f"  ▶ {msg}")
    def success(msg: str) -> None:  # type: ignore
        print(f"  ✓ {msg}")
    def header(title: str) -> None:  # type: ignore
        print(f"\n{'='*60}\n  {title}\n{'='*60}")


# ── Constants ────────────────────────────────────────────────────────────────
ARTIFACT_DIR  = pathlib.Path(__file__).parent / "artifacts"
ONNX_PATH     = ARTIFACT_DIR / "network.onnx"
INPUT_JSON    = ARTIFACT_DIR / "input.json"

PATCH_H, PATCH_W = 16, 16          # spatial dims — kept small for zk circuits
IN_CHANNELS      = 1               # greyscale
NUM_CLASSES      = 16              # pixelation-intensity bins
BATCH_SIZE       = 32
EPOCHS           = 10
LR               = 1e-3
SEED             = 42


# ── Model definition ─────────────────────────────────────────────────────────
class PixelationFilter(nn.Module):
    """
    Minimal CNN that predicts the required pixelation level of an image patch.
    Small enough to compile into a zk-SNARK circuit with EZKL.
    """

    def __init__(self) -> None:
        super().__init__()
        self.features = nn.Sequential(
            # Block 1 — 1 → 4 channels, 3×3 conv
            nn.Conv2d(IN_CHANNELS, 4, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.AvgPool2d(kernel_size=2),      # 16×16 → 8×8

            # Block 2 — 4 → 8 channels, 3×3 conv
            nn.Conv2d(4, 8, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.AvgPool2d(kernel_size=2),      # 8×8  → 4×4
        )
        # After two 2×2 pools on 16×16: spatial = 4×4, channels = 8  →  128
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(8 * 4 * 4, 32),
            nn.ReLU(inplace=True),
            nn.Linear(32, NUM_CLASSES),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # (B,1,16,16) → (B,16)
        return self.classifier(self.features(x))


# ── Synthetic dataset ─────────────────────────────────────────────────────────
def make_dataset(n_samples: int = 512, seed: int = SEED) -> TensorDataset:
    """Generate synthetic greyscale patches + random integer labels."""
    rng = np.random.default_rng(seed)
    X = rng.standard_normal((n_samples, IN_CHANNELS, PATCH_H, PATCH_W)).astype(np.float32)
    y = rng.integers(0, NUM_CLASSES, size=n_samples).astype(np.int64)
    return TensorDataset(torch.from_numpy(X), torch.from_numpy(y))


# ── Training loop ─────────────────────────────────────────────────────────────
def train(model: nn.Module, loader: DataLoader, device: torch.device) -> None:
    model.train()
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(model.parameters(), lr=LR)

    for epoch in range(1, EPOCHS + 1):
        total_loss = 0.0
        for xb, yb in loader:
            xb, yb = xb.to(device), yb.to(device)
            optimizer.zero_grad()
            loss = criterion(model(xb), yb)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        avg = total_loss / len(loader)
        log(f"Epoch [{epoch:>2}/{EPOCHS}]  loss = {avg:.4f}", style="yellow")


# ── ONNX export ───────────────────────────────────────────────────────────────
def export_onnx(model: nn.Module, device: torch.device) -> None:
    model.eval()
    dummy = torch.zeros(1, IN_CHANNELS, PATCH_H, PATCH_W, device=device)

    # dynamo=False  → forces the legacy TorchScript exporter so opset 11 is honoured.
    # PyTorch 2.4+  → dynamo=True by default, always exports at opset 18 (EZKL unsupported).
    # dynamic_axes MUST be omitted → EZKL's tract backend requires a fully static graph.
    # Any symbolic dimension (Sym0) will cause "Undetermined symbol" in gen_settings.
    torch.onnx.export(
        model,
        dummy,
        str(ONNX_PATH),
        opset_version=11,
        dynamo=False,
        input_names=["input"],
        output_names=["output"],
        # NO dynamic_axes — EZKL needs batch=1 baked in as a static shape
    )

    success(f"ONNX model exported → {ONNX_PATH}")


# ── input.json generation ─────────────────────────────────────────────────────
def make_input_json() -> None:
    """
    EZKL expects witness data as a JSON file with the key "input_data".
    Each element is a *flattened* list of float32 values.
    """
    rng = np.random.default_rng(SEED + 1)
    tensor = rng.uniform(-1.0, 1.0, (1, IN_CHANNELS, PATCH_H, PATCH_W)).astype(np.float32)

    payload = {
        "input_shapes": [[IN_CHANNELS, PATCH_H, PATCH_W]],
        "input_data": [tensor.flatten().tolist()],
    }

    with open(INPUT_JSON, "w") as fh:
        json.dump(payload, fh, indent=2)

    success(f"Sample input saved  → {INPUT_JSON}")


# ── Sanity-check with ONNX Runtime ───────────────────────────────────────────
def verify_onnx(model: nn.Module, device: torch.device) -> None:
    try:
        import onnxruntime as ort

        session = ort.InferenceSession(str(ONNX_PATH))
        rng = np.random.default_rng(0)
        x = rng.standard_normal((1, IN_CHANNELS, PATCH_H, PATCH_W)).astype(np.float32)

        # PyTorch output
        with torch.no_grad():
            pt_out = model(torch.from_numpy(x).to(device)).cpu().numpy()

        # ONNX-RT output
        ort_out = session.run(None, {"input": x})[0]

        max_diff = float(np.abs(pt_out - ort_out).max())
        if max_diff < 1e-4:
            success(f"ONNX-RT verification passed (max diff = {max_diff:.2e})")
        else:
            log(f"WARNING: max diff = {max_diff:.4f} — check opset compatibility", style="red")
    except ImportError:
        log("onnxruntime not installed — skipping ONNX verification.", style="yellow")


# ── Entry point ───────────────────────────────────────────────────────────────
def main() -> None:
    torch.manual_seed(SEED)
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

    header("Authentica — Phase 1: PixelationFilter Model Export")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    log(f"Device: {device}")

    # ── Dataset & DataLoader ─────────────────────────────────────────────────
    log("Generating synthetic dataset …")
    dataset = make_dataset()
    loader  = DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=True)
    success(f"Dataset: {len(dataset)} samples  ({len(loader)} batches)")

    # ── Model ────────────────────────────────────────────────────────────────
    model = PixelationFilter().to(device)
    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    log(f"Model params: {n_params:,}")

    # ── Train ────────────────────────────────────────────────────────────────
    header("Training")
    train(model, loader, device)

    # ── Export & Verify ──────────────────────────────────────────────────────
    header("Exporting Artifacts")
    export_onnx(model, device)
    make_input_json()
    verify_onnx(model, device)

    header("Done")
    log("Next step → run  python zk_compiler.py", style="green")


if __name__ == "__main__":
    main()
