---
date: 2026-06-13T07:30:00-0700
author: Eric Sison
commit: no-commit
branch: no-branch
repository: korg-e
topic: "Simplified ComfyUI-like Image Generation Webapp — Architecture Research"
tags: [research, z-image, fastapi, react-flow, diffusers, greenfield]
status: ready
last_updated: 2026-06-13T07:30:00-0700
last_updated_by: Eric Sison
---

# Research: Simplified ComfyUI-like Image Generation Webapp — Architecture Research

## Research Question
Design the architecture for a standalone web application that provides a simplified node-graph interface (like ComfyUI) for generating images using the Z-Image foundation model via HuggingFace diffusers. The app supports text-to-image and image-to-image workflows through a drag-and-drop node canvas, with real-time generation progress, local disk output, and JSON workflow save/load — all running locally on the developer's Mac.

## Summary
korg-e is a completely greenfield repository — no source code exists. The sibling `korg` project (Wan2GP + Gradio video generation) has bash-script orchestration only; no Python or JavaScript code transfers, but its architectural conventions provide philosophical guidance. The architecture consists of two independent sub-projects: a FastAPI Python backend (Z-Image inference via diffusers, SSE progress streaming, image serving) and a React/Vite frontend (React Flow canvas, Zustand store, custom node components). Key decisions: Full 6B Z-Image model, SSE for real-time progress, lazy model loading with SSE progress events, pre-placed starter workflow, Zustand for state management.

## Detailed Findings

### Project State
- **korg-e**: Completely empty — only `.git/` and `.rpiv/artifacts/discover/`. No commits on `main` branch.
- **Sibling korg**: Bash scripts + Wan2GP wrapper. No Python/JS source code. Architecture documented in `ARCHITECTURE.md` with conventions: single data root (`$KORG_HOME`), localhost-only, idempotent scripts, symlink bridges for persistence.
- **No existing patterns transfer** — this is a full greenfield build.

### Z-Image Model & diffusers Pipeline
- **Model**: `Tongyi-MAI/Z-Image` (6B-parameter diffusion transformer by Tongyi-MAI/Alibaba)
- **Turbo variant**: `Tongyi-MAI/Z-Image-Turbo` — optimized for speed (~2-4 steps vs 20-50 for full)
- **User decision**: Default to Full 6B for higher quality
- **Pipeline**: Available via HuggingFace `diffusers` library as `ZImagePipeline`
- **Invocation**: Pipeline-based API (not REST/CLI) — instantiate pipeline, call with prompt + optional image
- **Platform**: Apple Silicon MPS backend (PyTorch)
- **VRAM**: ~16GB+ required for 6B model on MPS

### Backend Architecture (FastAPI)
- **Framework**: FastAPI (async, auto OpenAPI docs, background task support)
- **Model loading strategy**: Lazy load on first generation request (server starts instantly)
- **Progress streaming**: SSE (Server-Sent Events) — server→client only, simpler than WebSocket
- **Image storage**: Local disk at `~/.korg-e/outputs/{timestamp}_{seed}.png`
- **Image serving**: FastAPI `StaticFiles` mount at `/outputs/`
- **Health endpoint**: `/health` returning model-loaded status (useful for lazy loading UX)

### Frontend Architecture (React + Vite + React Flow)
- **Framework**: React 18+ with Vite build tool
- **Canvas**: React Flow for node-graph editor
- **State management**: Zustand store as single source of truth, synced with React Flow
- **Node types** (v1): Text Prompt, Image Upload, Z-Image Generate, Image Output
- **Default workflow**: Pre-placed Text Prompt → Z-Image Generate → Image Output on first launch
- **Progress display**: Browser `EventSource` consuming SSE events, updating node UI in real-time

### Data Flow Architecture
```
User edits nodes in React Flow canvas
  → Zustand store maintains canonical graph state
  → User clicks "Generate" on Z-Image Generate node
  → Frontend serializes graph → POST /api/generate {nodes, edges}
  → Backend validates graph topology, extracts parameters
  → Backend instantiates (or reuses) ZImagePipeline
  → Pipeline runs with step-level progress callbacks
  → Progress events streamed via SSE: {step, total, image_url?}
  → Generated image saved to ~/.korg-e/outputs/
  → Completion event sent via SSE
  → Frontend Image Output node updates with new image URL
```

### Project Structure (proposed)
```
korg-e/
├── backend/
│   ├── main.py              # FastAPI app entry point
│   ├── config.py            # Settings (env vars, data root)
│   ├── pipeline.py          # Z-Image pipeline wrapper
│   ├── routes/
│   │   ├── generate.py      # POST /api/generate (SSE)
│   │   ├── images.py        # GET /outputs/, GET /api/images
│   │   └── workflow.py      # POST /api/workflow/save, /api/workflow/load
│   └── utils/
│       ├── storage.py       # Image save/list/delete
│       └── validation.py    # Graph topology validation
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Canvas.tsx           # React Flow canvas container
│   │   │   ├── nodes/               # Custom node components
│   │   │   │   ├── TextPromptNode.tsx
│   │   │   │   ├── ImageUploadNode.tsx
│   │   │   │   ├── ZImageGenerateNode.tsx
│   │   │   │   └── ImageOutputNode.tsx
│   │   │   └── Toolbar.tsx          # Add node menu, Generate button
│   │   ├── store/
│   │   │   └── useWorkflowStore.ts  # Zustand workflow state
│   │   ├── types/
│   │   │   └── workflow.ts           # TypeScript interfaces
│   │   └── utils/
│   │       ├── sse.ts                # SSE client helper
│   │       └── jsonExport.ts         # Workflow JSON serialization
│   └── package.json
├── scripts/
│   ├── setup.sh       # Environment validation + dependency install
│   └── start.sh       # Launch backend (and optionally frontend dev server)
└── .env.example       # Configuration template
```

## Code References
- `~/.korg/ARCHITECTURE.md` — Sibling project architecture conventions (single data root, localhost-only, idempotent scripts)
- `https://huggingface.co/Tongyi-MAI/Z-Image` — Z-Image model card with architecture details
- `https://huggingface.co/docs/diffusers/api/pipelines/z_image` — Z-Image diffusers pipeline documentation
- `https://reactflow.dev/learn/node-editor/introduction` — React Flow documentation for node-graph patterns

## Integration Points

### Inbound References
- **None yet** — greenfield project, no existing code references this

### Outbound Dependencies
- **HuggingFace diffusers library** — `ZImagePipeline` class for inference
- **React Flow** — npm package for canvas rendering and node management
- **Zustand** — npm package for frontend state management
- **FastAPI** — Python web framework for API server

### Infrastructure Wiring
- **Data root**: `$KORG_E_HOME` (default `~/.korg-e/`) — separate from sibling `korg`'s `$KORG_HOME` (`~/.korg/`)
- **Subdirectories**: `~/.korg-e/outputs/`, `~/.korg-e/models/` (HF cache), `~/.korg-e/config/`
- **Backend port**: Configurable via `KORG_E_PORT` env var (default 8000)
- **Frontend dev**: Vite HMR on port 5173 (separate from backend in dev mode)

## Architecture Insights
1. **Standalone architecture**: No shared code with sibling `korg`. Each project owns its full stack independently.
2. **Convention alignment**: While standalone, korg-e follows sibling conventions philosophically: single data root, localhost-only binding, idempotent setup scripts, no external dependencies beyond what's explicitly specified.
3. **Greenfield advantage**: No legacy constraints. Can design the JSON workflow schema and API contracts from first principles.
4. **SSE over WebSocket**: For server→client only progress streaming, SSE is simpler (built into FastAPI via `ServerSentEvents`, native browser `EventSource` API, auto-reconnect). WebSocket adds complexity without clear benefit for v1.
5. **Lazy model loading + SSE**: Combining lazy loading with SSE progress creates a good UX — server starts instantly, first generation shows download/load progress via SSE events, subsequent generations are fast (model cached).

## Precedents & Lessons
0 similar past changes in korg-e (greenfield project).

### Sibling Project Context: korg
**Key insight**: korg uses bash scripts + Wan2GP wrapper with symlink bridges. No translatable code, but architectural philosophy applies:
- Single data root under `~/.korg/` → korg-e uses `~/.korg-e/` (consistent naming pattern)
- Localhost-only binding → same approach for korg-e
- Idempotent setup scripts → follow same pattern for `scripts/setup.sh`
- No pre-download of models → lazy loading aligns with this philosophy

### Composite Lessons
1. **Separate data roots per project**: Each sibling project uses its own `~/.korg*` directory. korg-e's `~/.korg-e/` avoids conflicts and keeps projects independent.
2. **Bash orchestration for setup/start**: korg's `scripts/setup.sh` and `scripts/start.sh` pattern works well for local ML tools. Follow this for korg-e.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/discover/2026-06-12_23-22-20_simplified-comfyui-image-gen.md` — Feature Requirements Document with 15 decisions and 3 open questions

## Developer Context
**Q (discover: Standalone project): Should korg-e share/reuse Wan2GP runtime from sibling `korg`?**
A: Standalone — build a fresh, self-contained project in korg-e with no dependency on `korg`'s Wan2GP runtime.

**Q (discover: z-image invocation interface): How do you invoke z-image?**
A: Via HuggingFace `diffusers` Python library (pipeline-based inference).

**Q (discover: Real-time generation progress): How should generation work — real-time or fire-and-forget?**
A: Real-time progress via SSE (Server-Sent Events).

**Q (discover: Local disk storage): Where should generated images be saved?**
A: `~/.korg-e/outputs/`.

**Q (discover: Workflow save/load as JSON): Should the node graph support saving/loading workflows as JSON files?**
A: Full JSON export/import support.

**Q (discover: Core Z-Image parameters): Which Z-Image parameters should be adjustable?**
A: Steps, CFG scale, seed (with randomize button), resolution presets.

**Q (`no-code`): Which exact Z-Image model variant to default to?**
A: Full 6B `Tongyi-MAI/Z-Image` (not Turbo) — higher quality for interactive use.

**Q (`no-code`): SSE vs WebSocket for real-time progress?**
A: SSE — simpler, sufficient for server→client step-level progress streaming.

**Q (`no-code`): Default starter workflow on first launch?**
A: Pre-placed Text Prompt → Z-Image Generate → Image Output workflow.

**Q (`no-code`): Eager vs lazy model loading?**
A: Lazy load — server starts instantly, first generation triggers download+load with SSE progress events.

**Q (`no-code`): Frontend state management approach?**
A: Zustand store as single source of truth, separate from React Flow's internal canvas state.

## Related Research
- None yet

## Open Questions
- What exact diffusers pipeline `__call__` signature does `ZImagePipeline` expose for text-to-image vs image-to-image modes? (Needs empirical verification: `pip install diffusers` + `inspect.signature(ZImagePipeline.__call__)`)
- How much VRAM does the 6B model actually consume on MPS? (Needs empirical measurement)
- What error types does `diffusers` raise for GPU OOM, model corruption, and input dimension mismatches on MPS? (Needs empirical verification)
- Should the backend serve the built React frontend directly (via `StaticFiles`) or run as separate dev servers with CORS? (Decision deferred to implementation phase)
