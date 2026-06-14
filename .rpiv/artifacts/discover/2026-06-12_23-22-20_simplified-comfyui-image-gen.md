---
date: 2026-06-12T23:22:20-0700
author: Eric Sison
commit: no-commit
branch: no-branch
repository: unknown
topic: "Simplified ComfyUI-like Image Generation Webapp"
tags: [intent, frd, z-image, node-graph, fastapi, react-flow]
status: ready
last_updated: 2026-06-12T23:22:20-0700
last_updated_by: Eric Sison
---

# FRD: Simplified ComfyUI-like Image Generation Webapp

## Summary
A standalone web application that provides a simplified node-graph interface (like ComfyUI) for generating images using the Z-Image foundation model (Tongyi-MAI/Z-Image via HuggingFace diffusers). The app supports text-to-image and image-to-image workflows through an intuitive drag-and-drop node canvas, with real-time generation progress, local disk output, and JSON workflow save/load — all running locally on the developer's Mac.

## Problem & Intent
"Write a webapp that looks like ComfyUI but simplified. It will let me generate an image from a text prompt or from a text prompt and starting image uploaded by the user. Use z-image."

Building for personal solo use — a simpler, more focused alternative to ComfyUI's full complexity, specifically tuned for Z-Image image generation with a clean node-graph workflow builder.

## Goals
- Provide a visual node-graph editor where users connect nodes (text prompt, image upload, Z-Image generate, image output) to build generation workflows
- Support text-to-image (prompt → image) and image-to-image (prompt + uploaded image → image) generation pipelines
- Render real-time denoising progress during generation (image gradually emerges)
- Save and load node-graph workflows as JSON files for reuse
- Run entirely localhost on the developer's Mac with no external dependencies
- Expose core Z-Image parameters: steps, CFG scale, seed (randomizable), and resolution

## Non-Goals
- Video generation (Z-Image is image-only; Wan2GP in sibling project `korg` handles video)
- Cloud storage or remote image hosting
- Multi-user support, authentication, or access control
- Node types beyond the minimal set (no ControlNet, LoRA weighting, upscaling, mask/inpaint, or batch processing in v1)
- MLX or alternative inference backends — Z-Image via diffusers/PyTorch only
- Reusing Wan2GP runtime from the sibling `korg` project

## Functional Requirements
1. The system SHALL provide a React-based web UI with a React Flow node-graph canvas where users can drag, connect, and configure nodes
2. The system SHALL include at minimum four node types: Text Prompt, Image Upload (for I2I), Z-Image Generate, and Image Output
3. The system SHALL expose adjustable parameters on the Z-Image Generate node: steps, CFG scale, seed (with randomize button), and resolution presets
4. The system SHALL support text-to-image workflows (Text Prompt → Z-Image Generate → Image Output) and image-to-image workflows (Text Prompt + Image Upload → Z-Image Generate → Image Output)
5. The system SHALL run Z-Image inference via the HuggingFace `diffusers` library (model: `Tongyi-MAI/Z-Image` or `Tongyi-MAI/Z-Image-Turbo`)
6. The system SHALL provide real-time progress feedback during generation, showing denoising step progress to the user
7. The system SHALL save generated images to a local output directory (e.g., `~/.korg-e/outputs/`)
8. The system SHALL allow users to export their current node graph as a JSON file and import it back to restore the workflow
9. The system SHALL serve the React frontend and expose a FastAPI backend on localhost (default port configurable via environment variable)
10. The system SHALL display generated images in the Image Output node with a download option

## Non-Functional Requirements
- **Performance**: Z-Image inference should complete in sub-second to several seconds on consumer hardware (16GB+ VRAM). Generation progress should update at least once per denoising step. UI must remain responsive during generation via async backend.
- **Security**: No authentication required (localhost-only, personal use). Input validation on file uploads (image format, size limits). No secrets or credentials stored in code.
- **UX / Accessibility**: Clean, dark-themed UI inspired by ComfyUI's aesthetic. Intuitive node dragging and connection. Clear visual feedback for generation state (idle, running, complete, error). Responsive canvas with zoom/pan.
- **Reliability**: Backend handles GPU OOM and model loading errors gracefully, returning clear error messages to the frontend. Failed generations do not corrupt saved workflows.

## Constraints & Assumptions
- **Platform**: Apple Silicon Mac (consistent with sibling `korg` project's hardware target)
- **Hardware**: 16GB+ VRAM required for Z-Image (6B parameter model); inference runs via PyTorch/MPS
- **Model source**: Z-Image model downloaded from HuggingFace (`Tongyi-MAI/Z-Image` or `Tongyi-MAI/Z-Image-Turbo`) via `diffusers` on first use
- **Network**: One-time model download from HuggingFace; inference is fully offline after model is cached
- **Architecture**: Standalone project — no dependency on sibling `korg` project or Wan2GP runtime
- **Assumption**: Z-Image diffusers pipeline supports both text-to-image and image-to-image modes (consistent with its diffusion transformer architecture)

## Acceptance Criteria
- [ ] Running `python backend/main.py` (or equivalent) starts a FastAPI server serving the React frontend on localhost
- [ ] Opening the UI in a browser displays a blank React Flow canvas with an "Add Node" menu or palette
- [ ] User can drag a Text Prompt node onto the canvas, edit its text content, and connect it to a Z-Image Generate node
- [ ] User can add an Image Upload node, upload a PNG/JPG image, and connect it as a conditioning input to the Z-Image Generate node for image-to-image mode
- [ ] Adjusting steps, CFG scale, seed, and resolution on the Z-Image Generate node updates the parameters sent to the backend
- [ ] Clicking "Generate" triggers inference and the UI shows real-time progress (step counter or progress bar) as denoising completes
- [ ] Upon completion, the generated image appears in an Image Output node and is saved to `~/.korg-e/outputs/`
- [ ] Exporting the workflow saves a valid JSON file; importing it restores the exact node layout and parameters
- [ ] The entire application runs without external network access after initial model download
- [ ] No authentication screen or login flow — UI is immediately accessible at `http://localhost:<port>`

## Recommended Approach
A FastAPI Python backend that loads Z-Image via `diffusers` on demand, exposes a REST + WebSocket/SSE API for workflow execution and progress streaming, and serves the React frontend. The frontend uses React Flow for the node-graph canvas with custom node components for each workflow element. Generated images are stored in a local `~/.korg-e/outputs/` directory. Project structure: monorepo-style with `backend/` (Python/FastAPI) and `frontend/` (React/Vite + React Flow).

## Decisions

### Standalone project
**Question**: From the probe — korg-e is completely empty (greenfield). The sibling project `korg` has a Wan2GP + Gradio setup for video generation. Should this new webapp be a standalone project or share/reuse the Wan2GP runtime from `korg`?
**Recommended**: Standalone (Recommended) — Build a fresh, self-contained project in korg-e. No dependency on korg's Wan2GP — you control the full stack.
**Chosen**: Standalone — build a fresh, self-contained project in korg-e with no dependency on `korg`'s Wan2GP runtime.
**Rationale**: User confirmed standalone. Keeps this project independent and focused on image generation (not video).

### Node-graph workflow builder
**Question**: What's the primary goal for this webapp? 'Simplified ComfyUI' could mean different things — what should this do that you can't already do today?
**Recommended**: Node-based workflow builder (Recommended) — A visual node-graph editor like ComfyUI where you connect nodes to build generation workflows. Simplified = fewer node types, cleaner UI.
**Chosen**: Node-based workflow builder — simplified ComfyUI-style node graph editor.
**Rationale**: User confirmed. The value proposition is ComfyUI's flexibility with reduced complexity.

### z-image model identification
**Question**: What exactly is z-image in your context? Is it an API endpoint, a local model server, a specific image generation model, or something else?
**Recommended**: API service / Local model server — clarified via web research.
**Chosen**: Z-Image is a 6B-parameter diffusion transformer model by Tongyi-MAI (Alibaba), available on HuggingFace as `Tongyi-MAI/Z-Image` and `Tongyi-MAI/Z-Image-Turbo`, compatible with the `diffusers` library. Supports text-to-image and image-to-image with sub-second inference on consumer GPUs.
**Rationale**: Web research confirmed: https://huggingface.co/Tongyi-MAI/Z-Image, https://huggingface.co/papers/2511.22699

### z-image invocation interface
**Question**: How do you invoke z-image? Is there a CLI tool, Python library, REST API, or some other interface?
**Recommended**: Researched via web search — diffusers-compatible Python library.
**Chosen**: Z-Image is invoked via the HuggingFace `diffusers` Python library (pipeline-based inference), consistent with its availability as a diffusers pipeline.
**Rationale**: Confirmed by web research showing `diffusers/api/pipelines/z_image` documentation.

### Minimal node set for v1
**Question**: What nodes do you need in v1?
**Recommended**: Minimal (Recommended) — Text Prompt, Image Upload, Z-Image Generate, Image Output. Core T2I + I2I flow.
**Chosen**: Minimal node set: Text Prompt, Image Upload, Z-Image Generate, Image Output.
**Rationale**: User confirmed minimal. Deliberately excludes ControlNet, LoRA, upscaling, mask/inpaint, and batch processing from v1.

### Tech stack: Python backend + React frontend
**Question**: What tech stack do you prefer for this standalone project?
**Recommended**: Python backend + React/Vue frontend (Recommended) — FastAPI or Flask backend calling z-image via diffusers, with a React or Vue frontend for the node graph.
**Chosen**: Python backend (FastAPI) + React frontend.
**Rationale**: User confirmed Python + React/Vue. React chosen over Vue due to React Flow preference.

### Node-graph canvas: React Flow
**Question**: For the node-graph canvas, which library do you prefer?
**Recommended**: React Flow (Recommended) — Most popular React node-graph library with great docs and active community.
**Chosen**: React Flow.
**Rationale**: User confirmed React Flow. Best-in-class for React-based node graphs.

### Backend framework: FastAPI
**Question**: For the Python backend, which framework do you prefer?
**Recommended**: FastAPI (Recommended) — Modern async Python web framework, great for ML inference APIs with auto OpenAPI docs and background task support.
**Chosen**: FastAPI.
**Rationale**: User confirmed. Best fit for async ML inference with real-time progress streaming.

### Real-time generation progress
**Question**: How should generation work — real-time progress updates or fire-and-forget?
**Recommended**: Real-time progress (Recommended) — WebSocket or SSE streaming showing denoising steps as they happen.
**Chosen**: Real-time progress via SSE (Server-Sent Events) or WebSocket.
**Rationale**: User confirmed. SSE is simpler for server→client only streaming; WebSocket if bidirectional communication is needed later.

### Local disk storage
**Question**: Where should generated images be saved?
**Recommended**: Local disk (Recommended) — Save to a local output directory. Simple, no dependencies.
**Chosen**: Local disk at `~/.korg-e/outputs/`.
**Rationale**: User confirmed. Consistent with sibling project's `~/.korg/` convention.

### Workflow save/load as JSON
**Question**: Should the node graph support saving/loading workflows as JSON files?
**Recommended**: Yes, save/load JSON (Recommended) — Export and import node graphs as JSON files for reusable workflows.
**Chosen**: Full JSON export/import support.
**Rationale**: User confirmed. Essential for workflow reuse and sharing.

### Core Z-Image parameters
**Question**: Which Z-Image parameters should be exposed as adjustable node properties?
**Recommended**: Core params (Recommended) — Steps, CFG scale, seed (randomizable), and resolution.
**Chosen**: Steps, CFG scale, seed (with randomize button), resolution presets.
**Rationale**: User confirmed core set. Negative prompt, scheduler type, and latent options deferred to later iterations.

### Localhost-only access
**Question**: Should the backend run on the same machine as the UI or be accessible from other machines?
**Recommended**: Localhost only (Recommended) — Backend and frontend both run on your Mac. Simple, no network config.
**Chosen**: Localhost only, bound to 127.0.0.1.
**Rationale**: User confirmed. Personal solo use tool.

### No authentication
**Question**: Do you need any authentication for the localhost-only UI?
**Recommended**: No auth (Recommended) — Open access on localhost, no login needed.
**Chosen**: No authentication required.
**Rationale**: User confirmed. Localhost-only personal tool.

## Open Questions
- Which exact Z-Image model variant to default to: `Tongyi-MAI/Z-Image` (full 6B) or `Tongyi-MAI/Z-Image-Turbo` (optimized for speed)? Turbo may be better for interactive use but full version may produce higher quality.
- How to handle initial model download UX — should the UI show a "loading model" state with progress, or is a one-time wait acceptable?
- Should the app include a default starter workflow on first launch (e.g., pre-placed Text Prompt → Z-Image Generate → Image Output), or start completely blank?

## Suggested Follow-ups
- Consider adding a "preset" system for common generation configurations (portrait, landscape, photorealistic, anime) — would reduce parameter tweaking for casual use.
- The sibling `korg` project's LoRA infrastructure (`download-lora.sh`, `~/.korg/models/loras/`) could be adapted for Z-Image LoRA support in a future iteration.
- If generation quality needs comparison, a side-by-side view of multiple seeds/variations would be valuable (not in v1 scope).

## References
- Input: free-text feature description — "write a webapp that looks like comfyui but simplified"
- Z-Image model: https://huggingface.co/Tongyi-MAI/Z-Image
- Z-Image paper: https://huggingface.co/papers/2511.22699
- Z-Image diffusers docs: https://huggingface.co/docs/diffusers/api/pipelines/z_image
- Z-Image Turbo: https://huggingface.co/Tongyi-MAI/Z-Image-Turbo
- Sibling project `korg` (context only, not in scope): `/Users/esison/Development/projects/tools/korg/`
