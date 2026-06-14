"""Application configuration — resolved from environment variables."""

import os
from pathlib import Path


def _data_root() -> Path:
    return Path(os.environ.get("KORG_E_HOME", Path.home() / ".korg-e"))


def _ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


class Settings:
    # ── paths ──────────────────────────────────────────────────────────
    data_root: Path = _data_root()
    output_dir: Path = _ensure_dir(data_root / "outputs")
    workflows_dir: Path = _ensure_dir(data_root / "workflows")
    cache_dir: Path = _ensure_dir(
        Path(os.environ.get("HF_HOME", data_root / "cache"))
    )

    # ── server ─────────────────────────────────────────────────────────
    host: str = "127.0.0.1"
    port: int = int(os.environ.get("KORG_E_PORT", "8000"))
    log_level: str = os.environ.get("KORG_E_LOG_LEVEL", "info")

    # ── model ──────────────────────────────────────────────────────────
    model_id: str = "Tongyi-MAI/Z-Image"
    torch_dtype: str = "bfloat16"  # bfloat16 recommended for MPS
    low_cpu_mem_usage: bool = False  # per model card recommendation
    enable_attention_slicing: bool = True  # recommended for MPS < 64GB
    enable_vae_slicing: bool = True
    device: str = "mps"

    # ── generation defaults ────────────────────────────────────────────
    default_steps: int = 50
    default_cfg_scale: float = 5.0
    default_resolution: tuple[int, int] = (1024, 1024)

    # ── preview ─────────────────────────────────────────────────────────
    preview_decode_interval: int = 10   # VAE decode every N steps (0 = disabled)
    preview_size: int = 128             # resize preview to this square dimension

    # ── CORS (dev mode) ────────────────────────────────────────────────
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


settings = Settings()
