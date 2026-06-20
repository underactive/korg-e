"""Z-Image pipeline wrapper — lazy loading, MPS optimizations, progress callback."""

import logging
from typing import Callable

import torch

from backend.config import settings

logger = logging.getLogger(__name__)

# Lazy import — diffusers is a heavy dependency only needed at generation time
_PipelineType = None  # Forward-declared; resolved on first load


class PipelineWrapper:
    """Manages the Z-Image diffusers pipeline with lazy loading.

    The pipeline is instantiated on the first call to :meth:`load` and
    cached for subsequent generations.
    """

    def __init__(self) -> None:
        self._pipeline: _PipelineType = None  # type: ignore[assignment]
        self._loaded = False

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def pipeline(self) -> "_PipelineType":
        if self._pipeline is None:
            raise RuntimeError("Pipeline not loaded. Call load() first.")
        return self._pipeline

    # ── loading ─────────────────────────────────────────────────────────

    def load(self, progress_callback: Callable[[str], None] | None = None) -> None:
        """Download, instantiate, and optimise the Z-Image pipeline.

        This is a **blocking call** — run it in a thread pool to avoid
        blocking the event loop.

        Parameters passed to progress_callback:
            ``"downloading"``, ``"loading"``, ``"optimising"``, ``"ready"``
        """
        if self._loaded:
            return

        from diffusers import ZImagePipeline  # type: ignore[import-untyped]

        _notify(progress_callback, "downloading")

        dtype = _resolve_dtype()
        pipe = ZImagePipeline.from_pretrained(
            settings.model_id,
            torch_dtype=dtype,
            low_cpu_mem_usage=settings.low_cpu_mem_usage,
        )

        _notify(progress_callback, "loading")
        pipe.to(settings.device)  # "mps" or "cuda"

        _notify(progress_callback, "optimising")
        if settings.enable_attention_slicing:
            try:
                pipe.enable_attention_slicing()
            except AttributeError:
                logger.info("enable_attention_slicing() not available for this pipeline — skipping")
        if settings.enable_vae_slicing:
            try:
                pipe.enable_vae_slicing()
            except AttributeError:
                logger.info("enable_vae_slicing() not available for this pipeline — skipping")

        self._pipeline = pipe
        self._loaded = True
        _notify(progress_callback, "ready")

    # ── image-to-image support ──────────────────────────────────────────

    def load_img2img(self, progress_callback: Callable[[str], None] | None = None) -> None:
        """Lazy-load the **separate** :class:`ZImageImg2ImgPipeline`.

        Uses the same weight-cache as the text-to-image pipeline but
        must be instantiated from its own class.
        """
        if hasattr(self, "_img2img_pipeline") and self._img2img_pipeline is not None:
            return

        from diffusers import ZImageImg2ImgPipeline  # type: ignore[import-untyped]

        _notify(progress_callback, "downloading")
        dtype = _resolve_dtype()
        pipe = ZImageImg2ImgPipeline.from_pretrained(
            settings.model_id,
            torch_dtype=dtype,
            low_cpu_mem_usage=settings.low_cpu_mem_usage,
        )

        _notify(progress_callback, "loading")
        pipe.to(settings.device)

        _notify(progress_callback, "optimising")
        if settings.enable_attention_slicing:
            try:
                pipe.enable_attention_slicing()
            except AttributeError:
                logger.info("enable_attention_slicing() not available for img2img pipeline — skipping")
        if settings.enable_vae_slicing:
            try:
                pipe.enable_vae_slicing()
            except AttributeError:
                logger.info("enable_vae_slicing() not available for img2img pipeline — skipping")

        self._img2img_pipeline = pipe  # type: ignore[attr-defined]

    # ── generation ──────────────────────────────────────────────────────

    def generate(
        self,
        prompt: str,
        *,
        steps: int = 50,
        cfg_scale: float = 5.0,
        seed: int | None = None,
        width: int = 1024,
        height: int = 1024,
        step_callback: Callable[[int, int, str | None], None] | None = None,
    ) -> bytes:
        """Run text-to-image generation and return raw PNG bytes.

        The ``step_callback`` receives ``(step, total_steps, image_b64)``
        after each inference step so callers can push SSE progress events.
        ``image_b64`` is a base64-encoded JPEG preview string, or ``None``
        when no preview is available for this step.
        """
        if self._pipeline is None:
            raise RuntimeError("Pipeline not loaded. Call load() first.")

        generator = None
        if seed is not None:
            generator = torch.Generator(device=settings.device).manual_seed(seed)

        # Build the callback_on_step_end closure
        total = steps
        decode_interval = settings.preview_decode_interval
        preview_size = settings.preview_size

        import io
        import base64
        from PIL import Image as PILImage

        def _on_step(pipe: object, step: int, timestep: int, callback_kwargs: dict) -> dict:
            image_b64: str | None = None

            if step_callback and decode_interval > 0:
                should_decode = (step == 0) or ((step + 1) % decode_interval == 0)
                if should_decode:
                    try:
                        latents = callback_kwargs["latents"]

                        with torch.no_grad():
                            # Cast to VAE dtype — latents arrive in float32, VAE is bfloat16 on MPS
                            latents_for_vae = latents.to(pipe.vae.dtype)

                            # FLUX VAE: (latents / scaling_factor) + shift_factor
                            latents_for_vae = (
                                latents_for_vae / pipe.vae.config.scaling_factor
                            ) + pipe.vae.config.shift_factor

                            # Decode: (B, 16, H, W) → (B, 3, H*8, W*8) in [-1, 1]
                            image_tensor = pipe.vae.decode(latents_for_vae, return_dict=False)[0]

                            # Postprocess: denormalize [-1,1] → [0,1], convert to PIL
                            pil_images = pipe.image_processor.postprocess(
                                image_tensor, output_type="pil"
                            )
                            preview_image = pil_images[0]

                            # Resize for smaller SSE payload
                            if preview_size:
                                preview_image = preview_image.resize(
                                    (preview_size, preview_size), PILImage.LANCZOS
                                )

                            # Encode as JPEG base64
                            buf = io.BytesIO()
                            preview_image.save(buf, format="JPEG", quality=60)
                            image_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
                    except Exception:
                        logger.warning("Intermediate VAE decode failed", exc_info=True)
                        image_b64 = None

            if step_callback:
                step_callback(step, total, image_b64)
            return callback_kwargs

        result = self._pipeline(
            prompt=prompt,
            num_inference_steps=steps,
            guidance_scale=cfg_scale,
            generator=generator,
            width=width,
            height=height,
            output_type="pil",
            callback_on_step_end=_on_step,
            callback_on_step_end_tensor_inputs=["latents"],
        )

        image = result.images[0]
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()

    def generate_img2img(
        self,
        prompt: str,
        init_image_bytes: bytes,
        *,
        strength: float = 0.6,
        steps: int = 50,
        cfg_scale: float = 5.0,
        seed: int | None = None,
        step_callback: Callable[[int, int, str | None], None] | None = None,
    ) -> bytes:
        """Run image-to-image generation and return raw PNG bytes.

        The ``step_callback`` receives ``(step, total_steps, image_b64)``
        after each inference step. ``image_b64`` is ``None`` when no
        preview is available for this step.
        """
        if not hasattr(self, "_img2img_pipeline") or self._img2img_pipeline is None:
            raise RuntimeError("Img2Img pipeline not loaded. Call load_img2img() first.")

        from PIL import Image as PILImage
        import io
        import base64

        init_image = PILImage.open(io.BytesIO(init_image_bytes)).convert("RGB")

        generator = None
        if seed is not None:
            generator = torch.Generator(device=settings.device).manual_seed(seed)

        total = steps
        decode_interval = settings.preview_decode_interval
        preview_size = settings.preview_size

        def _on_step(pipe: object, step: int, timestep: int, callback_kwargs: dict) -> dict:
            image_b64: str | None = None

            if step_callback and decode_interval > 0:
                should_decode = (step == 0) or ((step + 1) % decode_interval == 0)
                if should_decode:
                    try:
                        latents = callback_kwargs["latents"]

                        with torch.no_grad():
                            # Cast to VAE dtype — latents arrive in float32, VAE is bfloat16 on MPS
                            latents_for_vae = latents.to(pipe.vae.dtype)

                            # FLUX VAE: (latents / scaling_factor) + shift_factor
                            latents_for_vae = (
                                latents_for_vae / pipe.vae.config.scaling_factor
                            ) + pipe.vae.config.shift_factor

                            # Decode: (B, 16, H, W) → (B, 3, H*8, W*8) in [-1, 1]
                            image_tensor = pipe.vae.decode(latents_for_vae, return_dict=False)[0]

                            # Postprocess: denormalize [-1,1] → [0,1], convert to PIL
                            pil_images = pipe.image_processor.postprocess(
                                image_tensor, output_type="pil"
                            )
                            preview_image = pil_images[0]

                            # Resize for smaller SSE payload
                            if preview_size:
                                preview_image = preview_image.resize(
                                    (preview_size, preview_size), PILImage.LANCZOS
                                )

                            # Encode as JPEG base64
                            buf = io.BytesIO()
                            preview_image.save(buf, format="JPEG", quality=60)
                            image_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
                    except Exception:
                        logger.warning("Intermediate VAE decode failed", exc_info=True)
                        image_b64 = None

            if step_callback:
                step_callback(step, total, image_b64)
            return callback_kwargs

        result = self._img2img_pipeline(
            prompt=prompt,
            image=init_image,
            strength=strength,
            num_inference_steps=steps,
            guidance_scale=cfg_scale,
            generator=generator,
            output_type="pil",
            callback_on_step_end=_on_step,
            callback_on_step_end_tensor_inputs=["latents"],
        )

        image = result.images[0]
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()

    # ── composite generation ────────────────────────────────────────────

    def generate_composite(
        self,
        regions: list[dict],
        canvas_width: int,
        canvas_height: int,
        *,
        step_callback: Callable[[int, int, int, str, str | None], None] | None = None,
    ) -> bytes:
        """Run N sequential per-region diffusion passes and composite.

        ``step_callback`` receives ``(region_index, step, total, region_id, image_b64)``
        where ``region_index`` is the 0-based index into the sorted regions list,
        ``step`` is 1-indexed, and ``image_b64`` is a base64 JPEG preview or None.

        Returns raw PNG bytes of the composited output.
        """
        if self._pipeline is None:
            raise RuntimeError("Pipeline not loaded. Call load() first.")

        from PIL import Image as PILImage
        import io
        import base64

        decode_interval = settings.preview_decode_interval
        preview_size = settings.preview_size

        # Create blank RGBA canvas
        canvas_image = PILImage.new(
            "RGBA", (canvas_width, canvas_height), (0, 0, 0, 0)
        )

        # Sort regions by z-index (ascending = bottom first)
        sorted_regions = sorted(regions, key=lambda r: r.get("region_z_index", 0))

        # Collect per-region images for saving
        self._region_pngs: list[tuple[str, bytes]] = []

        for ri, region in enumerate(sorted_regions):
            prompt = region.get("prompt", "")
            steps = region.get("steps", 50)
            cfg_scale = region.get("cfg_scale", 5.0)
            seed = region.get("seed", None)
            rw = region.get("region_width", 256)
            rh = region.get("region_height", 256)
            region_id = region.get("region_id", f"region_{ri}")

            # Create per-region generator for seed isolation
            generator = None
            if seed is not None:
                generator = torch.Generator(device=settings.device).manual_seed(seed)

            total = steps

            def _make_on_step(ri_idx: int, region_id_str: str):
                """Factory to capture per-region closure variables."""
                def _on_step(
                    pipe: object, step: int, timestep: int, callback_kwargs: dict
                ) -> dict:
                    image_b64: str | None = None

                    if step_callback and decode_interval > 0:
                        should_decode = (step == 0) or ((step + 1) % decode_interval == 0)
                        if should_decode:
                            try:
                                latents = callback_kwargs["latents"]

                                with torch.no_grad():
                                    latents_for_vae = latents.to(pipe.vae.dtype)
                                    latents_for_vae = (
                                        latents_for_vae / pipe.vae.config.scaling_factor
                                    ) + pipe.vae.config.shift_factor

                                    image_tensor = pipe.vae.decode(
                                        latents_for_vae, return_dict=False
                                    )[0]

                                    pil_images = pipe.image_processor.postprocess(
                                        image_tensor, output_type="pil"
                                    )
                                    preview_image = pil_images[0]

                                    if preview_size:
                                        preview_image = preview_image.resize(
                                            (preview_size, preview_size),
                                            PILImage.LANCZOS,
                                        )

                                    buf = io.BytesIO()
                                    preview_image.save(buf, format="JPEG", quality=60)
                                    image_b64 = base64.b64encode(
                                        buf.getvalue()
                                    ).decode("ascii")
                            except Exception:
                                logger.warning(
                                    "Region VAE decode failed", exc_info=True
                                )
                                image_b64 = None

                    if step_callback:
                        step_callback(ri_idx, step, total, region_id_str, image_b64)
                    return callback_kwargs
                return _on_step

            result = self._pipeline(
                prompt=prompt,
                num_inference_steps=steps,
                guidance_scale=cfg_scale,
                generator=generator,
                width=rw,
                height=rh,
                output_type="pil",
                callback_on_step_end=_make_on_step(ri, region_id),
                callback_on_step_end_tensor_inputs=["latents"],
            )

            region_pil = result.images[0]

            # Convert to RGBA for alpha compositing
            if region_pil.mode != "RGBA":
                region_pil = region_pil.convert("RGBA")

            # Paste onto canvas at region position (alpha compositing)
            rx = region.get("region_x", 0)
            ry = region.get("region_y", 0)
            canvas_image.paste(region_pil, (rx, ry), region_pil)

            # Save per-region PNG bytes
            region_buf = io.BytesIO()
            region_pil.save(region_buf, format="PNG")
            self._region_pngs.append((region_id, region_buf.getvalue()))

        # Save final composite
        composite_buf = io.BytesIO()
        composite_result = canvas_image.convert("RGB")
        composite_result.save(composite_buf, format="PNG")
        return composite_buf.getvalue()

    def get_region_images(self) -> list[tuple[str, bytes]]:
        """Return per-region PNG bytes from the last composite generation."""
        return getattr(self, "_region_pngs", [])

    # ── memory management ───────────────────────────────────────────────

    def empty_cache(self) -> None:
        """Release cached GPU memory held by the framework allocator.

        Call between sequential generations (e.g. each image of a batch) to
        stop memory from accumulating across runs. On MPS the caching
        allocator otherwise retains freed buffers, which drives both the
        progressive slowdown and the numerical degradation (broken anatomy)
        seen on long batches. Cheap to call — a few ms of re-allocation on the
        next run in exchange for a clean memory baseline.
        """
        import gc

        gc.collect()
        if settings.device == "mps":
            torch.mps.empty_cache()
        elif settings.device == "cuda":
            torch.cuda.empty_cache()


# ── helpers ─────────────────────────────────────────────────────────────


def _resolve_dtype() -> torch.dtype:
    mapping: dict[str, torch.dtype] = {
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
        "float32": torch.float32,
    }
    return mapping.get(settings.torch_dtype, torch.bfloat16)


def _notify(cb: Callable[[str], None] | None, msg: str) -> None:
    if cb:
        cb(msg)
