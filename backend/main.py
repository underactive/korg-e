"""FastAPI application entry point."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import settings

app = FastAPI(title="korg-e", version="0.1.0")

# ── CORS (dev-mode: separate Vite dev server) ─────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── state ──────────────────────────────────────────────────────────────
from backend.pipeline import PipelineWrapper

app.state.model_pipeline = PipelineWrapper()  # lazy-loads on first generation


# ── health ─────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": app.state.model_pipeline.loaded,
    }


# ── routes ──────────────────────────────────────────────────────────────
from backend.routes import generate, images, workflow
app.include_router(generate.router, prefix="/api")
app.include_router(images.router, prefix="/api")
app.include_router(workflow.router, prefix="/api")


# ── static files: generated images ────────────────────────────────────
images_path = Path(settings.output_dir)
images_path.mkdir(parents=True, exist_ok=True)
app.mount("/images", StaticFiles(directory=str(images_path)), name="images")

# ── static files: production frontend build ────────────────────────────
dist_path = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if dist_path.exists():
    app.mount("/", StaticFiles(directory=str(dist_path), html=True), name="frontend")
