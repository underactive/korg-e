"""Image storage — save, list, and delete generated images."""

import json
from datetime import datetime, timezone
from pathlib import Path

from backend.config import settings


def _ensure_output_dir() -> Path:
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    return settings.output_dir


def save_image(image_data: bytes, prompt: str, seed: int, timestamp: str | None = None) -> Path:
    """Save a PNG to ``~/.korg-e/outputs/`` and write sidecar metadata.

    Returns the filesystem path of the saved image.
    """
    ts = timestamp or datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = f"{ts}_{seed}.png"
    output_path = _ensure_output_dir() / filename

    with open(output_path, "wb") as f:
        f.write(image_data)

    meta = {"filename": filename, "prompt": prompt, "seed": seed, "timestamp": ts}
    meta_path = output_path.with_suffix(".json")
    meta_path.write_text(json.dumps(meta, indent=2))

    return output_path


def list_images(limit: int = 50, offset: int = 0) -> list[dict]:
    """Return metadata for generated images, newest first."""
    output_dir = _ensure_output_dir()
    png_files = sorted(output_dir.glob("*.png"), reverse=True)
    png_files = png_files[offset : offset + limit]

    results: list[dict] = []
    for p in png_files:
        meta_path = p.with_suffix(".json")
        if meta_path.exists():
            meta = json.loads(meta_path.read_text())
        else:
            meta = {"filename": p.name, "prompt": "", "seed": 0, "timestamp": ""}
        results.append(meta)

    return results


def save_composite_images(
    composite_bytes: bytes,
    region_images: list[tuple[str, bytes, dict]],
    prompt: str,
    seed: int,
    timestamp: str | None = None,
) -> dict:
    """Save composite + per-region images and return URL paths.

    ``region_images`` is a list of ``(region_id, png_bytes, metadata_dict)``
    tuples, one per region.

    Returns a dict with ``image_url`` (composite) and ``region_images``
    (list of ``{regionId, image_url}`` dicts).
    """
    ts = timestamp or datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    base = f"{ts}_{seed}"

    # Save per-region images
    region_urls: list[dict] = []
    for region_id, region_data, region_meta in region_images:
        filename = f"{base}_region_{region_id}.png"
        output_path = _ensure_output_dir() / filename
        with open(output_path, "wb") as f:
            f.write(region_data)

        meta = {
            "filename": filename,
            "prompt": region_meta.get("prompt", prompt),
            "seed": region_meta.get("seed", seed),
            "timestamp": ts,
            "region_id": region_id,
            "region_x": region_meta.get("x"),
            "region_y": region_meta.get("y"),
            "region_width": region_meta.get("width"),
            "region_height": region_meta.get("height"),
        }
        meta_path = output_path.with_suffix(".json")
        meta_path.write_text(json.dumps(meta, indent=2))

        region_urls.append({
            "regionId": region_id,
            "image_url": f"/images/{filename}",
            "seed": region_meta.get("seed", seed),
        })

    # Save composite image
    composite_filename = f"{base}_composite.png"
    composite_path = _ensure_output_dir() / composite_filename
    with open(composite_path, "wb") as f:
        f.write(composite_bytes)

    composite_meta = {
        "filename": composite_filename,
        "prompt": prompt,
        "seed": seed,
        "timestamp": ts,
        "type": "composite",
    }
    meta_path = composite_path.with_suffix(".json")
    meta_path.write_text(json.dumps(composite_meta, indent=2))

    return {
        "image_url": f"/images/{composite_filename}",
        "region_images": region_urls,
    }


def delete_image(filename: str) -> bool:
    """Delete an image and its sidecar metadata. Returns True if deleted."""
    output_dir = _ensure_output_dir()
    png_path = output_dir / filename
    if not png_path.exists():
        return False

    png_path.unlink()
    meta_path = png_path.with_suffix(".json")
    if meta_path.exists():
        meta_path.unlink()
    return True


def save_inpaint_images(
    inpainted_bytes: bytes,
    init_image_bytes: bytes,
    mask_image_bytes: bytes,
    prompt: str,
    seed: int,
    mask_blur: int = 16,
    timestamp: str | None = None,
) -> dict:
    """Save inpainted result + init + mask images and return URL paths.

    Returns a dict with ``image_url``, ``init_image_url``, ``mask_url``.
    """
    ts = timestamp or datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    base = f"{ts}_{seed}"

    # Save inpainted result
    result_filename = f"{base}.png"
    result_path = _ensure_output_dir() / result_filename
    with open(result_path, "wb") as f:
        f.write(inpainted_bytes)

    # Save init image (provenance)
    init_filename = f"{base}_init.png"
    init_path = _ensure_output_dir() / init_filename
    with open(init_path, "wb") as f:
        f.write(init_image_bytes)

    # Save mask image (provenance)
    mask_filename = f"{base}_mask.png"
    mask_path = _ensure_output_dir() / mask_filename
    with open(mask_path, "wb") as f:
        f.write(mask_image_bytes)

    # Write enriched metadata
    meta = {
        "filename": result_filename,
        "prompt": prompt,
        "seed": seed,
        "timestamp": ts,
        "type": "inpaint",
        "init_image_filename": init_filename,
        "mask_filename": mask_filename,
        "mask_blur": mask_blur,
    }
    meta_path = result_path.with_suffix(".json")
    meta_path.write_text(json.dumps(meta, indent=2))

    return {
        "image_url": f"/images/{result_filename}",
        "init_image_url": f"/images/{init_filename}",
        "mask_url": f"/images/{mask_filename}",
    }


def get_image_path(filename: str) -> Path | None:
    """Return the filesystem path for a filename, or None if missing."""
    p = _ensure_output_dir() / filename
    return p if p.exists() else None
