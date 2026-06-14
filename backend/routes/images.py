"""GET /api/images — list generated images and their metadata."""

from fastapi import APIRouter, Query

from backend.utils.storage import list_images

router = APIRouter()


@router.get("/images")
async def images(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """Return list of generated images, newest first."""
    images = list_images(limit=limit, offset=offset)
    return {"images": images, "total": len(images), "limit": limit, "offset": offset}
