"""Application configuration — resolved from environment variables."""

import os
from pathlib import Path

import torch


def _data_root() -> Path:
    return Path(os.environ.get("KORG_E_HOME", Path.home() / ".korg-e"))


def _ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def _resolve_device() -> str:
    override = os.environ.get("KORG_E_DEVICE")
    if override:
        return override
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _env_flag(name: str, default: bool) -> bool:
    return os.environ.get(name, "1" if default else "0") == "1"


class Settings:
    # ── paths ──────────────────────────────────────────────────────────
    data_root: Path = _data_root()
    output_dir: Path = _ensure_dir(data_root / "outputs")
    workflows_dir: Path = _ensure_dir(data_root / "workflows")
    cache_dir: Path = _ensure_dir(
        Path(os.environ.get("HF_HOME", data_root / "cache"))
    )

    # ── server ─────────────────────────────────────────────────────────
    host: str = os.environ.get("KORG_E_HOST", "127.0.0.1")
    port: int = int(os.environ.get("KORG_E_PORT", "8000"))
    log_level: str = os.environ.get("KORG_E_LOG_LEVEL", "info")

    # ── model ──────────────────────────────────────────────────────────
    model_id: str = os.environ.get("KORG_E_MODEL_ID", "Tongyi-MAI/Z-Image")
    torch_dtype: str = "bfloat16"  # bfloat16 recommended for MPS
    low_cpu_mem_usage: bool = False  # per model card recommendation
    enable_vae_slicing: bool = True
    device: str = _resolve_device()
    # The weights total ~20GB, which will not fit alongside activations on a
    # 16GB card, so CUDA keeps one module resident at a time by default.
    cpu_offload: bool = _env_flag("KORG_E_CPU_OFFLOAD", device == "cuda")
    # Slicing trades throughput for peak memory — worth it on MPS, but on CUDA
    # offload already caps the footprint.
    enable_attention_slicing: bool = _env_flag(
        "KORG_E_ATTENTION_SLICING", device != "cuda"
    )

    # ── generation defaults ────────────────────────────────────────────
    default_steps: int = 50
    default_cfg_scale: float = 5.0
    default_resolution: tuple[int, int] = (1024, 1024)

    # ── preview ─────────────────────────────────────────────────────────
    preview_decode_interval: int = int(
        os.environ.get("KORG_E_PREVIEW_DECODE_INTERVAL", "10")
    )  # VAE decode every N steps (0 = disabled)
    preview_size: int = 128             # resize preview to this square dimension

    # ── CORS (dev mode) ────────────────────────────────────────────────
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


settings = Settings()
