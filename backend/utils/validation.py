"""Graph topology validation and parameter extraction for submitted workflows.

Supports both standard (single zImageGenerate) and composite
(zComposition + N zRegion) workflows.
"""

from typing import Any


def validate_workflow(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Validate a workflow's graph topology.

    Returns a list of error messages (empty = valid).
    """
    errors: list[str] = []
    node_ids = {n["id"] for n in nodes}

    # ── 1. At least one root generation node ───────────────────────────
    generate_nodes = [
        n for n in nodes
        if n.get("type") in ("zImageGenerate", "zComposition")
    ]
    if not generate_nodes:
        errors.append(
            "Workflow must contain at least one Z-Image Generate or Composition node."
        )

    # ── 1b. Composite-specific validation ─────────────────────────────
    composition_nodes = [n for n in nodes if n.get("type") == "zComposition"]
    for comp_node in composition_nodes:
        comp_data = comp_node.get("data", {})
        canvas_w = comp_data.get("canvasWidth", 1024)
        canvas_h = comp_data.get("canvasHeight", 1024)

        # Find connected region nodes via edges
        connected_regions = [
            e.get("source") for e in edges
            if e.get("target") == comp_node["id"]
        ]
        if not connected_regions:
            errors.append(
                f"Composition node '{comp_node['id']}' has no connected region nodes."
            )

        for region_id in connected_regions:
            region_node = next(
                (n for n in nodes if n["id"] == region_id), None
            )
            if not region_node:
                continue
            region_data = region_node.get("data", {})
            rw = region_data.get("regionWidth", 0)
            rh = region_data.get("regionHeight", 0)
            rx = region_data.get("regionX", 0)
            ry = region_data.get("regionY", 0)

            if rw <= 0 or rh <= 0:
                errors.append(
                    f"Region node '{region_id}' has invalid dimensions "
                    f"({rw}×{rh}). Must be positive."
                )
            if rx + rw > canvas_w or ry + rh > canvas_h:
                errors.append(
                    f"Region node '{region_id}' exceeds canvas bounds "
                    f"(canvas: {canvas_w}×{canvas_h}, region: "
                    f"({rx},{ry}) {rw}×{rh})."
                )

    # ── 2. Every edge connects existing nodes ──────────────────────────
    for edge in edges:
        if edge.get("source") not in node_ids:
            errors.append(f"Edge references unknown source node: {edge.get('source')}")
        if edge.get("target") not in node_ids:
            errors.append(f"Edge references unknown target node: {edge.get('target')}")

    # ── 3. Every input handle must be connected (no floating inputs) ───
    #    (except for TextPrompt nodes whose prompt is user-entered)
    for node in nodes:
        data = node.get("data", {})
        inputs: list[dict] = data.get("inputs", [])
        for inp in inputs:
            handle_id = inp.get("name", "")
            # Check if this handle has any incoming edge
            has_connection = any(
                e.get("target") == node["id"] and e.get("targetHandle") == handle_id
                for e in edges
            )
            if not has_connection and inp.get("required", False):
                errors.append(
                    f"Node '{node.get('id')}' input '{handle_id}' is required "
                    f"but not connected."
                )

    # ── 4. No duplicate edge connections ───────────────────────────────
    seen: set[tuple[str, str, str | None, str | None]] = set()
    for edge in edges:
        key = (edge["source"], edge["target"], edge.get("sourceHandle"), edge.get("targetHandle"))
        if key in seen:
            errors.append(f"Duplicate edge: {edge['source']} → {edge['target']}")
        seen.add(key)

    return errors


def extract_parameters(
    nodes: list[dict], edges: list[dict]
) -> dict[str, Any]:
    """Extract generation parameters from a valid workflow.

    For standard workflows returns a dict with ``prompt``, ``steps``,
    ``cfg_scale``, ``seed``, ``width``, ``height``, and optionally
    ``init_image`` base64 data.

    For composite workflows returns a dict with ``mode`` set to
    ``\"composite\"``, ``canvas_width``, ``canvas_height``, and
    a ``regions`` list of per-region parameter dicts.
    """
    # ── Detect composite mode ──────────────────────────────────────────
    composition_nodes = [n for n in nodes if n.get("type") == "zComposition"]
    if composition_nodes:
        return _extract_composite_params(nodes, edges, composition_nodes[0])

    # ── Standard (single-pass) mode ────────────────────────────────────
    params: dict[str, Any] = {}

    # Find the Generate node
    generate_node = next(n for n in nodes if n.get("type") == "zImageGenerate")
    gen_data = generate_node.get("data", {})
    params["steps"] = gen_data.get("steps", 50)
    params["cfg_scale"] = gen_data.get("cfgScale", 5.0)
    params["strength"] = gen_data.get("strength", 0.6)
    params["seed"] = gen_data.get("seed", None)
    params["width"] = gen_data.get("width", 1024)
    params["height"] = gen_data.get("height", 1024)

    # Find the connected TextPrompt node by traversing edges
    node_map = {n["id"]: n for n in nodes}
    for edge in edges:
        if edge["target"] == generate_node["id"] and edge.get("targetHandle") == "prompt":
            source_node = node_map.get(edge["source"])
            if source_node:
                params["prompt"] = source_node.get("data", {}).get("prompt", "")

    # Check for img2img (ImageUpload node connected to generate's image input)
    for edge in edges:
        if edge["target"] == generate_node["id"] and edge.get("targetHandle") == "image":
            source_node = node_map.get(edge["source"])
            if source_node and source_node.get("type") == "imageUpload":
                params["init_image"] = source_node.get("data", {}).get("imageData", None)

    return params


def _extract_composite_params(
    nodes: list[dict], edges: list[dict], comp_node: dict
) -> dict[str, Any]:
    """Extract composite generation parameters from a composition workflow."""
    comp_data = comp_node.get("data", {})
    node_map = {n["id"]: n for n in nodes}

    params: dict[str, Any] = {
        "mode": "composite",
        "canvas_width": comp_data.get("canvasWidth", 1024),
        "canvas_height": comp_data.get("canvasHeight", 1024),
        "regions": [],
    }

    # Find edges targeting the composition node (from region nodes)
    region_edges = [
        e for e in edges
        if e.get("target") == comp_node["id"]
    ]

    for edge in region_edges:
        region_node = node_map.get(edge.get("source", ""))
        if not region_node or region_node.get("type") != "zRegion":
            continue

        region_data = region_node.get("data", {})

        # Extract per-region prompt from connected TextPrompt node
        prompt = ""
        for pe in edges:
            if (
                pe["target"] == region_node["id"]
                and pe.get("targetHandle") == "prompt"
            ):
                prompt_node = node_map.get(pe["source"])
                if prompt_node:
                    prompt = prompt_node.get("data", {}).get("prompt", "")

        region_params = {
            "region_id": region_node["id"],
            "prompt": prompt,
            "steps": region_data.get("steps", 50),
            "cfg_scale": region_data.get("cfgScale", 5.0),
            "strength": region_data.get("strength", 0.6),
            "seed": region_data.get("seed", None),
            "region_x": region_data.get("regionX", 0),
            "region_y": region_data.get("regionY", 0),
            "region_width": region_data.get("regionWidth", 256),
            "region_height": region_data.get("regionHeight", 256),
            "region_z_index": region_data.get("regionZIndex", 0),
        }

        # Check for per-region img2img (deferred, but extract if present)
        for ie in edges:
            if (
                ie["target"] == region_node["id"]
                and ie.get("targetHandle") == "image"
            ):
                img_node = node_map.get(ie["source"])
                if img_node and img_node.get("type") == "imageUpload":
                    region_params["init_image"] = img_node.get("data", {}).get("imageData", None)

        params["regions"].append(region_params)

    # Sort regions by z-index for compositing order
    params["regions"].sort(key=lambda r: r.get("region_z_index", 0))

    return params
