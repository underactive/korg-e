# korg-e

**A simplified ComfyUI-like node-graph webapp for local image generation using the Z-Image model on Apple Silicon.**

Drop a text prompt node, tweak generation parameters, hit Generate — images stream back with live progress, no cloud required. Supports text-to-image and img2img (upload a starting image). Runs entirely on your Mac.

![Workflow: Text Prompt → Z-Image Generate → Image Output](docs/workflow-overview.png)

---

## Table of Contents

- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)

---

## Requirements

| What                | Minimum                          |
| ------------------- | -------------------------------- |
| **Hardware**        | Mac with Apple Silicon (M1/M2/M3/M4) |
| **RAM**             | 16 GB (32 GB+ recommended for best quality) |
| **macOS**           | 14 (Sonoma) or later — required for `bfloat16` on MPS |
| **Python**          | 3.10, 3.11, or 3.12    |
| **Node.js**         | 18+ (bundled with npm)           |
| **Disk**            | ~25 GB free (Z-Image 6B model download ~12 GB) |

> **Why Sonoma?** macOS 14 is the first release with `bfloat16` support on Apple's Metal Performance Shaders (MPS). korg-e uses bfloat16 to halve memory usage during inference.

---

## Quick Start

### 1. Clone the repo

```bash
git clone <repo-url> korg-e
cd korg-e
```

### 2. Run setup

```bash
./scripts/setup.sh
```

This will:
- Verify your Mac is Apple Silicon + macOS 14+
- Find a suitable Python 3.10+ installation
- Create a Python virtualenv at `~/.korg-e/venv/`
- Install pip dependencies (torch, fastapi, diffusers from source, transformers)
- Run `npm install` for the frontend
- Copy `.env.example` → `.env` (customize if desired)

The first run takes 5-10 minutes while pip downloads and compiles packages.

### 3. Start the app

```bash
# Backend only (API at http://127.0.0.1:8000):
./scripts/start.sh

# Backend + frontend dev server (UI at http://127.0.0.1:5173):
./scripts/start.sh --dev
```

#### Run as a service (Linux)

`start.sh` dies with your terminal. On a headless box, install the user
systemd unit instead (assumes the repo is cloned at `~/korg-e`; edit
`WorkingDirectory` in the unit otherwise):

```bash
mkdir -p ~/.config/systemd/user
cp scripts/korg-e.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now korg-e
loginctl enable-linger   # start at boot, survive logout
```

Logs: `journalctl --user -u korg-e -f`. With no dev server running, build
the UI once (`cd frontend && npm run build`) and the backend serves it at
`http://$KORG_E_HOST:8000/`.

### 4. Open the UI

Visit **http://localhost:5173** in your browser. You'll see a pre-placed starter workflow with three connected nodes:

```
┌─────────────┐      ┌──────────────────┐      ┌──────────────┐
│ Text Prompt │ ──── │ Z-Image Generate │ ──── │ Image Output │
└─────────────┘      └──────────────────┘      └──────────────┘
```

### 5. Generate your first image

1. Click the **Text Prompt** node and type a description (e.g. "a cat wearing a top hat, oil painting")
2. Click **Generate** on the Z-Image Generate node
3. Watch the progress bar animate as inference steps run
4. Your image appears in the **Image Output** node

> **First generation is slow (~1-3 minutes).** korg-e lazy-loads the 6B parameter Z-Image model on the first request — you'll see SSE progress messages for downloading, loading, and optimizing. Subsequent generations start immediately.

---

## How It Works

### The Node Graph

korg-e uses a **node graph interface** inspired by ComfyUI. You connect nodes with drag-and-drop edges to build an image generation pipeline.

### Node Types

| Node               | Purpose                                               |
| ------------------ | ----------------------------------------------------- |
| **Text Prompt**    | Type your prompt. Outputs a text string.              |
| **Image Upload**   | Upload a starting image for img2img. Outputs base64 image data. |
| **Z-Image Generate** | The engine. Connects prompt (required) + optional image, runs inference, outputs the result. |
| **Image Output**   | Displays the generated image and seed value.          |

### Building a workflow

1. Click **"+ Add node"** in the toolbar to add nodes
2. Drag from a handle (small circle on node edge) to connect nodes
3. Double-click the canvas background to pan; scroll to zoom
4. Adjust parameters (steps, CFG scale, seed, resolution) on the **Z-Image Generate** node

### Text-to-Image

```
[Text Prompt] ──prompt──→ [Z-Image Generate] ──image──→ [Image Output]
```

Type a prompt, click Generate.

### Image-to-Image (img2img)

```
[Text Prompt] ──prompt──→ [Z-Image Generate] ──image──→ [Image Output]
[Image Upload] ──image──┘
```

Upload a starting image, describe what you want in the prompt, click Generate.

### During Generation

- The Z-Image Generate node shows a **progress bar** with step-by-step progress
- The status changes: `idle` → `loading` → `generating` → `complete` (or `error`)
- **Errors** appear inline on the node
- **Cancel** by closing the browser tab (the backend detects disconnection and stops inference)

### Saving & Loading

1. Give your workflow a name in the toolbar input (default: "my-workflow")
2. Click **Save** — workflow JSON is persisted to `~/.korg-e/workflows/<name>.json`
3. Click **Load** to restore a saved workflow
4. Click **Reset** to go back to the starter workflow

Saved images live at `~/.korg-e/outputs/` — each PNG has a sidecar `.json` file with prompt, seed, and timestamp metadata.

---

## Configuration

All settings live in `.env` (created from `.env.example` on first setup):

```bash
# Data root for generated images, workflows, model cache, and Python venv
# Default: ~/.korg-e
KORG_E_HOME="$HOME/.korg-e"

# Backend port
# Default: 8000
KORG_E_PORT="8000"

# Uvicorn log level: debug, info, warning, error
# Default: info
KORG_E_LOG_LEVEL="info"

# HuggingFace cache directory (model weights stored here)
# Default: $KORG_E_HOME/cache
HF_HOME="$KORG_E_HOME/cache"
```

### Model settings (hardcoded in `backend/config.py`)

| Setting                    | Default                 | Notes |
| -------------------------- | ----------------------- | ----- |
| Model                      | `Tongyi-MAI/Z-Image`    | 6B parameter full model |
| Device                     | `mps`                   | Apple Metal Performance Shaders |
| Precision                  | `bfloat16`              | Half-memory, Apple Silicon native |
| Attention slicing          | Enabled                 | Reduces peak memory (~20% speed tradeoff) |
| VAE slicing                | Enabled                 | Reduces VAE decode memory |
| Generation steps           | 50                      | Override per-node in the UI |
| CFG scale                  | 5.0                     | Classifier-free guidance (1-20 in UI) |
| Resolution                 | 1024×1024               | Options: 512, 768, 1024 |

> **Change the model?** Set `KORG_E_HOME` to a different path before running setup to create a separate environment. The `model_id` in `backend/config.py` can also point to a local path for custom fine-tuned models.

---

## API Reference

### Health Check

```bash
curl http://localhost:8000/health
# → {"status": "ok", "model_loaded": false}
```

### Generate (SSE streaming)

```bash
curl -N -X POST http://localhost:8000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "nodes": [
      {"id": "text_1", "type": "textPrompt", "data": {"prompt": "a cat"}},
      {"id": "gen_1", "type": "zImageGenerate", "data": {"steps": 50, "cfgScale": 5.0, "seed": 42}},
      {"id": "out_1", "type": "imageOutput", "data": {}}
    ],
    "edges": [
      {"id": "e1", "source": "text_1", "sourceHandle": "prompt", "target": "gen_1", "targetHandle": "prompt"},
      {"id": "e2", "source": "gen_1", "sourceHandle": "image", "target": "out_1", "targetHandle": "image"}
    ]
  }'
```

**SSE event stream:**

```
event: progress
data: {"status":"loading","phase":"downloading"}

event: progress
data: {"status":"generating","step":1,"total":50}

event: progress
data: {"status":"generating","step":2,"total":50}

...

event: progress
data: {"status":"saving"}

event: done
data: {"status":"complete","image_url":"/images/20260613_120000_42.png","seed":42}
```

**Error case:**

```
event: error
data: {"status":"error","message":"Workflow must contain at least one Z-Image Generate node."}
```

### List Images

```bash
curl http://localhost:8000/api/images?limit=10&offset=0
# → {"images": [{"filename": "abc123.png", "prompt": "...", "seed": 42, "timestamp": "..."}], "total": 1, "limit": 10, "offset": 0}
```

### Access Generated Images

```bash
# Images are served via FastAPI static files:
curl http://localhost:8000/images/20260613_120000_42.png --output result.png
```

### Save Workflow

```bash
curl -X POST http://localhost:8000/api/workflow/save \
  -H "Content-Type: application/json" \
  -d '{"name": "my-workflow", "workflow": {"nodes": [...], "edges": [...]}}'
# → {"status": "ok", "name": "my-workflow"}
```

### Load Workflow

```bash
curl -X POST http://localhost:8000/api/workflow/load/my-workflow
# → {"name": "my-workflow", "workflow": {"nodes": [...], "edges": [...]}}
```

### List Saved Workflows

```bash
curl http://localhost:8000/api/workflows
# → ["my-workflow", "another-workflow"]
```

---

## Troubleshooting

### Setup fails: "Apple Silicon required"

korg-e requires a Mac with Apple Silicon (M1/M2/M3/M4). Intel Macs are not supported because the Z-Image model uses `bfloat16` precision which is only available on MPS with Apple Silicon.

### Setup fails: "macOS 14+ required"

The `bfloat16` data type is only available on macOS Sonoma or later. Upgrade via System Settings → Software Update.

### "No module named 'torch'" on startup

The virtualenv hasn't been set up or activated. Run `./scripts/setup.sh` first. The start script activates the venv automatically.

### "Permission denied" or ModuleNotFoundError on import

If `HF_HOME` points to an external drive that isn't mounted or accessible, config import fails. Set `HF_HOME` to a local path in `.env`:

```bash
HF_HOME="$HOME/.korg-e/cache"
```

### First generation is very slow (5+ minutes)

Expected. The 6B parameter model (~12 GB) is downloaded from HuggingFace on first use and loaded into memory. You'll see progress events: `downloading` → `loading` → `optimising` → `ready`. Subsequent generations start in seconds.

### Out of memory errors

If your Mac has < 32 GB RAM, reduce resolution to 512×512 on the Z-Image Generate node. The attention and VAE slicing optimizations are enabled by default and help, but the full 1024×1024 at 50 steps can push memory limits on 16 GB machines.

### Port 8000 already in use

Set a different port:

```bash
KORG_E_PORT=8001 ./scripts/start.sh
```

If using the dev server, also update the Vite proxy target in `frontend/vite.config.ts`.

### "Model not loaded" from API

This shouldn't happen with normal usage (the pipeline lazy-loads automatically). If you see this error, the `app.state.model_pipeline` was assigned `None` instead of a `PipelineWrapper()` — check `backend/main.py` has `app.state.model_pipeline = PipelineWrapper()`.

### SSE connection drops or hangs

EventSource/`fetch` streaming requires the backend to be reachable. If you're using a proxy or VPN, ensure `127.0.0.1:8000` is accessible. The frontend dev server's Vite proxy at `/api` should handle this automatically.

---

## Architecture

```
korg-e/
├── backend/
│   ├── main.py               # FastAPI app entry, CORS, health, static files
│   ├── config.py             # Environment-based settings
│   ├── pipeline.py           # Z-Image diffusers wrapper (lazy load, MPS optimizations)
│   ├── routes/
│   │   ├── generate.py       # POST /api/generate — SSE streaming endpoint
│   │   ├── images.py         # GET /api/images — list generated images
│   │   └── workflow.py       # POST /api/workflow/save, load, GET /workflows
│   └── utils/
│       ├── storage.py        # Save/load/delete image files + sidecar JSON
│       └── validation.py     # Graph topology validation + parameter extraction
├── frontend/
│   ├── src/
│   │   ├── App.tsx           # Root: ReactFlowProvider + Toolbar + Canvas
│   │   ├── main.tsx          # Vite entry point
│   │   ├── components/
│   │   │   ├── Canvas.tsx    # React Flow canvas, node type registration
│   │   │   ├── Toolbar.tsx   # Add node dropdown, save/load/reset controls
│   │   │   └── nodes/
│   │   │       ├── TextPromptNode.tsx
│   │   │       ├── ImageUploadNode.tsx
│   │   │       ├── ZImageGenerateNode.tsx
│   │   │       └── ImageOutputNode.tsx
│   │   ├── store/
│   │   │   └── useWorkflowStore.ts  # Zustand store (single source of truth)
│   │   ├── types/
│   │   │   └── workflow.ts   # TypeScript interfaces (KorgNode, SSE events, etc.)
│   │   └── utils/
│   │       ├── sse.ts        # fetch-based SSE client with abort support
│   │       ├── integration.ts # CustomEvent → SSE → store wiring hook
│   │       └── jsonExport.ts # Workflow JSON serialize/deserialize
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts        # Vite config with API proxy to backend
├── scripts/
│   ├── korg-e.service        # User systemd unit for headless deployments
│   ├── setup.sh              # Environment validation + dependency install
│   └── start.sh              # Launch backend (+ optional frontend)
├── .env.example              # Environment variable template
└── README.md                 # This file
```

### Data Flow

```
┌──────────────┐     CustomEvent      ┌──────────────┐
│  Node Graph   │ ── "korg:generate"──→│  Integration  │
│  (React Flow) │                      │     Hook      │
└──────────────┘                      └──────┬───────┘
                                             │
                                    POST /api/generate
                                    (nodes + edges JSON)
                                             │
                                      ┌──────▼───────┐
                                      │   FastAPI     │
                                      │  (SSE route)  │
                                      └──────┬───────┘
                                             │
                              asyncio.Queue + ThreadPool
                                             │
                                    ┌────────▼───────┐
                                    │  PipelineWrapper │
                                    │  (Z-Image 6B)    │
                                    └────────┬───────┘
                                             │
                              SSE progress events
                              (loading/generating/saving)
                                             │
                                    ┌────────▼───────┐
                                    │   Image Output   │
                                    │   (PNG + JSON)   │
                                    └────────────────┘
```

### Key Design Decisions

- **Zustand as single source of truth** — the store owns all node/edge state, React Flow syncs to it. Enables clean JSON serialization for save/load.
- **SSE over EventSource** — fetch-based SSE client allows POST requests (EventSource is GET-only), enabling the workflow JSON body. Also supports AbortController for cancellation.
- **Lazy model loading** — the 6B pipeline loads on first generation request. Server starts instantly. First generation is slow; all subsequent generations reuse the in-memory pipeline.
- **CustomEvent wiring** — node components dispatch `korg:updateNode` and `korg:generate` CustomEvents. A single integration hook listens and orchestrates the entire SSE lifecycle. This avoids prop drilling through React Flow's internal node rendering.
- **Thread pool execution** — diffusers inference is CPU/GPU-bound. A `ThreadPoolExecutor` runs it off the async event loop, pushing progress events to an `asyncio.Queue` for SSE streaming.
- **Sidecar metadata** — every generated PNG gets a `.json` sidecar file with prompt, seed, and timestamp. Makes images self-documenting and batch-processable.

---

## What's Not Included (v1 Scope)

- User authentication / multi-user support (personal tool)
- Undo/redo for node graph operations
- Inpainting (Z-Image Inpaint pipeline)
- Model browser or download manager
- Gallery UI for browsing past images (filesystem access only)
- Plugin system or custom node SDK
- Concurrent generation queue (one generation at a time)

---

## Credits

Built with:
- [Z-Image](https://huggingface.co/Tongyi-MAI/Z-Image) by Tongyi-MAI
- [React Flow](https://reactflow.dev/) for the node graph
- [diffusers](https://github.com/huggingface/diffusers) by HuggingFace
- [FastAPI](https://fastapi.tiangolo.com/) for the API
- [Zustand](https://zustand.docs.pmnd.rs/) for state management
