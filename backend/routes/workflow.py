"""POST /api/workflow/save, POST /api/workflow/load — workflow JSON persistence."""

import asyncio
import json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()


class SaveRequest(BaseModel):
    name: str
    workflow: dict  # React Flow toObject() format: { nodes, edges, viewport }


class LoadResponse(BaseModel):
    name: str
    workflow: dict


# ── helpers ─────────────────────────────────────────────────────────────


def _workflow_path(name: str) -> Path:
    """Return the filesystem path for a named workflow."""
    safe_name = Path(name).name  # prevent path traversal
    return settings.workflows_dir / f"{safe_name}.json"


def _read_json(path: Path) -> dict:
    """Sync JSON reader — runs in thread pool."""
    return json.loads(path.read_text())


def _write_json(path: Path, data: dict) -> None:
    """Sync JSON writer — runs in thread pool."""
    path.write_text(json.dumps(data, indent=2))


# ── endpoints ───────────────────────────────────────────────────────────


@router.post("/workflow/save")
async def save_workflow(body: SaveRequest):
    """Persist a workflow as a JSON file."""
    path = _workflow_path(body.name)
    data = {"name": body.name, "workflow": body.workflow}
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _write_json, path, data)
    logger.info("Workflow saved: %s", body.name)
    return {"status": "ok", "name": body.name}


@router.post("/workflow/load/{name}")
async def load_workflow(name: str) -> LoadResponse:
    """Load a workflow from a JSON file."""
    path = _workflow_path(name)
    loop = asyncio.get_running_loop()
    exists = await loop.run_in_executor(None, path.exists)
    if not exists:
        raise HTTPException(status_code=404, detail=f"Workflow '{name}' not found.")
    data = await loop.run_in_executor(None, _read_json, path)
    return LoadResponse(name=data["name"], workflow=data["workflow"])


@router.get("/workflows")
async def list_workflows() -> list[str]:
    """List all saved workflow names."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, lambda: sorted(p.stem for p in settings.workflows_dir.glob("*.json"))
    )
