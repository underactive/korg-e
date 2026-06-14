---
date: 2026-06-13T17:14:53-0700
author: Eric Sison
commit: no-commit
branch: main
repository: korg-e
topic: "Progressive image decode — fuzzy to sharp previews during generation"
confidence: high
complexity: medium
status: ready
verdict: pass
tags: [solutions, pipeline, sse, frontend]
last_updated: 2026-06-13T17:14:53-0700
last_updated_by: Eric Sison
---

# Solution Analysis: Progressive Image Decode ("Fuzzy → Sharp" Previews)

**Date**: 2026-06-13T17:14:53-0700
**Author**: Eric Sison
**Commit**: no-commit
**Branch**: main
**Repository**: korg-e

## Research Question
GPT and Grok image generation shows a fuzzy, blurry image that progressively sharpens during generation. Can we do the same on the korg-e frontend?

## Summary
**Problem**: Current implementation only streams numeric step counts via SSE — the user sees a progress bar but no visual preview of the image forming. Intermediate latents are available in `callback_on_step_end` but are discarded.
**Recommended**: VAE Decode at Intervals — decode intermediate latents through the full VAE every N steps and send base64 thumbnails in existing SSE progress events. Proven, zero new dependencies, directly targets the "fuzzy → sharp" UX.
**Effort**: Medium (~2–3 days)
**Confidence**: High

## Problem Statement

**Requirements:**
- Show progressive image previews during generation (not just a step-count bar)
- The previews must visibly sharpen as denoising advances (the "fuzzy → sharp" experience)
- Must work with the existing Z-Image (Flux VAE) model on MPS
- Must flow through the existing SSE transport without architectural changes
- Must be additive — the pipeline must work without previews if not configured

**Constraints:**
- Z-Image uses a FLUX-style 16-channel VAE — SDXL-specific solutions (e.g., TAESD without taef1, SDXL-calibrated projection matrices) won't work without adaptation
- MPS memory on Apple Silicon (16GB typical) — dual VAE loading creates OOM risk
- No TypeScript strict validation on SSE events — payloads are `Record<string, unknown>`, making schema changes backward-compatible
- Solo-use tool — no multi-user scaling concerns for SSE bandwidth/queue size

**Success criteria:**
- [ ] Intermediate images appear in the ImageOutputNode and visibly sharpen across denoising steps
- [ ] Generation latency increase is acceptable (≤20% when decoding every 5 steps at 256×256)
- [ ] Standard generation without previews continues to work identically
- [ ] SSE transport handles base64 payloads without framing corruption
- [ ] MPS memory stays within limits (no OOM from intermediate decodes)

## Current State

**Existing implementation:**
- `backend/pipeline.py:137-139` — `_on_step` closure receives latents in `callback_kwargs["latents"]` (because `callback_on_step_end_tensor_inputs=["latents"]` at line 161) but **discards them** — only forwards `(step, total)` integers
- `backend/pipeline.py:128,134` — `step_callback` parameter typed `Callable[[int, int], None]` — only numeric data passes through
- `backend/routes/generate.py:155-163` — `step_cb` pushes `{"event": "progress", "status": "generating", "step": ..., "total": ...}` to the asyncio queue — no image data field
- `frontend/src/utils/integration.ts:88-97` — `onProgress` handler only updates `status` and `progress` on the ZImageGenerateNode — no image rendering
- `frontend/src/components/nodes/ImageOutputNode.tsx:15-25` — renders `imageUrl` as `<img>` only after `done` event — no progressive updates

**Relevant patterns:**
- `callback_on_step_end_tensor_inputs=["latents"]`: `backend/pipeline.py:161,212` — latents already requested at every step, unused
- SSE extensibility: `backend/routes/generate.py:248` does `json.dumps(data)` on any dict — adding a key is free
- Frontend SSE parser: `frontend/src/utils/sse.ts:76-79` passes ALL parsed JSON to `handlers.onProgress` — no schema gate
- CSS transitions: `frontend/src/components/nodes/ZImageGenerateNode.tsx:175` — inline `transition: "width 0.3s ease"` sets precedent

**Integration points:**
- `backend/pipeline.py:137` — `_on_step` closure (the decode hook point)
- `backend/pipeline.py:134` — `step_callback` type annotation (must widen to carry image data)
- `backend/routes/generate.py:155,204` — `step_cb` in both `_run_text_to_image` and `_run_img2img` (must accept + emit image payload)
- `frontend/src/utils/integration.ts:88-93` — `onProgress` handler (must detect and forward image data)
- `frontend/src/components/nodes/ImageOutputNode.tsx:15-25` — image display (must render progressive updates)

## Solution Options

### Option 1: VAE Decode at Intervals (Recommended)

**How it works:**
In the existing `_on_step` diffusers callback, call `pipe.vae.decode(latents)` every N steps (configurable, default 5), convert the decoded tensor to a small JPEG (256×256 or configurable), encode as base64, and attach to the existing SSE progress event as an `image_b64` field. The frontend `onProgress` handler detects this field and updates the ImageOutputNode's `imageUrl` progressively. The full-resolution final image still comes via the existing `done` event path.

**Pros:**
- **Zero new dependencies** — uses only the VAE and `PIL.Image` already loaded/imported
- **Proven pattern** — this is the default preview method in AUTOMATIC1111's webui since September 2022; documented in HuggingFace diffusers callback docs
- **Minimal integration friction** — latents are already available in `callback_kwargs` at every step; the SSE event dict is untyped and extensible; the frontend `onProgress` handler receives the full parsed JSON
- **Guaranteed quality** — uses the model's own VAE, so intermediate images are exactly what the full pipeline would produce at that denoising state (no quality trade-off)
- **Clean additive path** — gated behind a config flag (`enable_preview_decodes`) and decode interval; pipeline works identically without previews

**Cons:**
- **VAE decode cost** — the full 49M-param VAE decoder adds ~300–500ms per decode on consumer GPU; on MPS (korg-e's target) this is likely 500ms–2s per decode. At every-5-step intervals for 50 steps: 10 decodes × 500ms = ~5 seconds added to generation
- **MPS memory pressure** — intermediate VAE decodes during active denoising may contend with the denoising path for memory. With `enable_vae_slicing` enabled (`backend/config.py:35`) this is mitigated but not eliminated
- **Signature break** — `step_callback` must change from `Callable[[int, int], None]` to `Callable[[int, int, str | None], None]` — backward-incompatible but only 2 call sites exist (both in `routes/generate.py`)

**Complexity:** Medium (~2–3 days)
- Files to modify: 6 (no new files)
- Lines of change: ~60
- Risk level: Medium

### Option 2: TAESD Tiny Autoencoder

**How it works:**
Load a separate tiny VAE (`AutoencoderTiny.from_pretrained("madebyollin/taef1")` — 1.2M params vs the full VAE's 49M) alongside the main pipeline. During generation, decode intermediate latents through TAESD (near-zero cost) for previews, while the full VAE still handles the final output. This is the approach used by AUTOMATIC1111, ComfyUI, Fooocus, InvokeAI, and SD.Next for their progressive previews.

**Pros:**
- **Near-instant decode** — TAESD is ~40× smaller than the full VAE, decodes in ~1–5ms vs ~300–500ms — nearly zero overhead
- **Ecosystem standard** — used by every major diffusion UI (A1111, ComfyUI, Fooocus, InvokeAI, SD.Next); first-class diffusers support via `AutoencoderTiny`
- **TAEF1 variant exists** — `madebyollin/taef1` is explicitly for FLUX/FLUX.1 VAEs, matching Z-Image's encoder family
- **Proven on Z-Image** — the TAESD repo's HuggingFace page documents `taef1` as FLUX-compatible; `AutoencoderTiny` from diffusers provides the integration

**Cons:**
- **Dual VAE memory** — loading both the full VAE (49M params) and TAEF1 (1.2M params) simultaneously increases memory pressure. On MPS with 16GB, Z-Image's 6B model already pushes limits
- **Unknown latent space compatibility** — TAEF1 was trained for FLUX.1's VAE; Z-Image uses a FLUX-derived VAE but may have subtle differences. Requires empirical testing to confirm preview quality
- **Final decode complexity** — must switch from `output_type="pil"` (pipeline handles VAE decode internally) to `output_type="latent"` + manual full VAE decode for the final image, since the pipeline's internal VAE is replaced with TAESD
- **New model download** — first-run must download `madebyollin/taef1` (~5MB), adding latency and a potential failure point
- **Codebase novelty** — no precedent for loading models from a different HF repo or swapping VAE components — the codebase only loads from `settings.model_id`

**Complexity:** Medium-High (~3–5 days)
- Files to modify: ~10
- Lines of change: ~200–260
- Risk level: High (latent space compatibility unknown, dual VAE memory, `output_type` architecture change)

### Option 3: Latent→RGB Projection

**How it works:**
Replace neural VAE decode with a pure linear algebra operation: multiply the intermediate latent tensor by a small calibration matrix to approximate RGB pixels. This is ComfyUI's zero-dependency fallback preview method (`Latent2RGBPreviewer`). Cost is a single `torch.nn.functional.linear` call — sub-millisecond.

**Pros:**
- **Effectively zero cost** — a matrix multiply on a 128×128×16 tensor, sub-millisecond
- **No model download** — the projection matrix is a small constant (16×3 floats for Z-Image), hardcoded or computed once
- **No memory overhead** — no additional VAE or neural network loaded
- **Trivial to remove** — remove the `latents_to_rgb()` call from `_on_step`, revert callback signature

**Cons:**
- **No Z-Image projection matrix exists** — ComfyUI publishes `latent_rgb_factors` for SD1.5, SDXL, SD3, and Flux, but NOT for Z-Image. Z-Image uses a FLUX-derived VAE — the Flux factors *might* work but are unvalidated
- **Recalibration required** — if Flux factors don't work, deriving Z-Image factors requires: hundreds of VAE decodes, least-squares regression `min ||latents @ W + b — RGB||²`, and visual validation. This is days-to-weeks of research, not engineering
- **Low preview quality** — even with perfect calibration, the linear projection produces rough color blobs. ComfyUI itself describes it as a fallback that produces lower quality than TAESD
- **Codebase novelty** — no existing tensor math operations (`einsum`, `torch.matmul`, numpy) anywhere in the project

**Complexity:** Low (code) / High (calibration)
- Files to modify: 5 (code only)
- Lines of change: ~85 (code only)
- Risk level: High (calibration is the dominant cost — could be a dead end)

### Option 4: Client-Side Blur Simulation

**How it works:**
Zero backend changes. When the final image arrives via the `done` SSE event, the frontend renders the `<img>` with CSS `filter: blur(20px)` and a `transition: filter 0.5s ease` that animates to `blur(0px)` on `onLoad`. This creates a "fuzzy → sharp" reveal for the final image but does not show intermediate denoising states.

**Pros:**
- **Zero backend changes** — no VAE decode, no SSE payload changes, no callback signature changes
- **Trivial implementation** — ~15 lines in one file (`ImageOutputNode.tsx`), ~30 minutes
- **Zero memory/performance cost** — CSS filter on the GPU compositor, negligible
- **Zero risk** — cosmetic only, no data path changes

**Cons:**
- **Does not solve the stated problem** — no intermediate denoising previews, just a blur-in animation on the final image. The "fuzzy" state is a blurred version of the completed image, not an intermediate latent
- **Not what GPT/Grok do** — those services show actual intermediate generation states (genuinely fuzzy intermediates that sharpen). This simulates the aesthetic with the final image only
- **No generation feedback** — the user still sees only a progress bar during the 30–90 second generation; the blur animation plays in ~500ms at the end

**Complexity:** Trivial (~30 minutes)
- Files to modify: 1
- Lines of change: ~15
- Risk level: None

## Comparison

| Criteria | VAE Decode (Option 1) | TAESD (Option 2) | Latent→RGB (Option 3) | Client Blur (Option 4) |
|---|---|---|---|---|
| Complexity | Medium | Medium-High | Low (code) / High (calibration) | Trivial |
| Codebase fit | High | Medium-Low | Low | High |
| Risk | Medium | High | High | None |
| Preview quality | Full (model's own VAE) | Good (minor detail loss) | Low (rough blobs) | N/A (not real preview) |
| Backend decode cost | ~0.3–2s per frame | ~1–5ms per frame | <1ms per frame | Zero |
| New dependencies | None | `AutoencoderTiny` + `madebyollin/taef1` (~5MB) | None (but matrix unknown) | None |
| MPS memory impact | Some (VAE contention) | Significant (dual VAE) | None | None |
| Shows actual intermediates | ✅ Yes | ✅ Yes | ⚠️ Approximate | ❌ No |
| Used in production UIs | A1111 (default) | A1111 · ComfyUI · Fooocus · InvokeAI · SD.Next | ComfyUI (fallback) | None (web general) |

## Recommendation

**Selected:** Option 1 — VAE Decode at Intervals

**Rationale:**
- **Directly solves the problem** — shows actual intermediate denoising states, giving the genuine "fuzzy → sharp" experience that GPT/Grok provide
- **Zero new dependencies** — uses only what's already in the codebase (VAE, PIL, base64, asyncio.Queue). TAESD requires a new model download and adds integration risk (dual VAE, output_type change, latent space uncertainty)
- **Latents already available** — `callback_on_step_end_tensor_inputs=["latents"]` at `pipeline.py:161` already requests the tensor this candidate needs. The infrastructure is wired — it's just not consumed
- **Proven pattern** — this is the canonical VAE-based preview approach, documented in diffusers official docs and used in production since 2022
- **Progressive risk mitigation** — start with a conservative decode interval (every 10 steps at 128×128) and tighten based on measured MPS performance. If decode overhead is high, reduce frequency or resolution without architectural changes
- **Clean additive feature** — gated behind a config flag. Pipeline works identically without previews

**Why not alternatives:**
- **Option 2 (TAESD)**: Too much architectural risk for a first preview implementation. Dual VAE on MPS is unproven. The latent space compatibility between TAEF1 and Z-Image is unknown. If VAE Decode (Option 1) proves too slow, TAESD is the natural upgrade path — and by then we'll have real MPS performance data to evaluate whether the swap is worth it
- **Option 3 (Latent→RGB)**: The missing projection matrix is a multi-day research dead end. Even if Flux factors accidentally work, the preview quality is poor (color blobs, not "fuzzy → sharp"). Not worth the calibration effort
- **Option 4 (Client Blur)**: Doesn't solve the problem. It's a nice finishing touch but provides zero feedback during the 30–90 second generation

**Trade-offs:**
- Accepting ~0.3–2s per intermediate decode (MPS-dependent) in exchange for actual progressive previews with zero new dependencies
- Decode overhead is tunable: increase `decode_interval` to reduce frames, decrease `preview_size` to reduce VAE cost
- If overhead is unacceptable, Option 2 (TAESD) remains the upgrade path

**Implementation approach:**
1. **Backend config + pipeline** — Add `preview_decode_interval: int = 5` and `preview_size: int = 256` to `Settings`. Widen `step_callback` to `Callable[[int, int, str | None], None]`. In `_on_step`, decode latents via `pipe.vae.decode()` at the configured interval, produce 256×256 JPEG base64
2. **SSE routing** — Update `step_cb` in both `_run_text_to_image` and `_run_img2img` to accept third parameter and attach `image_b64` to progress dict
3. **Frontend types + integration** — Add `intermediateImage?: string` to `KorgNodeData`. Detect `data.image_b64` in `onProgress` and push to both ZImageGenerateNode (for inline preview) and connected ImageOutputNode
4. **ImageOutputNode progressive display** — Render intermediate images progressively, with an optional CSS blur-unblur transition on the final image (combining Option 4's UX polish with Option 1's real previews)
5. **Manual testing** — Generate with varied prompts at 50 steps, verify progressive sharpening, measure latency overhead on MPS

**Integration points:**
- `backend/pipeline.py:137` — add VAE decode in `_on_step` every N steps
- `backend/pipeline.py:134` — widen `step_callback` to `Callable[[int, int, str | None], None]`
- `backend/routes/generate.py:155,204` — update `step_cb` signatures, add `image_b64` to payload
- `frontend/src/types/workflow.ts:16-33` — add `intermediateImage?: string` to `KorgNodeData`
- `frontend/src/utils/integration.ts:88-93` — detect and forward image data in `onProgress`
- `frontend/src/components/nodes/ImageOutputNode.tsx:15-25` — progressive image display

**Patterns to follow:**
- `callback_on_step_end` VAE decode: diffusers official docs "Display intermediate images" section, [Z-Image issue #55](https://github.com/Tongyi-MAI/Z-Image/issues/55)
- SSE extensible payload: existing pattern at `backend/routes/generate.py:160-169` (add key to dict, no parser changes needed)
- CSS transition: existing pattern at `frontend/src/components/nodes/ZImageGenerateNode.tsx:175` (`transition: "width 0.3s ease"`)

**Risks:**
- **MPS VAE decode latency**: Mitigate with conservative defaults (every 10 steps at 128×128) and configurable interval/size. Measure overhead on first test run
- **SSE base64 frame size**: A 256×256 JPEG is ~15–30KB — well within SSE frame limits. Use JPEG quality 60 to minimize
- **Memory contention**: `enable_vae_slicing` is already enabled (`config.py:35`), which slices VAE decode into smaller chunks. Monitor with `torch.mps.current_allocated_memory()` if issues arise

## Scope Boundaries
- **What we're building**: Configurable VAE-based intermediate image previews streamed via existing SSE transport, displayed progressively in ImageOutputNode
- **What we're NOT doing**: TAESD integration (this round), client-only illusion (vestigial — real previews chosen), latent projection calibration, multi-resolution preview ladder, video/GIF export of generation progression

## Testing Strategy

**Unit tests:**
- Interval logic: decode at steps 5, 10, 15, ... for interval=5; no decode at non-multiples; decode at final step; no decode when interval > total
- SSE payload serialization: base64 JPEG in JSON dict round-trips correctly
- Frontend SSE parser: large base64 payloads don't break `\n\n` frame splitting (vitest)

**Integration tests:**
- Pipeline `_on_step` produces base64 JPEG of correct dimensions and valid image
- `step_cb` signature compatibility (3rd arg is optional `None` for backward compat)
- Frontend `onProgress` handler forwards `image_b64` to node data → ImageOutputNode renders

**Manual verification:**
- [ ] Generate with varied prompts; verify progressive sharpening visible in ImageOutputNode
- [ ] Verify generation without previews (config off) produces identical results
- [ ] Measure latency overhead: compare wall-clock times with/without previews
- [ ] Check MPS memory during generation (Activity Monitor or torch memory stats)
- [ ] Verify SSE keepalive comments still work during long base64 payloads
- [ ] Test multiple consecutive generations (no state leak between runs)

## Open Questions
**Resolved during research:**
- Z-Image uses FLUX-derived 16-channel VAE — `callback_on_step_end_tensor_inputs=["latents"]` already configured and working at `backend/pipeline.py:161`
- SSE events use `Record<string, unknown>` in frontend — adding `image_b64` key is backward-compatible
- `pipe.vae.decode()` is the modern diffusers API for standalone VAE decode (documented in official callbacks guide, Z-Image issue #55)
- TAEF1 (`madebyollin/taef1`) is the FLUX-compatible TAESD variant — but dual VAE on MPS is unproven and latent space compatibility between TAEF1 and Z-Image's VAE is unknown

**Requires user input:**
- Default decode interval: every 5 steps or every 10 steps? (5 = more frames, more overhead; 10 = fewer frames, less overhead. Default to 5, user-adjustable)
- Preview resolution: 128×128 or 256×256? (256 = sharper previews, larger base64 payload; 128 = lighter, fuzzier. Default to 256)

**Blockers:**
- None — the implementation path is clear and all required infrastructure exists

## References

- `.rpiv/artifacts/designs/2026-06-13_07-55-56_simplified-comfyui-image-gen.md` — Original architecture decisions (SSE transport, `callback_on_step_end`, thread→async bridge)
- `.rpiv/artifacts/validation/2026-06-13_09-55-06_simplified-comfyui-image-gen.md` — Known issues (1-indexed step offset, stuck button bug)
- `backend/pipeline.py:137-149` — `_on_step` closure where latents arrive but are discarded
- `backend/pipeline.py:161` — `callback_on_step_end_tensor_inputs=["latents"]` — the exact hook point
- `backend/routes/generate.py:155-169` — `step_cb` → SSE progress event (where `image_b64` would be added)
- `frontend/src/utils/integration.ts:88-97` — `onProgress` handler (where image data would be detected)
- [Diffusers Pipeline Callbacks (official)](https://huggingface.co/docs/diffusers/en/using-diffusers/callback) — Canonical VAE decode in callback pattern
- [Z-Image Issue #55 — working callback decode code](https://github.com/Tongyi-MAI/Z-Image/issues/55) — Verified Z-Image callback code with `image_processor.postprocess`
- [TAESD GitHub](https://github.com/madebyollin/taesd) — Fast preview alternative if VAE decode proves too slow
- [ComfyUI latent_preview.py](https://github.com/Comfy-Org/ComfyUI/blob/master/latent_preview.py) — Reference implementation of TAESD and Latent2RGB previewers
