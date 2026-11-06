"use client";

import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { DragEvent, PointerEvent } from "react";
import type { CustomBlockDefinition, PipelineGraph, PipelineNode, PipelineEdge, StudioModel } from "@/lib/pipeline";
import { DEFAULT_DELEGATED_WORKERS, LIMITS, AUTO_STRATEGY_LABELS, resolveDelegatedModels } from "@/lib/pipeline";
import styles from "./canvas.module.css";
import { blockTimings, formatDuration, slowestBlockId } from "./run-stats";
import type { RunStats } from "./run-stats";

const NODE_WIDTH = 216;
const NODE_HEIGHT = 112;
const NODE_MIME = "application/x-pipeline-node";
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const WORLD_MIN_WIDTH = 4350;
const WORLD_MIN_HEIGHT = 2550;
export type PipelineNodeStatus = "running" | "complete" | "failed" | "stopped";
const NODE_KINDS: Record<PipelineNode["type"], { label: string; mark: string; caption: string }> = {
  start: { label: "Start", mark: "GO", caption: "Entry point" },
  model: { label: "Model", mark: "AI", caption: "Model call" },
  delegated: { label: "Delegated block", mark: "TEAM", caption: "AI-created workers" },
  condition: { label: "Condition", mark: "IF", caption: "Two branches" },
  variable: { label: "Set variable", mark: "x=", caption: "Assign a value" },
  output: { label: "Output", mark: "OUT", caption: "Final result" },
  custom: { label: "Custom", mark: "<>", caption: "Reusable custom step" },
};

function portPoint(node: PipelineNode, port: PipelineEdge["port"] | "in") {
  return {
    x: node.x + (port === "in" ? 0 : NODE_WIDTH),
    y: node.y + (port === "pass" ? 36 : port === "fail" ? 80 : NODE_HEIGHT / 2),
  };
}

function delegationDetail(node: PipelineNode, models: StudioModel[]): string {
  const { leader, workers, validator } = resolveDelegatedModels(node, models);
  const leaderLabel = node.leaderAuto !== undefined
    ? `Leader auto ${AUTO_STRATEGY_LABELS[node.leaderAuto]} → ${leader?.name ?? "none"}`
    : `Leader ${leader?.name ?? "not set"}`;
  const workerLabel = node.workerAuto !== undefined
    ? `workers auto ${AUTO_STRATEGY_LABELS[node.workerAuto]} → ${workers[0]?.name ?? "none"}`
    : `workers ${workers.length ? `${workers.length} ${workers.length === 1 ? "model" : "models"}` : "not set"}`;
  return `${leaderLabel} · ${workerLabel} · validator ${validator?.name ?? "not set"} · up to ${node.maxWorkers ?? DEFAULT_DELEGATED_WORKERS}`;
}

function wirePath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const bend = Math.max(64, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

export function PipelineCanvas(props: {
  graph: PipelineGraph;
  models: StudioModel[];
  customBlocks: CustomBlockDefinition[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (graph: PipelineGraph) => void;
  activeNodeId?: string;
  nodeStatuses: Record<string, PipelineNodeStatus>;
  outputs: Record<string, string>;
  runStats?: RunStats;
  disabled: boolean;
  onAddModel: () => void;
  onAddNode: (type: PipelineNode["type"], modelId?: string, preset?: { label: string; prompt: string }, customBlockId?: string) => void;
}) {
  const { graph, models, customBlocks, selectedId, onSelect, onChange, activeNodeId, nodeStatuses, outputs, disabled, onAddModel, onAddNode } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ from: string; port: PipelineEdge["port"] } | null>(null);
  const [previewPoint, setPreviewPoint] = useState<{ x: number; y: number } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [message, setMessage] = useState("");
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  const zoomAnchorRef = useRef<{ x: number; y: number; worldX: number; worldY: number } | null>(null);
  const id = useId();
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const selectedNode = selectedId ? nodesById.get(selectedId) : undefined;
  const selectedEdge = selectedId === null ? graph.edges.find((edge) => edge.id === selectedEdgeId) : undefined;
  const pendingNode = !disabled && pending ? nodesById.get(pending.from) : undefined;
  const worldWidth = Math.max(WORLD_MIN_WIDTH, ...graph.nodes.map((node) => node.x + NODE_WIDTH + 160));
  const worldHeight = Math.max(WORLD_MIN_HEIGHT, ...graph.nodes.map((node) => node.y + NODE_HEIGHT + 160));
  const runningNode = graph.nodes.find((node) => nodeStatuses[node.id] === "running")
    ?? (activeNodeId && !nodeStatuses[activeNodeId] ? nodesById.get(activeNodeId) : undefined);
  const failedNode = graph.nodes.find((node) => nodeStatuses[node.id] === "failed");
  const stoppedNode = graph.nodes.find((node) => nodeStatuses[node.id] === "stopped");
  const timings = blockTimings(props.runStats);
  const bottleneck = slowestBlockId(props.runStats);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  useEffect(() => {
    const node = activeNodeId ? graph.nodes.find((item) => item.id === activeNodeId) : undefined;
    const viewport = viewportRef.current;
    if (!node || !viewport) return;
    const factor = zoomRef.current;
    viewport.scrollTo({
      left: Math.max(0, (node.x + NODE_WIDTH / 2) * factor - viewport.clientWidth / 2),
      top: Math.max(0, (node.y + NODE_HEIGHT / 2) * factor - viewport.clientHeight / 2),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [activeNodeId, graph]);

  function canvasPoint(clientX: number, clientY: number) {
    const viewport = viewportRef.current;
    if (!viewport) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    return {
      x: (clientX - rect.left - viewport.clientLeft + viewport.scrollLeft) / zoom,
      y: (clientY - rect.top - viewport.clientTop + viewport.scrollTop) / zoom,
    };
  }

  function changeZoom(next: number, clientX?: number, clientY?: number) {
    const viewport = viewportRef.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next * 100) / 100));
    if (clamped === zoom) return;
    if (viewport) {
      const rect = viewport.getBoundingClientRect();
      const anchorX = (clientX ?? rect.left + viewport.clientWidth / 2) - rect.left - viewport.clientLeft;
      const anchorY = (clientY ?? rect.top + viewport.clientHeight / 2) - rect.top - viewport.clientTop;
      zoomAnchorRef.current = {
        x: anchorX,
        y: anchorY,
        worldX: (anchorX + viewport.scrollLeft) / zoom,
        worldY: (anchorY + viewport.scrollTop) / zoom,
      };
    }
    setZoom(clamped);
  }

  useEffect(() => {
    const anchor = zoomAnchorRef.current;
    const viewport = viewportRef.current;
    zoomAnchorRef.current = null;
    if (!anchor || !viewport) return;
    viewport.scrollLeft = anchor.worldX * zoom - anchor.x;
    viewport.scrollTop = anchor.worldY * zoom - anchor.y;
  }, [zoom]);

  function clearPending() {
    setPending(null);
    setPreviewPoint(null);
  }

  function selectNode(nodeId: string) {
    setSelectedEdgeId(null);
    setAddOpen(false);
    setMessage("");
    onSelect(nodeId);
  }

  function selectEdge(edgeId: string) {
    setSelectedEdgeId(edgeId);
    setAddOpen(false);
    clearPending();
    setMessage("Connection selected. Use Delete to remove it.");
    onSelect(null);
  }

  function deleteSelection() {
    if (disabled) return;
    if (selectedEdge) {
      onChange({ ...graph, edges: graph.edges.filter((edge) => edge.id !== selectedEdge.id) });
      setMessage("Connection removed.");
    } else if (selectedNode) {
      onChange({
        ...graph,
        nodes: graph.nodes.filter((node) => node.id !== selectedNode.id),
        edges: graph.edges.filter((edge) => edge.from !== selectedNode.id && edge.to !== selectedNode.id),
      });
      setMessage("Block and its connections removed.");
    } else {
      return;
    }
    setSelectedEdgeId(null);
    clearPending();
    onSelect(null);
  }

  const handleKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return;
    if (event.key === "Escape") {
      clearPending();
      setAddOpen(false);
      setDropActive(false);
      setMessage("");
    } else if ((event.key === "Delete" || event.key === "Backspace") && !disabled && (selectedNode || selectedEdge)) {
      event.preventDefault();
      deleteSelection();
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const handleWheel = useEffectEvent((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
    changeZoom(zoom * Math.exp(-delta * 0.0015), event.clientX, event.clientY);
  });

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, []);

  function startDrag(event: PointerEvent<HTMLButtonElement>, node: PipelineNode) {
    if (event.button !== 0) return;
    selectNode(node.id);
    if (disabled) return;
    const point = canvasPoint(event.clientX, event.clientY);
    dragRef.current = { id: node.id, pointerId: event.pointerId, offsetX: point.x - node.x, offsetY: point.y - node.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    event.preventDefault();
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (disabled) {
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const point = canvasPoint(event.clientX, event.clientY);
    const x = Math.max(16, Math.round(point.x - drag.offsetX));
    const y = Math.max(16, Math.round(point.y - drag.offsetY));
    const node = nodesById.get(drag.id);
    if (!node || (node.x === x && node.y === y)) return;
    onChange({ ...graph, nodes: graph.nodes.map((item) => item.id === drag.id ? { ...item, x, y } : item) });
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function connect(to: PipelineNode) {
    if (disabled || !pending) return;
    const from = nodesById.get(pending.from);
    if (!from || from.type === "output" || to.type === "start") {
      clearPending();
      setMessage("Choose an output port and a valid input port.");
      return;
    }
    if (from.id === to.id) {
      setMessage("A block cannot connect to itself. Choose another input.");
      return;
    }
    if (graph.edges.some((edge) => edge.from === from.id && edge.to === to.id && edge.port === pending.port)) {
      clearPending();
      setMessage("These ports are already connected.");
      return;
    }
    if (graph.edges.length >= LIMITS.edges) {
      clearPending();
      setMessage(`A pipeline can contain at most ${LIMITS.edges} connections.`);
      return;
    }

    const edges = graph.edges;
    const stack = [to.id];
    const visited = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      if (current === from.id) {
        setMessage("That connection would create a cycle. Choose another input.");
        return;
      }
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of edges) if (edge.from === current) stack.push(edge.to);
    }

    const edge: PipelineEdge = { id: crypto.randomUUID(), from: from.id, to: to.id, port: pending.port };
    onChange({ ...graph, edges: [...edges, edge] });
    setSelectedEdgeId(null);
    clearPending();
    onSelect(to.id);
    setMessage("Connection added.");
  }

  function clickPort(node: PipelineNode, port: PipelineEdge["port"] | "in") {
    if (disabled) return;
    setSelectedEdgeId(null);
    setAddOpen(false);
    onSelect(node.id);
    if (port === "in") {
      if (pendingNode) connect(node);
      else setMessage("Choose an output port first, then click this input.");
      return;
    }
    if (pending?.from === node.id && pending.port === port) {
      clearPending();
      setMessage("");
      return;
    }
    setPending({ from: node.id, port });
    const point = portPoint(node, port);
    setPreviewPoint({ x: point.x + 72, y: point.y });
    setMessage("");
  }

  function createDroppedNode(type: PipelineNode["type"], modelId: string | undefined, point: { x: number; y: number }, preset?: { label: string; prompt: string }, customBlockId?: string): PipelineNode | null {
    const model = type === "model" ? (modelId ? models.find((item) => item.id === modelId) : models[0]) : undefined;
    if (type === "model" && !model) {
      setMessage("Add or choose a configured model before dropping a model block.");
      return null;
    }
    const customBlock = type === "custom" ? customBlocks.find((item) => item.id === customBlockId) : undefined;
    if (type === "custom" && !customBlock) {
      setMessage("This custom block is no longer available. Add it again from the library.");
      return null;
    }
    return {
      id: crypto.randomUUID(),
      type,
      x: Math.max(16, Math.round(point.x)),
      y: Math.max(16, Math.round(point.y)),
      label: preset?.label || model?.name || customBlock?.name || NODE_KINDS[type].label,
      ...(type === "model" ? { modelId: model!.id, prompt: preset?.prompt ?? "" } : {}),
      ...(type === "delegated" ? {
        ...(models[0] ? { modelId: models[0].id } : {}),
        workerModelIds: models.map((item) => item.id),
        maxWorkers: DEFAULT_DELEGATED_WORKERS,
      } : {}),
      ...(type === "custom" ? { customBlockId: customBlock!.id } : {}),
      ...(type === "condition" ? { condition: "contains" as const, value: "" } : {}),
      ...(type === "variable" ? { variable: "result", value: "{{value}}" } : {}),
    };
  }

  function dropNode(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes(NODE_MIME)) return;
    event.preventDefault();
    setDropActive(false);
    if (disabled) return;
    if (graph.nodes.length >= LIMITS.nodes) {
      setMessage("A pipeline can contain at most 64 blocks.");
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(event.dataTransfer.getData(NODE_MIME));
    } catch {
      setMessage("This block could not be added. Try dragging it from the palette again.");
      return;
    }
    if (!payload || typeof payload !== "object" || !("type" in payload) || typeof payload.type !== "string" || !Object.prototype.hasOwnProperty.call(NODE_KINDS, payload.type) || ("modelId" in payload && typeof payload.modelId !== "string") || ("customBlockId" in payload && typeof payload.customBlockId !== "string") || ("label" in payload && (typeof payload.label !== "string" || payload.label.length > 256)) || ("prompt" in payload && (typeof payload.prompt !== "string" || payload.prompt.length > 32768))) {
      setMessage("This palette item is not a valid pipeline block.");
      return;
    }
    const preset = "label" in payload && "prompt" in payload ? { label: payload.label as string, prompt: payload.prompt as string } : undefined;
    const node = createDroppedNode(payload.type as PipelineNode["type"], "modelId" in payload ? payload.modelId as string : undefined, canvasPoint(event.clientX, event.clientY), preset, "customBlockId" in payload ? payload.customBlockId as string : undefined);
    if (!node) return;
    onChange({ ...graph, nodes: [...graph.nodes, node] });
    setSelectedEdgeId(null);
    clearPending();
    setAddOpen(false);
    onSelect(node.id);
    setMessage("Block added. Connect its ports to include it in the pipeline.");
    viewportRef.current?.focus({ preventScroll: true });
  }

  function addBlock(type: PipelineNode["type"], modelId?: string, customBlockId?: string) {
    if (disabled) return;
    setAddOpen(false);
    setSelectedEdgeId(null);
    clearPending();
    setMessage("");
    onAddNode(type, modelId, undefined, customBlockId);
  }

  const help = disabled
    ? "Running. Select a block to inspect; editing is locked."
    : message || (pendingNode ? "Choose an input port to connect. Escape cancels." : "Drag headers to move. Outputs connect to multiple inputs. Ctrl+wheel zooms. Delete removes a selection.");

  return (
    <section className={styles.canvas} aria-label="Pipeline canvas">
      <div className={styles.toolbar}>
        <div className={styles.toolbarRow}>
          <div className={styles.chips}>
            <span className={styles.countChip}><span className={styles.gridMark} aria-hidden="true" />{graph.nodes.length} {graph.nodes.length === 1 ? "block" : "blocks"}</span>
            <span className={styles.selectionChip} title={selectedNode?.label || (selectedEdge ? "Connection selected" : "Nothing selected")}>
              {selectedNode ? `Selected: ${selectedNode.label || NODE_KINDS[selectedNode.type].label}` : selectedEdge ? "Connection selected" : "Nothing selected"}
            </span>
          </div>
          <div className={styles.actions}>
            <div className={styles.zoomControls} role="group" aria-label="Canvas zoom">
              <button type="button" className={styles.zoomButton} disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(zoom - 0.1)} aria-label="Zoom out">&minus;</button>
              <button type="button" className={styles.zoomValue} onClick={() => changeZoom(1)} aria-label={`Zoom ${Math.round(zoom * 100)} percent. Reset to 100 percent`}>{Math.round(zoom * 100)}%</button>
              <button type="button" className={styles.zoomButton} disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(zoom + 0.1)} aria-label="Zoom in">+</button>
            </div>
            <button type="button" className={styles.deleteButton} disabled={disabled || (!selectedNode && !selectedEdge)} onClick={deleteSelection} title={selectedEdge ? "Delete connection" : "Delete selected block"}>Delete</button>
            <div className={styles.addWrap} onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAddOpen(false);
            }}>
              <button type="button" className={styles.addButton} disabled={disabled} aria-expanded={addOpen && !disabled} aria-controls={`${id}-add`} onClick={() => setAddOpen(!addOpen)}>+ Block</button>
              {addOpen && !disabled && (
                <div className={styles.addPopover} id={`${id}-add`} aria-label="Add a block">
                  <span className={styles.popoverLabel}>Blocks</span>
                    {(["start", "delegated", "condition", "variable", "output"] as const).map((type) => (
                    <button type="button" key={type} onClick={() => addBlock(type)}><span className={`${styles.menuMark} ${styles[type]}`} aria-hidden="true">{NODE_KINDS[type].mark}</span>{NODE_KINDS[type].label}</button>
                  ))}
                  <span className={styles.popoverLabel}>Your models</span>
                  {models.map((model) => (
                    <button type="button" key={model.id} onClick={() => addBlock("model", model.id)}><span className={`${styles.menuMark} ${styles.model}`} aria-hidden="true">AI</span><span className={styles.menuName}>{model.name}</span></button>
                  ))}
                  {models.length === 0 && <button type="button" onClick={() => { setAddOpen(false); onAddModel(); }}>+ Add a model</button>}
                  {customBlocks.length > 0 && <span className={styles.popoverLabel}>Custom blocks</span>}
                  {customBlocks.map((block) => (
                    <button type="button" key={block.id} onClick={() => addBlock("custom", undefined, block.id)}><span className={`${styles.menuMark} ${styles.custom}`} aria-hidden="true">&lt;&gt;</span><span className={styles.menuName}>{block.name}</span></button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {runningNode && <div className={`${styles.activityBanner} ${styles.activityRunning}`} role="status" aria-live="polite" aria-atomic="true">
          <span className={styles.activityIndicator} aria-hidden="true" />
          <div className={styles.activityCopy}><strong>RUNNING NOW</strong><span>{runningNode.label}</span></div>
          <small>{runningNode.type === "delegated" ? "Planning roles and running workers" : "Processing this block"}</small>
        </div>}
        {!runningNode && failedNode && <div className={`${styles.activityBanner} ${styles.activityFailed}`} role="status" aria-live="polite" aria-atomic="true">
          <span className={styles.activityIndicator} aria-hidden="true" />
          <div className={styles.activityCopy}><strong>BLOCK FAILED</strong><span>{failedNode.label}</span></div>
          <small>Inspect the error above, then run again.</small>
        </div>}
        {!runningNode && !failedNode && stoppedNode && <div className={`${styles.activityBanner} ${styles.activityStopped}`} role="status" aria-live="polite" aria-atomic="true">
          <span className={styles.activityIndicator} aria-hidden="true" />
          <div className={styles.activityCopy}><strong>RUN STOPPED</strong><span>{stoppedNode.label}</span></div>
          <small>No further blocks will run until you start again.</small>
        </div>}
        <p className={styles.help} id={`${id}-help`} role="status" aria-live="polite">{help}</p>
      </div>

      <div className={styles.stage}>
        <div
          ref={viewportRef}
          className={styles.viewport}
          tabIndex={0}
          aria-label="Scrollable pipeline workspace"
          aria-describedby={`${id}-help`}
          onPointerMove={(event) => {
            if (pendingNode) setPreviewPoint(canvasPoint(event.clientX, event.clientY));
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(NODE_MIME)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = disabled ? "none" : "copy";
            if (!disabled) setDropActive(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
          }}
          onDrop={dropNode}
        >
          <div className={styles.world} style={{ width: worldWidth * zoom, height: worldHeight * zoom }} onClick={() => {
            onSelect(null);
            setSelectedEdgeId(null);
            clearPending();
            setAddOpen(false);
            setMessage("");
          }}>
            <div className={styles.worldContent} style={{ width: worldWidth, height: worldHeight, transform: `scale(${zoom})` }}>
            <svg className={styles.wires} width={worldWidth} height={worldHeight} aria-label="Pipeline connections">
              {graph.edges.map((edge) => {
                const from = nodesById.get(edge.from);
                const to = nodesById.get(edge.to);
                if (!from || !to) return null;
                const path = wirePath(portPoint(from, edge.port), portPoint(to, "in"));
                const isSelected = selectedEdge?.id === edge.id;
                const color = edge.port === "pass" ? "#a6e3a1" : edge.port === "fail" ? "#f38ba8" : "#89b4fa";
                return (
                  <g
                    key={edge.id}
                    className={`${styles.wireGroup} ${isSelected ? styles.selectedWire : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${from.label || NODE_KINDS[from.type].label} ${edge.port} to ${to.label || NODE_KINDS[to.type].label}`}
                    aria-pressed={isSelected}
                    onClick={(event) => { event.stopPropagation(); selectEdge(edge.id); }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        selectEdge(edge.id);
                      }
                    }}
                  >
                    <path className={styles.wireHalo} d={path} />
                    <path className={styles.wire} d={path} stroke={color} strokeWidth={isSelected ? 3.5 : 2} />
                    <path className={styles.wireHit} d={path} />
                  </g>
                );
              })}
              {pendingNode && pending && previewPoint && <path className={styles.pendingWire} d={wirePath(portPoint(pendingNode, pending.port), previewPoint)} />}
            </svg>

            {graph.nodes.map((node) => {
              const kind = NODE_KINDS[node.type];
              const model = node.type === "model" ? models.find((item) => item.id === node.modelId) : undefined;
              const customBlock = node.type === "custom" ? customBlocks.find((item) => item.id === node.customBlockId) : undefined;
              const customAction = customBlock?.action;
              const label = node.label || model?.name || customBlock?.name || kind.label;
              const complete = Object.prototype.hasOwnProperty.call(outputs, node.id);
              const status = nodeStatuses[node.id] ?? (complete ? "complete" : undefined);
              const statusClass = status === "running" ? styles.statusRunning
                : status === "complete" ? styles.statusComplete
                  : status === "failed" ? styles.statusFailed
                    : status === "stopped" ? styles.statusStopped : "";
              const statusLabel = status === "running" ? "Running" : status === "complete" ? "Done" : status === "failed" ? "Failed" : status === "stopped" ? "Stopped" : "";
              const detail = node.type === "model" ? model?.model || "Choose a model in the inspector"
                : node.type === "delegated" ? delegationDetail(node, models)
                : node.type === "custom" ? customBlock && customAction ? customAction.kind === "model"
                  ? `Custom model step · ${models.find((item) => item.id === customAction.modelId)?.name ?? "Model unavailable"}`
                  : customAction.kind === "template" ? "Custom text template"
                    : customAction.kind === "math" ? `Custom math · ${customAction.operation} ${customAction.operand}`
                      : customAction.kind === "http" ? `Custom API · ${customAction.method} ${customAction.url}`
                        : "Custom cost summary"
                  : "Definition unavailable"
                : node.type === "condition" ? `${node.condition === "not-contains" ? "Does not contain" : node.condition === "equals" ? "Equals" : "Contains"} ${node.value ? `"${node.value.slice(0, 80)}"` : "..."}`
                : node.type === "variable" ? `${node.variable || "result"} = ${node.value || '""'}`
                : node.type === "start" ? "The pipeline begins here"
                : "Collect the final response";
              const customPrompt = customAction?.kind === "model" ? customAction.prompt : undefined;
              const preview = complete ? (outputs[node.id].replace(/\s+/g, " ").slice(0, 160) || "Empty output") : (node.type === "model" ? node.prompt : customPrompt) ? (node.type === "model" ? node.prompt : customPrompt)!.replace(/\s+/g, " ").slice(0, 160) : kind.caption;
              const ports: (PipelineEdge["port"] | "in")[] = [
                ...(node.type !== "start" ? ["in" as const] : []),
                ...(node.type === "condition" ? ["pass" as const, "fail" as const] : node.type !== "output" ? ["out" as const] : []),
              ];
              return (
                <article
                  key={node.id}
                  className={`${styles.node} ${styles[node.type]} ${selectedId === node.id ? styles.selected : ""} ${status === "running" ? styles.running : ""} ${status === "failed" ? styles.failedNode : ""} ${status === "stopped" ? styles.stoppedNode : ""} ${node.id === bottleneck ? styles.bottleneck : ""} ${disabled ? styles.locked : ""}`}
                  style={{ left: node.x, top: node.y }}
                  aria-label={`${kind.label}: ${label}${status ? `, ${status}` : ""}`}
                  onClick={(event) => { event.stopPropagation(); selectNode(node.id); }}
                >
                  <button
                    type="button"
                    className={styles.nodeHeader}
                    aria-label={`Select ${label}${disabled ? "" : "; drag header to move"}`}
                    aria-pressed={selectedId === node.id}
                    onPointerDown={(event) => startDrag(event, node)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onLostPointerCapture={() => { dragRef.current = null; }}
                    onClick={(event) => { event.stopPropagation(); selectNode(node.id); }}
                  >
                    <span className={styles.nodeMark} aria-hidden="true">{kind.mark}</span>
                    <span className={styles.nodeTitle} title={label}>{label}</span>
                  </button>
                  <p className={styles.nodeDetail}>{detail}</p>
                  <div className={styles.nodeFooter}>
                    {statusLabel && <span className={`${styles.nodeStatus} ${statusClass}`}><span aria-hidden="true" />{statusLabel}</span>}
                    <span className={styles.preview} title={preview}>{preview}</span>
                    {timings.has(node.id) && <span className={styles.duration} title="Last run: total client-observed elapsed time across this block's executions; includes network buffering.">{node.id === bottleneck ? "Slowest " : ""}{formatDuration(timings.get(node.id)!)}</span>}
                  </div>
                  {node.type === "condition" && <><span className={`${styles.branchLabel} ${styles.passLabel}`}>pass</span><span className={`${styles.branchLabel} ${styles.failLabel}`}>fail</span></>}
                  {ports.map((port) => {
                    const connected = graph.edges.some((edge) => port === "in" ? edge.to === node.id : edge.from === node.id && edge.port === port);
                    const isPending = !!pendingNode && pending?.from === node.id && pending.port === port;
                    return (
                      <button
                        type="button"
                        key={port}
                        className={`${styles.port} ${port === "in" ? styles.inputPort : styles.outputPort} ${connected ? styles.connectedPort : ""} ${isPending ? styles.pendingPort : ""} ${pendingNode && port === "in" && pendingNode.id !== node.id ? styles.targetPort : ""}`}
                        style={{ top: port === "pass" ? 36 : port === "fail" ? 80 : NODE_HEIGHT / 2 }}
                        disabled={disabled}
                        aria-label={`${label}: ${port === "in" ? "input" : port === "out" ? "output" : `${port} output`} port${connected ? ", connected" : ""}`}
                        aria-pressed={port === "in" ? undefined : isPending}
                        aria-describedby={`${id}-help`}
                        title={port === "in" ? "Click to connect an output to this input" : `Click to connect the ${port === "out" ? "output" : port} port`}
                        onClick={(event) => { event.stopPropagation(); clickPort(node, port); }}
                      />
                    );
                  })}
                </article>
              );
            })}
            </div>
          </div>
        </div>

        <span className={styles.worldLabel} aria-hidden="true">PIPELINE WORKSPACE / {Math.round(zoom * 100)}%</span>

        {models.length === 0 && (
          <aside className={styles.modelHint} aria-label="Add your first model">
            <span className={styles.hintMark} aria-hidden="true">AI</span>
            <div><h3>Bring your own model</h3><p>Add a model for AI blocks. Custom text, math, HTTP, and cost blocks can run without one.</p><button type="button" disabled={disabled} onClick={() => { if (!disabled) onAddModel(); }}>+ Add model</button></div>
          </aside>
        )}
        {dropActive && !disabled && <div className={styles.dropIndicator} aria-hidden="true"><span>Drop to add a block</span></div>}
      </div>
    </section>
  );
}
