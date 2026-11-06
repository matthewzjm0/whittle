"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { defaultGraph, DEFAULT_DELEGATED_WORKERS, estimateRunCost, estimateTokens, formatEstimate, LIMITS, AUTO_STRATEGY_LABELS, formatTokenCost, reachableModelCalls, resolveDelegatedModels, validateGraph } from "@/lib/pipeline";
import type { CustomBlockDefinition, DelegationAuto, PipelineEvent, PipelineGraph, PipelineNode, StudioModel, TokenUsage } from "@/lib/pipeline";
import { Field } from "./Field";
import { ModelDialog } from "./ModelDialog";
import { CustomBlockDialog } from "./CustomBlockDialog";
import { PipelineCanvas } from "./PipelineCanvas";
import type { PipelineNodeStatus } from "./PipelineCanvas";
import { useRunStats } from "./useRunStats";
import { RunSummary } from "./RunSummary";
import { BlueprintGallery } from "./BlueprintGallery";
import { RunGoalsControls } from "./RunGoalsControls";
import { ChatMessageList } from "./ChatMessageList";
import { findLooseBlocks, looseBlocksWarning } from "./loose-blocks";
import { AutoPipelineGenerator } from "./AutoPipelineGenerator";
import { extractFileText } from "./file-input";
import type { GeneratedPipeline } from "./pipeline-generator";
import {
  applyResponseModeToCustomBlocks, applyResponseModeToGraph, applyResponseModeToMessages,
  resolveOutputTokens, responseModeInstruction,
} from "./response-settings";
import { chatContext, formatPipelineChatInput, initialState, isPipelineSaved, newChatMessage, newConversation, restoreState, serializeState, STORAGE_KEY } from "./studio-state";
import type { ChatMessage, Conversation, SavedPipeline, StudioState } from "./studio-state";
import s from "./studio.module.css";

const BLOCKS = [
  { type: "start", mark: "GO", label: "Start", detail: "Receive your input" },
  { type: "delegated", mark: "TEAM", label: "Team", detail: "Coordinate parallel workers" },
  { type: "condition", mark: "IF", label: "Condition", detail: "Branch on response text" },
  { type: "variable", mark: "x=", label: "Set variable", detail: "Keep or transform a value" },
  { type: "output", mark: "OUT", label: "Output", detail: "Return the final result" },
] as const;

function customBlockKind(block: CustomBlockDefinition) {
  switch (block.action.kind) {
    case "model": return "Model step";
    case "template": return "Text template";
    case "math": return "Number operation";
    case "http": return "HTTP API";
    case "cost": return "Cost so far";
  }
}

function customBlockSummary(block: CustomBlockDefinition, models: StudioModel[]) {
  const action = block.action;
  switch (action.kind) {
    case "model": return `${models.find((model) => model.id === action.modelId)?.name ?? "Model unavailable"} · ${action.prompt || "No instructions"}`;
    case "template": return action.template || "Returns the rendered text template";
    case "math": return `${action.operation} ${action.operand}`;
    case "http": return `${action.method} ${action.url}`;
    case "cost": return "Summarizes model usage costs accumulated so far";
  }
}

type ChatAttachment = { name: string; text: string };

export function PipelineStudio() {
  const runMetrics = useRunStats();
  const [state, setState] = useState(initialState);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<"pipeline" | "chat">("pipeline");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [modelEditor, setModelEditor] = useState<string | null>(null);
  const [customBlockEditor, setCustomBlockEditor] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready. Add a model or build a pipeline from custom actions.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"chat" | null>(null);
  const [generatingPipeline, setGeneratingPipeline] = useState(false);
  const [activeNodeId, setActiveNodeId] = useState<string>();
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, PipelineNodeStatus>>({});
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [extractingFile, setExtractingFile] = useState(false);
  // Attachments stay in memory per conversation: extracted text is spliced into the
  // outgoing message only, so the composer shows a compact file chip instead of the full text.
  const [attachments, setAttachments] = useState<Record<string, ChatAttachment[]>>({});
  const [search, setSearch] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const attachmentConversationRef = useRef<string | null>(null);
  const unparsedStorageRef = useRef<string | null>(null);
  const undoRef = useRef<PipelineGraph[]>([]);
  const undoCoalesceRef = useRef(false);
  const stateRef = useRef(state);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedStorageRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      unparsedStorageRef.current = raw;
      // Browser persistence is loaded after hydration, never during server rendering.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setState(restoreState(raw));
      unparsedStorageRef.current = null;
    } catch { setStatus("Saved workspace could not be loaded and was left untouched. Export it for recovery, or import a valid backup."); }
    setReady(true);
    if (new URLSearchParams(window.location.search).get("tab") === "chat") setTab("chat");
    return () => requestRef.current?.abort();
  }, []);

  const persist = useEffectEvent(() => {
    if (unparsedStorageRef.current !== null) return;
    const serialized = serializeState(stateRef.current);
    if (serialized === savedStorageRef.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
      savedStorageRef.current = serialized;
    } catch {
      setStatus("Browser storage is full or unavailable. Export your pipeline and chat logs to keep a backup.");
    }
  });

  // Debounced writes: dragging a block or typing a name no longer serializes the workspace per event.
  useEffect(() => {
    stateRef.current = state;
    if (!ready || unparsedStorageRef.current !== null) return;
    persistTimerRef.current = setTimeout(() => { persistTimerRef.current = null; persist(); }, 400);
    return () => {
      if (persistTimerRef.current !== null) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null; }
    };
  }, [ready, state]);

  // The pending debounce is flushed when the tab closes, hides, or the editor unmounts.
  useEffect(() => {
    const flush = () => {
      if (persistTimerRef.current !== null) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null; }
      persist();
    };
    const onVisibilityChange = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flush();
    };
  }, []);

  const conversation = state.conversations.find((c) => c.id === state.activeConversationId);
  useEffect(() => { attachmentConversationRef.current = conversation?.id ?? null; }, [conversation?.id]);
  const activePipeline = state.pipelines.find((pipeline) => pipeline.id === state.activePipelineId) ?? state.pipelines[0];
  const chatPipeline = state.pipelines.find((pipeline) => pipeline.id === conversation?.pipelineId);
  const chatUsesPipeline = !!conversation?.pipelineId;
  const chatPipelineUnsaved = chatUsesPipeline && !!chatPipeline && !isPipelineSaved(chatPipeline);
  const currentAttachments = conversation ? attachments[conversation.id] ?? [] : [];
  const pendingContent = [
    draft.trim(),
    ...currentAttachments.map((file) => `--- File: ${file.name} ---\n${file.text}`),
  ].filter(Boolean).join("\n\n");
  const savedPipelines = state.pipelines.filter(isPipelineSaved);
  const chatModel = state.models.find((m) => m.id === conversation?.modelId);
  const monitorChatPipeline = busy === "chat" && chatUsesPipeline ? chatPipeline : undefined;
  const canvasGraph = monitorChatPipeline?.graph ?? state.graph;
  const canvasRun = runMetrics.run?.pipelineId === (monitorChatPipeline?.id ?? state.activePipelineId) ? runMetrics.run : undefined;
  const selectedNode = canvasGraph.nodes.find((n) => n.id === selectedId);
  const selectedCustomBlock = selectedNode?.type === "custom" ? state.customBlocks.find((block) => block.id === selectedNode.customBlockId) : undefined;
  const context = conversation ? chatContext(conversation) : [];
  const nextContext = conversation ? applyResponseModeToMessages(chatContext(conversation, [...conversation.messages, ...(draft.trim() || currentAttachments.length ? [{ id: "draft", role: "user" as const, content: pendingContent, createdAt: 0 }] : [])]), state.responseMode) : [];
  const pipelineInput = formatPipelineChatInput(nextContext);
  const chatPipelineModels = chatPipeline ? reachableModelCalls(chatPipeline.graph, state.customBlocks, state.models)
    .flatMap((call) => { const model = state.models.find((item) => item.id === call.modelId); return model ? [{ ...call, prompt: [call.prompt, responseModeInstruction(state.responseMode)].filter(Boolean).join("\n\n"), model }] : []; }) : [];
  const chatContextTokens = chatUsesPipeline
    ? Math.max(0, ...chatPipelineModels.map(({ prompt }) => estimateTokens([
      ...(conversation?.system.trim() || prompt ? [{ role: "system" as const, content: [conversation?.system.trim(), prompt].filter(Boolean).join("\n\n") }] : []),
      { role: "user", content: pipelineInput },
    ])))
    : estimateTokens(nextContext);
  const chatWindow = chatUsesPipeline ? (chatPipelineModels.length ? Math.min(...chatPipelineModels.map(({ model }) => model.contextWindow)) : undefined) : chatModel?.contextWindow;
  const contextTokens = chatContextTokens;
  const chatOutputTokens = resolveOutputTokens(state.outputTokensMode, state.maxOutputTokens, state.responseMode, contextTokens, chatWindow);
  const contextRatio = chatWindow ? Math.min(100, (contextTokens + chatOutputTokens) / chatWindow * 100) : 0;
  const chatEstimate = chatUsesPipeline && chatPipeline
    ? estimateRunCost(
      applyResponseModeToGraph(chatPipeline.graph, state.responseMode),
      applyResponseModeToCustomBlocks(state.customBlocks, state.responseMode),
      state.models,
      pipelineInput,
      chatOutputTokens,
    )
    : undefined;
  const graphErrors = validateGraph(canvasGraph, state.models, state.customBlocks);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "end" }); }, [conversation?.id, conversation?.messages.length, busy]);

  function pushUndo(previous: PipelineGraph, coalesce: boolean) {
    if (coalesce && undoCoalesceRef.current) return;
    undoRef.current = [...undoRef.current.slice(-49), previous];
    undoCoalesceRef.current = coalesce;
    setCanUndo(true);
  }

  function clearUndo() {
    undoRef.current = [];
    undoCoalesceRef.current = false;
    setCanUndo(false);
  }

  function changeGraph(graph: PipelineGraph) {
    if (requestRef.current) return;
    const previous = state.graph;
    if (graph !== previous) pushUndo(previous, previous.nodes.length === graph.nodes.length && previous.edges.length === graph.edges.length);
    runMetrics.clear();
    setState((prev) => ({ ...prev, graph, pipelines: prev.pipelines.map((pipeline) => pipeline.id === prev.activePipelineId ? { ...pipeline, graph, saved: false } : pipeline) }));
    setNodeStatuses({});
    setOutputs({});
  }

  function undoGraph() {
    if (requestRef.current || generatingPipeline) return;
    const previous = undoRef.current.pop();
    if (!previous) return;
    undoCoalesceRef.current = false;
    setCanUndo(undoRef.current.length > 0);
    setState((prev) => ({ ...prev, graph: previous, pipelines: prev.pipelines.map((pipeline) => pipeline.id === prev.activePipelineId ? { ...pipeline, graph: previous, saved: false } : pipeline) }));
    setSelectedId(null); setNodeStatuses({}); setOutputs({}); setError("");
    setStatus("Undid the last pipeline change.");
  }

  const handleUndoKey = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "z") return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return;
    if (requestRef.current || generatingPipeline || !canUndo) return;
    event.preventDefault();
    undoGraph();
  });

  useEffect(() => {
    window.addEventListener("keydown", handleUndoKey);
    return () => window.removeEventListener("keydown", handleUndoKey);
  }, []);

  function addNode(type: PipelineNode["type"], modelId?: string, preset?: { label: string; prompt: string }, customBlockId?: string) {
    if (busy) return;
    if (state.graph.nodes.length >= LIMITS.nodes) { setError("A pipeline can contain at most 64 blocks."); return; }
    const model = state.models.find((m) => m.id === modelId);
    const coordinator = type === "delegated" ? model ?? state.models[0] : undefined;
    const customBlock = state.customBlocks.find((block) => block.id === customBlockId);
    if (type === "model" && !model) { setModelEditor("new"); return; }
    if (type === "custom" && !customBlock) { setError("Choose an available custom block from the library."); return; }
    const node: PipelineNode = {
      id: crypto.randomUUID(), type, label: preset?.label ?? (type === "delegated" ? "Delegated block" : undefined) ?? model?.name ?? customBlock?.name ?? BLOCKS.find((b) => b.type === type)?.label ?? "Model",
      x: 360 + (state.graph.nodes.length % 3) * 24, y: 120 + Math.floor(state.graph.nodes.length / 3) * 150,
      ...(type === "model" ? { modelId, prompt: preset?.prompt ?? "" } : {}),
      ...(type === "delegated" ? {
        ...(coordinator ? { modelId: coordinator.id } : {}),
        workerModelIds: state.models.map((item) => item.id),
        maxWorkers: DEFAULT_DELEGATED_WORKERS,
      } : {}),
      ...(type === "custom" ? { customBlockId: customBlock!.id } : {}),
      ...(type === "condition" ? { condition: "contains", value: "" } : {}),
      ...(type === "variable" ? { variable: "result", value: "{{value}}" } : {}),
    };
    changeGraph({ ...state.graph, nodes: [...state.graph.nodes, node] });
    setSelectedId(node.id);
    setInspectorOpen(true);
    setSidebarOpen(false);
    setStatus("Block added. Connect its ports to include it in the pipeline.");
  }

  function updateNode(patch: Partial<PipelineNode>) {
    if (!selectedNode || busy) return;
    changeGraph({ ...state.graph, nodes: state.graph.nodes.map((n) => n.id === selectedNode.id ? { ...n, ...patch } : n) });
  }

  function updateDelegated(patch: Partial<PipelineNode>, remove: Array<keyof PipelineNode> = []) {
    if (!selectedNode || busy) return;
    const nodes = state.graph.nodes.map((node) => {
      if (node.id !== selectedNode.id) return node;
      const next = { ...node, ...patch };
      for (const key of remove) delete next[key];
      return next;
    });
    changeGraph({ ...state.graph, nodes });
  }

  function updateConversation(patch: Partial<Conversation>, id = conversation?.id) {
    setState((prev) => ({ ...prev, conversations: prev.conversations.map((c) => c.id === id ? { ...c, ...patch } : c) }));
  }

  function updatePipelineName(name: string) {
    setState((prev) => ({ ...prev, pipelineName: name, pipelines: prev.pipelines.map((pipeline) => pipeline.id === prev.activePipelineId ? { ...pipeline, name, saved: false } : pipeline) }));
  }

  function selectPipeline(pipeline: SavedPipeline) {
    if (busy || pipeline.id === state.activePipelineId) return;
    clearUndo();
    setState((prev) => ({ ...prev, activePipelineId: pipeline.id, graph: pipeline.graph, pipelineName: pipeline.name, input: pipeline.input }));
    setSelectedId(null); setNodeStatuses({}); setOutputs({}); setError(""); setSidebarOpen(false);
    setStatus(`Opened pipeline "${pipeline.name}".`);
  }

  function createPipeline(duplicate = false) {
    if (busy || !ready) return;
    if (state.pipelines.length >= 100) { setError("You can save up to 100 pipelines."); return; }
    const source = duplicate ? activePipeline : undefined;
    const id = crypto.randomUUID();
    let graph = defaultGraph();
    if (source) {
      const ids = new Map(source.graph.nodes.map((node) => [node.id, crypto.randomUUID()]));
      graph = {
        nodes: source.graph.nodes.map((node) => ({ ...node, id: ids.get(node.id)! })),
        edges: source.graph.edges.map((edge) => ({ ...edge, id: crypto.randomUUID(), from: ids.get(edge.from)!, to: ids.get(edge.to)! })),
      };
    }
    const name = source ? `${source.name} copy` : `Pipeline ${state.pipelines.length + 1}`;
    const pipeline = { id, name: name.slice(0, 100), graph, input: source?.input ?? "", saved: false };
    clearUndo();
    setState((prev) => ({ ...prev, pipelines: [...prev.pipelines, pipeline], activePipelineId: id, graph, pipelineName: pipeline.name, input: pipeline.input }));
    setSelectedId(null); setNodeStatuses({}); setOutputs({}); setError(""); setSidebarOpen(false); setTab("pipeline");
    setStatus(source ? `Created a copy of "${source.name}".` : "Created a new pipeline.");
  }

  function addGeneratedPipeline(pipeline: GeneratedPipeline): boolean {
    if (busy || state.pipelines.length >= 100) { setError("You can save up to 100 pipelines."); return false; }
    const errors = validateGraph(pipeline.graph, state.models, state.customBlocks);
    if (errors.length) { setError(`Generated pipeline is not valid: ${errors.join(" ")}`); return false; }
    clearUndo();
    setState((previous) => ({ ...previous, pipelines: [...previous.pipelines, { ...pipeline, saved: false }], activePipelineId: pipeline.id, graph: pipeline.graph, pipelineName: pipeline.name, input: pipeline.input }));
    setSelectedId(null); setNodeStatuses({}); setOutputs({}); setError(""); setSidebarOpen(false); setTab("pipeline");
    setStatus(`Generated "${pipeline.name}". Review its steps before running it.`);
    return true;
  }

  function savePipeline() {
    if (!activePipeline) return;
    const name = state.pipelineName.trim() || "Untitled pipeline";
    const saved = { ...activePipeline, name, graph: state.graph, input: state.input, saved: true };
    setState((prev) => ({ ...prev, pipelineName: name, pipelines: prev.pipelines.map((pipeline) => pipeline.id === saved.id ? saved : pipeline) }));
    setStatus(`Saved "${name}". Changes are also autosaved locally.`);
  }

  function deletePipeline() {
    if (!activePipeline || state.pipelines.length <= 1 || busy) return;
    if (!window.confirm(`Delete "${activePipeline.name}"? Conversations using it will be switched to direct model mode.`)) return;
    const remaining = state.pipelines.filter((pipeline) => pipeline.id !== activePipeline.id);
    const selected = remaining[0];
    clearUndo();
    setState((prev) => ({ ...prev, pipelines: remaining, activePipelineId: selected.id, graph: selected.graph, pipelineName: selected.name, input: selected.input,
      conversations: prev.conversations.map((item) => item.pipelineId === activePipeline.id ? { ...item, pipelineId: null } : item) }));
    setSelectedId(null); setNodeStatuses({}); setOutputs({}); setStatus(`Deleted "${activePipeline.name}".`);
  }

  function createConversation() {
    if (busy) return;
    if (state.conversations.length >= 100) { setError("Delete an older conversation before creating another (100 conversation limit)."); return; }
    const next = newConversation(state.models[0]?.id);
    setState((prev) => ({ ...prev, conversations: [next, ...prev.conversations], activeConversationId: next.id }));
    setDraft(""); setError(""); setSidebarOpen(false); setTab("chat");
  }

  function settleRunningNodes(status: "failed" | "stopped") {
    runMetrics.finish(status);
    setNodeStatuses((previous) => {
      const next = { ...previous };
      for (const [id, current] of Object.entries(next)) if (current === "running") next[id] = status;
      return next;
    });
  }

  function stop() {
    requestRef.current?.abort();
    settleRunningNodes("stopped");
    setStatus("Stopped. No further pipeline steps will run.");
  }

  async function streamPipelineEvents(graph: PipelineGraph, customBlocks: CustomBlockDefinition[], input: string, maxOutputTokens: number, controller: AbortController): Promise<{ text: string; usage?: TokenUsage }> {
    const response = await fetch("/api/pipeline", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ mode: "pipeline", graph, models: state.models, customBlocks, input, maxOutputTokens }),
    });
    if (!response.ok) throw new Error((await response.json()).error || `Request failed (${response.status}).`);
    if (!response.body) throw new Error("The pipeline did not return a result stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    let text = "";
    let usage: TokenUsage | undefined;
    function consume(line: string) {
      if (!line.trim()) return;
      const event = JSON.parse(line) as PipelineEvent;
      runMetrics.record(event);
      if (event.type === "error") {
        if (event.nodeId) setNodeStatuses((previous) => ({ ...previous, [event.nodeId!]: controller.signal.aborted ? "stopped" : "failed" }));
        throw new Error(event.error || "Pipeline failed.");
      }
      if (event.type === "node-start") {
        setActiveNodeId(event.nodeId);
        if (event.nodeId) setNodeStatuses((previous) => ({ ...previous, [event.nodeId!]: "running" }));
        const node = graph.nodes.find((item) => item.id === event.nodeId);
        setStatus(node?.type === "delegated" ? `Planning and running workers: ${node.label}...` : `Running ${node?.label ?? "pipeline block"}...`);
      }
      if (event.type === "node-complete" && event.nodeId) {
        setNodeStatuses((previous) => ({ ...previous, [event.nodeId!]: "complete" }));
        setOutputs((previous) => {
          const output = event.output ?? "";
          if (!event.branchId) return { ...previous, [event.nodeId!]: output };
          const branchOutput = `Branch ${event.branchId}:\n${output}`;
          return { ...previous, [event.nodeId!]: previous[event.nodeId!] ? `${previous[event.nodeId!]}\n\n${branchOutput}` : branchOutput };
        });
      }
      if (event.type === "complete") { text = event.output ?? ""; usage = event.usage; completed = true; }
    }
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let split: number;
        while ((split = buffer.indexOf("\n")) !== -1) { consume(buffer.slice(0, split)); buffer = buffer.slice(split + 1); }
        if (done) { consume(buffer); break; }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!completed) throw new Error("Connection closed before the pipeline finished.");
    return { text, usage };
  }

  async function attachFile(file?: File) {
    if (!file || !conversation || extractingFile || busy) return;
    const conversationId = conversation.id;
    setExtractingFile(true);
    setError("");
    try {
      const extracted = (await extractFileText(file)).trim();
      if (attachmentConversationRef.current !== conversationId) return;
      if (!extracted) { setError("The selected file contains no extractable text."); return; }
      const text = extracted.length > LIMITS.inputChars ? extracted.slice(0, LIMITS.inputChars) : extracted;
      setStatus(extracted.length > LIMITS.inputChars
        ? "File text was truncated to fit the message limit."
        : "File attached. Its text is included with your next message.");
      setAttachments((previous) => ({ ...previous, [conversationId]: [...previous[conversationId] ?? [], { name: file.name.replace(/[\r\n]/g, " "), text }] }));
    } catch (error) {
      if (attachmentConversationRef.current === conversationId) setError(error instanceof Error ? error.message : "Unable to extract text from this file.");
    } finally {
      setExtractingFile(false);
      if (attachmentRef.current) attachmentRef.current.value = "";
    }
  }

  function removeAttachment(index: number) {
    if (!conversation) return;
    const id = conversation.id;
    setAttachments((previous) => ({ ...previous, [id]: (previous[id] ?? []).filter((_, i) => i !== index) }));
  }

  async function sendMessage(retry = false) {
    if (requestRef.current || generatingPipeline || extractingFile || !conversation) return;
    if (chatUsesPipeline ? !chatPipeline : !chatModel) {
      setError(chatUsesPipeline ? "This conversation's pipeline is missing. Select another pipeline or switch to a model." : "Add a model and select it for this conversation first.");
      return;
    }
    if (chatPipelineUnsaved) { setError("Save the selected pipeline in the Pipeline editor before sending or retrying."); return; }
    const text = draft.trim();
    if (!retry && !text && !currentAttachments.length) return;
    const content = [
      text,
      ...currentAttachments.map((file) => `--- File: ${file.name} ---\n${file.text}`),
    ].filter(Boolean).join("\n\n");
    if (!retry && content.length > (chatUsesPipeline ? LIMITS.inputChars : LIMITS.textChars)) {
      setError(chatUsesPipeline
        ? "Message with attachments exceeds the pipeline input limit. Shorten the message, remove a file, or reduce recent-message depth in Context settings."
        : "Message with attachments exceeds the per-message text limit. Shorten the message or remove a file.");
      setInspectorOpen(true);
      return;
    }
    const messages: ChatMessage[] = retry ? conversation.messages : [...conversation.messages, newChatMessage("user", content)];
    if (retry && messages.at(-1)?.role !== "user") return;
    const requestMessages = applyResponseModeToMessages(chatContext(conversation, messages), state.responseMode);
    const serializedInput = formatPipelineChatInput(requestMessages);
    if (chatUsesPipeline && chatPipeline) {
      if (serializedInput.length > LIMITS.inputChars) {
        setError("Pipeline chat input exceeds the size limit. Reduce the recent-message depth in Context settings.");
        setInspectorOpen(true);
        return;
      }
      const errors = validateGraph(chatPipeline.graph, state.models, state.customBlocks);
      if (errors.length) { selectPipeline(chatPipeline); setError(`The selected pipeline is not ready: ${errors.join(" ")}`); setTab("pipeline"); return; }
      const loose = findLooseBlocks(chatPipeline.graph);
      if (loose.length) {
        const warning = looseBlocksWarning(loose);
        selectPipeline(chatPipeline); setTab("pipeline"); setSelectedId(loose[0].id); setInspectorOpen(true);
        setError(warning); setStatus("Run cancelled. Remove or connect the loose blocks first."); window.alert(warning);
        return;
      }
      if (chatPipelineModels.some(({ prompt }) => [conversation.system.trim(), prompt].filter(Boolean).join("\n\n").length > LIMITS.templateChars)) {
        setError("Conversation instructions and a pipeline model step exceed the instruction size limit. Shorten one of them before sending.");
        setInspectorOpen(true);
        return;
      }
      const overContext = chatPipelineModels.find(({ prompt, model }) => estimateTokens([
        ...(conversation.system.trim() || prompt ? [{ role: "system" as const, content: [conversation.system.trim(), prompt].filter(Boolean).join("\n\n") }] : []),
        { role: "user", content: serializedInput },
      ]) + chatOutputTokens > model.contextWindow);
      if (overContext) {
        setError(`Context exceeds ${overContext.model.name}'s window at ${overContext.role.toLowerCase()} for block "${overContext.node.label}". Reduce conversation history or output reservation.`);
        setInspectorOpen(true); return;
      }
    } else if (chatModel && estimateTokens(requestMessages) + chatOutputTokens > chatModel.contextWindow) {
      setError("Context is full. Reduce recent messages or reserved output in Context settings, or choose a larger model window.");
      setInspectorOpen(true);
      return;
    }
    const id = conversation.id;
    if (!retry) {
      updateConversation({ messages, ...(conversation.messages.length === 0 ? { title: text.slice(0, 48) || currentAttachments[0]?.name || "New conversation" } : {}) }, id);
      setDraft("");
      // The attachment text is now embedded in the stored user message, so drop the chips.
      setAttachments((previous) => ({ ...previous, [id]: [] }));
    }
    setError(""); setBusy("chat"); setStatus(chatUsesPipeline ? `Running pipeline: ${chatPipeline?.name}...` : `Waiting for ${chatModel?.name}...`);
    if (chatUsesPipeline) { setActiveNodeId(undefined); setNodeStatuses({}); setOutputs({}); }
    if (chatUsesPipeline && chatPipeline) runMetrics.begin(chatPipeline, state.customBlocks);
    const controller = new AbortController(); requestRef.current = controller;
    try {
      let responseText = "";
      let responseUsage: TokenUsage | undefined;
      let responseName: string;
      if (chatUsesPipeline && chatPipeline) {
        const selectedPipeline = chatPipeline;
        const graphWithSystem: PipelineGraph = {
          ...selectedPipeline.graph,
          nodes: selectedPipeline.graph.nodes.map((node) => {
            if (!conversation.system.trim()) return node;
            if (node.type === "model" || node.type === "delegated") {
              return { ...node, prompt: [conversation.system.trim(), node.prompt].filter(Boolean).join("\n\n") };
            }
            return node;
          }),
        };
        const graph = applyResponseModeToGraph(graphWithSystem, state.responseMode);
        const customBlocks = applyResponseModeToCustomBlocks(state.customBlocks.map((block) => block.action.kind === "model" && conversation.system.trim()
          ? { ...block, action: { ...block.action, prompt: [conversation.system.trim(), block.action.prompt].filter(Boolean).join("\n\n") } }
          : block), state.responseMode);
        const result = await streamPipelineEvents(graph, customBlocks, serializedInput, chatOutputTokens, controller);
        responseText = result.text; responseUsage = result.usage; responseName = selectedPipeline.name;
      } else {
        const response = await fetch("/api/pipeline", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ mode: "chat", model: chatModel, messages: requestMessages, maxOutputTokens: chatOutputTokens }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
        if (typeof data.text !== "string") throw new Error("The model returned no response.");
        responseText = data.text; responseUsage = data.usage; responseName = chatModel!.name;
      }
      const reply = newChatMessage("assistant", responseText, responseName, responseUsage);
      updateConversation({ messages: [...messages, reply] }, id);
      setStatus("Response received.");
    } catch (e) {
      if (controller.signal.aborted) { settleRunningNodes("stopped"); setStatus("Response stopped. You can retry the last message."); }
      else { settleRunningNodes("failed"); setError(e instanceof Error ? e.message : "Chat request failed."); setStatus("Chat request failed."); }
    } finally {
      requestRef.current = null; setBusy(null); setActiveNodeId(undefined);
      if (chatUsesPipeline && chatPipeline?.id !== state.activePipelineId) {
        setSelectedId(null); setNodeStatuses({}); setOutputs({});
      }
    }
  }

  function exportWorkspace() {
    let serialized = serializeState(state);
    if (unparsedStorageRef.current) {
      try {
        const parsed = JSON.parse(unparsedStorageRef.current) as Record<string, unknown>;
        for (const key of ["models", "customBlocks"]) {
          const items = parsed[key];
          if (Array.isArray(items)) parsed[key] = items.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return item;
            const safe = { ...item } as Record<string, unknown>;
            delete safe.apiKey;
            return safe;
          });
        }
        serialized = JSON.stringify(parsed);
      } catch { setError("The saved workspace could not be safely exported. Import a valid backup before continuing."); return; }
    }
    const url = URL.createObjectURL(new Blob([serialized], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "pipeline-studio.json"; a.click(); URL.revokeObjectURL(url);
    setStatus("Exported pipeline, model settings, and chat logs. API keys were excluded.");
  }

  async function importWorkspace(file?: File) {
    if (!file || busy) return;
    try {
      if (file.size > 10_000_000) throw new Error("Import must be smaller than 10 MB.");
      const next = restoreState(await file.text());
      if (!window.confirm("Replace this workspace with the imported pipeline, models, and chat logs? Export first to keep a backup.")) return;
      unparsedStorageRef.current = null;
      runMetrics.clear();
      clearUndo();
        setState(next); setSelectedId(null); setNodeStatuses({}); setOutputs({}); setDraft(""); setError("");
      setStatus("Workspace imported. Re-enter model and HTTP custom-block API keys; credentials are never imported.");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to import workspace."); }
    finally { if (importRef.current) importRef.current.value = ""; }
  }

  function saveModel(model: StudioModel) {
    setState((prev) => ({ ...prev, models: prev.models.some((m) => m.id === model.id) ? prev.models.map((m) => m.id === model.id ? model : m) : [...prev.models, model] }));
    setModelEditor(null); setError(""); setStatus(`Model "${model.name}" is available in Pipeline and Chat. API key stays in memory.`);
  }

  function deleteModel(id: string) {
    if (state.pipelines.some((pipeline) => pipeline.graph.nodes.some((node) => node.modelId === id || node.workerModelIds?.includes(id)
      || node.leaderPool?.includes(id) || node.workerPool?.includes(id) || node.validatorModelId === id))
      || state.conversations.some((c) => c.modelId === id)
      || state.customBlocks.some((block) => block.action.kind === "model" && block.action.modelId === id)) {
      setError("This model is in use. Remove its pipeline or team assignments, change any custom model steps, and update conversations before deleting it."); return;
    }
    setState((prev) => ({ ...prev, models: prev.models.filter((m) => m.id !== id) })); setModelEditor(null);
  }

  function saveCustomBlock(block: CustomBlockDefinition) {
    setState((prev) => {
      const previous = prev.customBlocks.find((item) => item.id === block.id);
      const customBlocks = previous
        ? prev.customBlocks.map((item) => item.id === block.id ? block : item)
        : [...prev.customBlocks, block];
      const changed = previous && (previous.name !== block.name || JSON.stringify(previous.action) !== JSON.stringify(block.action));
      const pipelines = changed ? prev.pipelines.map((pipeline) => {
        if (!pipeline.graph.nodes.some((node) => node.type === "custom" && node.customBlockId === block.id)) return pipeline;
        const nodes = pipeline.graph.nodes.map((node) => node.type === "custom" && node.customBlockId === block.id && node.label === previous.name
          ? { ...node, label: block.name } : node);
        return { ...pipeline, saved: false, graph: { ...pipeline.graph, nodes } };
      }) : prev.pipelines;
      const active = pipelines.find((pipeline) => pipeline.id === prev.activePipelineId);
      return { ...prev, customBlocks, pipelines, ...(active ? { graph: active.graph } : {}) };
    });
    setCustomBlockEditor(null);
    setStatus(`Custom block "${block.name}" saved to your library.`);
  }

  function deleteCustomBlock(id: string) {
    if (state.pipelines.some((pipeline) => pipeline.graph.nodes.some((node) => node.type === "custom" && node.customBlockId === id))) {
      setError("This custom block is used by a saved pipeline. Remove its blocks from every pipeline before deleting the definition.");
      setCustomBlockEditor(null);
      return;
    }
    setState((prev) => ({ ...prev, customBlocks: prev.customBlocks.filter((block) => block.id !== id) }));
    setCustomBlockEditor(null);
  }

  function addCustomBlock(block: CustomBlockDefinition) {
    addNode("custom", undefined, undefined, block.id);
  }

  const selectedOutput = selectedId && Object.hasOwn(outputs, selectedId) ? outputs[selectedId] : undefined;
  const selectedDelegation = selectedNode?.type === "delegated" ? resolveDelegatedModels(selectedNode, state.models) : undefined;
  const leaderPool = selectedNode?.leaderPool ?? [];
  const workerPool = selectedNode?.workerPool ?? [];

  return (
    <div className={s.studio}>
      <header className={s.header}>
        <button className={s.mobileButton} onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle library" aria-expanded={sidebarOpen}>&#9776;</button>
        <Link href="/builder" className={s.brand} title="Pipeline Studio"><span className={s.brandMark}>P</span><span>Pipeline<span className={s.brandDim}> Studio</span></span></Link>
        <nav className={s.tabs} aria-label="Studio views">
          <button className={tab === "pipeline" ? s.activeTab : ""} disabled={generatingPipeline} onClick={() => { setTab("pipeline"); setError(""); }}>Pipeline</button>
          <button className={tab === "chat" ? s.activeTab : ""} disabled={generatingPipeline} onClick={() => { setTab("chat"); setError(""); }}>Chat</button>
        </nav>
        <div className={s.headerActions}>
          <span className={s.localBadge}>LOCAL WORKSPACE</span>
          <button className={s.iconButton} onClick={() => setInspectorOpen(!inspectorOpen)} aria-expanded={inspectorOpen}>{tab === "chat" ? "Context" : "Inspector"}</button>
          <button className={s.primaryButton} disabled={!!busy || generatingPipeline || !ready || state.models.length >= LIMITS.models} onClick={() => setModelEditor("new")}>+ Add model</button>
        </div>
      </header>

      <div className={s.body}>
        {sidebarOpen && <button className={s.scrim} aria-label="Close library" onClick={() => setSidebarOpen(false)} />}
        <aside className={`${s.sidebar} ${sidebarOpen ? s.sidebarOpen : ""}`} aria-label={tab === "pipeline" ? "Block library" : "Conversations"}>
          <div className={s.sidebarTitle}><span>{tab === "pipeline" ? "Block library" : "Conversations"}</span><span className={s.kicker}>{tab === "pipeline" ? "01" : String(state.conversations.length).padStart(2, "0")}</span></div>
          {tab === "pipeline" ? <>
            <AutoPipelineGenerator models={state.models} disabled={!!busy || generatingPipeline || !ready || state.pipelines.length >= 100} onAddModel={() => setModelEditor("new")} onGeneratingChange={setGeneratingPipeline} onCreate={addGeneratedPipeline} />
            <BlueprintGallery models={state.models} disabled={!!busy || generatingPipeline || !ready || state.pipelines.length >= 100} onCreate={(pipeline) => {
              if (busy || state.pipelines.length >= 100) return;
              const unsaved = { ...pipeline, saved: false };
              setState((previous) => ({ ...previous, pipelines: [...previous.pipelines, unsaved] }));
              selectPipeline(unsaved);
            }} />
            <div className={s.pipelineLibrary}>
              <div className={s.sectionTitle}>Pipelines <span>{state.pipelines.length}</span></div>
                <div className={s.savedPipelineList}>{state.pipelines.map((pipeline) => <button key={pipeline.id} className={`${s.savedPipeline} ${pipeline.id === (monitorChatPipeline?.id ?? state.activePipelineId) ? s.savedPipelineActive : ""}`} disabled={!!busy || generatingPipeline} onClick={() => selectPipeline(pipeline)}>
                 <strong>{pipeline.name || "Untitled pipeline"}{!isPipelineSaved(pipeline) && " (unsaved)"}</strong><small>{pipeline.graph.nodes.filter((node) => node.type === "model").length} model &middot; {pipeline.graph.nodes.filter((node) => node.type === "delegated").length} delegated &middot; {pipeline.graph.nodes.filter((node) => node.type === "custom").length} custom &middot; {pipeline.graph.nodes.length} blocks</small>
              </button>)}</div>
              <div className={s.pipelineListActions}><button disabled={!!busy || generatingPipeline || !ready || state.pipelines.length >= 100} onClick={() => createPipeline(false)}>+ New pipeline</button><button disabled={!!busy || generatingPipeline || !ready || state.pipelines.length >= 100} onClick={() => createPipeline(true)}>Duplicate active</button></div>
            </div>
            <p className={s.sidebarHint}>Click to add. Drag onto the canvas to place.</p>
            <div className={s.blockList}>{BLOCKS.map((block) => <button key={block.type} className={s.paletteItem} disabled={!!busy || generatingPipeline} draggable={!busy && !generatingPipeline}
              onDragStart={(e) => e.dataTransfer.setData("application/x-pipeline-node", JSON.stringify({ type: block.type }))} onClick={() => addNode(block.type)}>
              <span className={`${s.blockMark} ${s[block.type]}`}>{block.mark}</span><span><strong>{block.label}</strong><small>{block.detail}</small></span><span className={s.plus}>+</span>
            </button>)}</div>
            <div className={s.customBlockLibrary}>
              <div className={s.sectionTitle}>Custom blocks <span>{state.customBlocks.length}</span></div>
              <p className={s.customBlockHint}>Build reusable model, text, math, API, or cost steps. Model prompts do not browse automatically; HTTP blocks call only the API you configure.</p>
              {state.customBlocks.map((block) => <div className={s.customBlockRow} key={block.id}>
                <button className={s.customBlockAdd} title={`Add ${block.name} block`} disabled={!!busy || generatingPipeline} draggable={!busy && !generatingPipeline} onDragStart={(e) => e.dataTransfer.setData("application/x-pipeline-node", JSON.stringify({ type: "custom", customBlockId: block.id, label: block.name }))} onClick={() => addCustomBlock(block)}>
                  <span className={`${s.blockMark} ${s.customMark}`} aria-hidden="true">{block.action.kind === "model" ? "AI" : block.action.kind === "template" ? "TXT" : block.action.kind === "math" ? "123" : block.action.kind === "http" ? "API" : "$"}</span><span><strong>{block.name}</strong><small>{customBlockKind(block)}</small></span>
                </button>
                <button className={s.modelSettings} disabled={!!busy || generatingPipeline} aria-label={`Edit custom block ${block.name}`} onClick={() => setCustomBlockEditor(block.id)}>Edit</button>
              </div>)}
              {state.customBlocks.length === 0 && <p className={s.emptyNote}>No custom steps yet. Create a model, text, math, HTTP, or cost block.</p>}
              <button className={s.addModel} disabled={!!busy || generatingPipeline || !ready || state.customBlocks.length >= 64} onClick={() => setCustomBlockEditor("new")}>+ Create custom block</button>
            </div>
          </> : <>
            <RunGoalsControls value={runMetrics.goals} onChange={runMetrics.setGoals} disabled={!!busy || !ready} />
            <button className={s.newChat} disabled={!!busy || !ready} onClick={createConversation}>+ New conversation</button>
            <input className={s.search} aria-label="Search conversations" placeholder="Search conversations..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className={s.conversationList}>
              {state.conversations.filter((c) => `${c.title} ${c.messages.map((m) => m.content).join(" ")}`.toLowerCase().includes(search.toLowerCase())).map((c) => <div key={c.id} className={`${s.conversationRow} ${c.id === conversation?.id ? s.activeConversation : ""}`}>
                <button disabled={!!busy} onClick={() => { setState((p) => ({ ...p, activeConversationId: c.id })); setDraft(""); setError(""); setSidebarOpen(false); }}><strong>{c.title}</strong><small>{c.messages.length} messages</small></button>
                <button className={s.deleteChat} disabled={!!busy} aria-label={`Delete ${c.title}`} onClick={() => {
                  if (!window.confirm(`Delete "${c.title}" and its messages?`)) return;
                  setState((p) => ({ ...p, conversations: p.conversations.filter((item) => item.id !== c.id), activeConversationId: p.activeConversationId === c.id ? p.conversations.find((item) => item.id !== c.id)?.id ?? null : p.activeConversationId }));
                }}>&times;</button>
              </div>)}
              {state.conversations.length === 0 && <p className={s.emptyNote}>Your conversations will appear here. Saved in this browser only.</p>}
            </div>
          </>}
          <div className={s.modelLibrary}>
            <div className={s.sectionTitle}>Your models <span>{state.models.length}</span></div>
            {state.models.map((model) => <div key={model.id} className={s.modelRow}>
              <button disabled={!!busy || generatingPipeline} draggable={tab === "pipeline" && !busy && !generatingPipeline} onDragStart={(e) => e.dataTransfer.setData("application/x-pipeline-node", JSON.stringify({ type: "model", modelId: model.id }))}
                onClick={() => tab === "pipeline" ? addNode("model", model.id) : conversation ? updateConversation({ modelId: model.id, pipelineId: null }) : setModelEditor(model.id)} title={tab === "pipeline" ? `Add ${model.name} block` : `Use ${model.name} directly`}>
                <span className={`${s.blockMark} ${s.model}`}>AI</span><span><strong>{model.name}</strong><small>{model.model}</small></span>
              </button><button className={s.modelSettings} disabled={!!busy || generatingPipeline} aria-label={`Edit ${model.name}`} onClick={() => setModelEditor(model.id)}>...</button>
            </div>)}
            {state.models.length === 0 && <p className={s.emptyNote}>No built-in models. Connect the models you want to use.</p>}
            <button className={s.addModel} disabled={!!busy || generatingPipeline || !ready || state.models.length >= LIMITS.models} onClick={() => setModelEditor("new")}>+ Add model</button>
          </div>
          <div className={s.storageActions}><button onClick={exportWorkspace} disabled={!ready}>Export</button><button onClick={() => importRef.current?.click()} disabled={!!busy || !ready}>Import</button><span>Autosaved locally</span></div>
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(e) => void importWorkspace(e.target.files?.[0])} />
        </aside>

        <main className={s.main}>
          {tab === "pipeline" ? <>
            <div className={s.pageToolbar}>
              {monitorChatPipeline
                ? <div><span className={s.eyebrow}>LIVE CHAT PIPELINE MONITOR</span><h1>{monitorChatPipeline.name}</h1></div>
                : <div><span className={s.eyebrow}>{isPipelineSaved(activePipeline) ? "SAVED" : "UNSAVED"} WORKFLOW &middot; {state.pipelines.length} TOTAL</span><input aria-label="Pipeline name" className={s.pipelineName} value={state.pipelineName} maxLength={100} disabled={!!busy} onChange={(e) => updatePipelineName(e.target.value)} /></div>}
              <div className={s.toolbarActions}>
                <button className={s.ghostButton} disabled={!!busy || generatingPipeline || !canUndo} onClick={undoGraph} title="Undo the last pipeline change (Ctrl+Z)">Undo</button>
                <button className={s.ghostButton} disabled={!!busy || generatingPipeline || !ready || state.pipelines.length >= 100} onClick={() => createPipeline(false)}>+ New</button>
                <button className={s.ghostButton} disabled={!!busy || generatingPipeline || !ready || state.pipelines.length >= 100} onClick={() => createPipeline(true)}>Duplicate</button>
                <button className={s.ghostButton} disabled={!!busy || generatingPipeline || !ready} onClick={savePipeline}>Save</button>
                <button className={s.deletePipelineButton} disabled={!!busy || generatingPipeline || !ready || state.pipelines.length <= 1} onClick={deletePipeline}>Delete</button>
                <button className={s.ghostButton} disabled={!!busy || generatingPipeline || !ready} onClick={() => { if (window.confirm("Reset this pipeline? Models and conversations will be kept.")) { changeGraph(defaultGraph()); setSelectedId(null); } }}>Reset</button>
              </div>
            </div>
            <PipelineCanvas graph={canvasGraph} models={state.models} customBlocks={state.customBlocks} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); if (id) setInspectorOpen(true); }} onChange={changeGraph} activeNodeId={activeNodeId} nodeStatuses={nodeStatuses} outputs={outputs} runStats={canvasRun} disabled={!!busy || generatingPipeline || !ready} onAddModel={() => setModelEditor("new")} onAddNode={addNode} />
          </> : <>
            <div className={s.pageToolbar}>
              <div><span className={s.eyebrow}>PROMPTING WORKSPACE</span><h1>{conversation?.title || "Your next conversation"}</h1></div>
              <div className={s.chatExecution}>
                <label><span>Run with</span><select aria-label="Chat execution" disabled={!!busy || !conversation} value={conversation?.pipelineId ?? ""} onChange={(e) => updateConversation({ pipelineId: e.target.value || null })} className={s.modelSelect}>
                  <option value="">Direct model</option>{chatPipelineUnsaved && <option value={chatPipeline!.id} disabled>{chatPipeline!.name || "Untitled pipeline"} (unsaved)</option>}{savedPipelines.length > 0 && <optgroup label="Saved pipelines">{savedPipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name || "Untitled pipeline"}</option>)}</optgroup>}
                </select></label>
                {!chatUsesPipeline && <label><span>Model</span><select aria-label="Chat model" disabled={!!busy || !conversation} value={conversation?.modelId ?? ""} onChange={(e) => updateConversation({ modelId: e.target.value })} className={s.modelSelect}>
                  <option value="">Choose a model</option>{state.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select></label>}
              </div>
            </div>
            <div className={s.chatScroll}>
              {!conversation || conversation.messages.length === 0 ? <div className={s.chatWelcome}>
                <span className={s.welcomeMark}>_</span><span className={s.eyebrow}>A LITTLE ROOM TO THINK</span><h2>Start with a question.<br /><span>Keep the context.</span></h2>
                <p>Choose a saved pipeline or a single model. Each conversation keeps its own history, instructions, and execution choice.</p>
                {!conversation ? <button className={s.primaryButton} onClick={createConversation} disabled={!!busy || !ready}>+ New conversation</button> : state.models.length === 0 ? <button className={s.primaryButton} onClick={() => setModelEditor("new")}>+ Add your first model</button> : <p className={s.welcomeHint}>Choose how to run this conversation above, then type below.</p>}
              </div> : <ChatMessageList
                messages={conversation.messages}
                onCopy={(content) => { void navigator.clipboard.writeText(content).then(() => setStatus("Message copied.")).catch(() => setStatus("Clipboard unavailable in this browser.")); }}
                getSecrets={() => [...state.models, ...state.customBlocks].flatMap((item) => item.apiKey ? [item.apiKey] : [])}
              />}
              {busy === "chat" && <div className={s.thinking} role="status"><span />{status}</div>}
              <div ref={endRef} />
            </div>
            <div className={s.composerArea}>
              {chatPipelineUnsaved && <p role="status">This pipeline has unsaved changes. Save it in the Pipeline editor before sending or retrying, or select another execution option.</p>}
              {conversation?.messages.at(-1)?.role === "user" && !busy && <button className={s.retryButton} disabled={chatPipelineUnsaved} onClick={() => void sendMessage(true)}>Retry last message</button>}
              <form className={s.composer} onSubmit={(e) => { e.preventDefault(); void sendMessage(); }}>
                {currentAttachments.length > 0 && <div className={s.attachmentRow} role="list">{currentAttachments.map((file, index) => <span key={`${file.name}:${index}`} className={s.attachmentChip} role="listitem" aria-label={file.name}><span className={s.attachmentName} title={`${file.text.length.toLocaleString()} characters of extracted text`}>{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} disabled={!!busy || extractingFile} onClick={() => removeAttachment(index)}>&times;</button></span>)}</div>}
                <textarea aria-label="Message" placeholder={conversation ? chatUsesPipeline ? "Message your pipeline..." : "Message your model..." : "Create a conversation to start chatting"} value={draft} disabled={!conversation || !!busy || extractingFile} maxLength={LIMITS.inputChars} onChange={(e) => setDraft(e.target.value)} rows={3} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendMessage(); } }} />
                <input ref={attachmentRef} type="file" accept=".pdf,.docx,.txt,.md,.csv" aria-label="Choose file for chat" hidden onChange={(event) => void attachFile(event.target.files?.[0])} />
                <button type="button" className={s.ghostButton} disabled={!conversation || !!busy || extractingFile} onClick={() => attachmentRef.current?.click()}>{extractingFile ? "Reading file..." : "Attach file"}</button>
                <div className={s.composerBottom}><span>{chatUsesPipeline ? chatPipeline?.name || "Pipeline unavailable" : chatModel?.name || "No model selected"}</span>{busy === "chat" ? <button type="button" className={s.stopButton} onClick={stop}>Stop</button> : <button className={s.sendButton} disabled={!!busy || extractingFile || (!draft.trim() && !currentAttachments.length) || !conversation || (chatUsesPipeline ? !chatPipeline || chatPipelineUnsaved : !chatModel)}>Send &uarr;</button>}</div>
              </form>
              <div className={s.composerNote}><button onClick={() => setInspectorOpen(true)}>Context: ~{contextTokens.toLocaleString()} tokens{chatWindow ? ` / ${chatWindow.toLocaleString()}` : ""}</button><span>Enter to send &middot; Shift+Enter for a new line</span></div>
              {chatEstimate && <p className={s.composerEstimate} aria-label="Estimated run cost">Rough run estimate: {formatEstimate(chatEstimate)} &middot; {chatEstimate.calls} {chatEstimate.calls === 1 ? "model call" : "model calls"} &middot; {chatEstimate.inputTokens.toLocaleString()} in / {chatEstimate.outputTokens.toLocaleString()} out</p>}
            </div>
          </>}
          <RunSummary run={runMetrics.run} />
          {error && <div className={s.error} role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}>&times;</button></div>}
        </main>

        {inspectorOpen && <aside className={s.inspector} aria-label={tab === "pipeline" ? "Block inspector" : "Conversation context"}>
          <div className={s.sidebarTitle}><span>{tab === "pipeline" ? "Inspector" : "Context window"}</span><button className={s.closeButton} onClick={() => setInspectorOpen(false)} aria-label="Close inspector">&times;</button></div>
          <div className={s.inspectorBody}>
            {tab === "pipeline" ? <>
              {selectedNode ? <fieldset disabled={!!busy} className={s.fieldset}>
                <span className={s.eyebrow}>{selectedNode.type.toUpperCase()} BLOCK</span>
                <Field label="Block name"><input value={selectedNode.label} maxLength={128} onChange={(e) => updateNode({ label: e.target.value })} /></Field>
                {(selectedNode.type === "model" || selectedNode.type === "delegated" || (selectedNode.type === "custom" && selectedCustomBlock?.action.kind === "model")) && <Field label="Reasoning effort" hint={selectedNode.type === "delegated" ? "Applies to all team calls. Support varies by model; reasoning uses output tokens and can increase cost." : "Support varies by model and provider. Reasoning uses output tokens and can increase cost."}>
                  <select value={selectedNode.effort ?? ""} onChange={(e) => updateNode({ effort: (e.target.value || undefined) as PipelineNode["effort"] })}>
                    <option value="">Provider default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Xhigh</option><option value="max">Max</option>
                  </select>
                </Field>}
                {selectedNode.type === "model" && <>
                  <Field label="Model"><select value={selectedNode.modelId ?? ""} onChange={(e) => updateNode({ modelId: e.target.value })}><option value="">Choose a model</option>{state.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
                  <Field label="Instructions" hint="Previous block output is always sent as the user message."><textarea rows={6} maxLength={LIMITS.templateChars} placeholder="Summarize, review, transform..." value={selectedNode.prompt ?? ""} onChange={(e) => updateNode({ prompt: e.target.value })} /></Field>
                </>}
                {selectedNode.type === "delegated" && <>
                  <div className={s.delegationSection}>
                    <span className={s.delegationTitle}>Leader</span>
                    <small>Plans worker roles and synthesizes their reports. Auto ranks your candidate list purely by token cost.</small>
                    <Field label="Leader mode"><select value={selectedNode.leaderAuto ?? "specific"} onChange={(e) => {
                      const value = e.target.value;
                      if (value === "specific") updateDelegated({ modelId: selectedNode.modelId ?? state.models[0]?.id ?? "" }, ["leaderAuto"]);
                      else updateDelegated({ leaderAuto: value as DelegationAuto, ...(leaderPool.length ? {} : { leaderPool: state.models.map((model) => model.id) }) }, ["modelId"]);
                    }}>
                      <option value="specific">Specific model</option>
                      <option value="cheap">Auto · cheapest</option>
                      <option value="value">Auto · cost effective</option>
                      <option value="performance">Auto · strongest</option>
                    </select></Field>
                    {selectedNode.leaderAuto === undefined
                      ? <Field label="Leader model"><select value={selectedNode.modelId ?? ""} onChange={(e) => updateDelegated({ modelId: e.target.value })}><option value="">Choose a model</option>{state.models.map((m) => <option key={m.id} value={m.id}>{m.name} · {formatTokenCost(m)}</option>)}</select></Field>
                      : <>
                        <details className={s.poolMenu}>
                          <summary>Choose the leader model list · {leaderPool.length} selected</summary>
                          <div className={s.poolList}>{state.models.map((model) => <label key={model.id} className={s.workerModelOption}>
                            <input type="checkbox" checked={leaderPool.includes(model.id)} onChange={(e) => updateDelegated({ leaderPool: e.target.checked ? [...leaderPool, model.id] : leaderPool.filter((id) => id !== model.id) })} />
                            <span><strong>{model.name}</strong><small>{model.model} · {formatTokenCost(model)}</small></span>
                          </label>)}
                            {state.models.length === 0 && <p>No models are configured yet.</p>}
                          </div>
                        </details>
                        <p className={s.resolvedNote}>Auto uses the <strong>{AUTO_STRATEGY_LABELS[selectedNode.leaderAuto]}</strong> candidate: {selectedDelegation?.leader?.name ?? "no usable candidates"}</p>
                      </>}
                  </div>
                  <div className={s.delegationSection}>
                    <span className={s.delegationTitle}>Workers</span>
                    <small>AI-created workers run in parallel. Auto picks one model for every worker from your candidate list.</small>
                    <Field label="Worker mode"><select value={selectedNode.workerAuto ?? "specific"} onChange={(e) => {
                      const value = e.target.value;
                      if (value === "specific") updateDelegated({ workerModelIds: selectedNode.workerModelIds?.length ? selectedNode.workerModelIds : state.models.map((model) => model.id) }, ["workerAuto"]);
                      else updateDelegated({ workerAuto: value as DelegationAuto, ...(workerPool.length ? {} : { workerPool: state.models.map((model) => model.id) }) }, ["workerModelIds"]);
                    }}>
                      <option value="specific">Specific models</option>
                      <option value="cheap">Auto · cheapest</option>
                      <option value="value">Auto · cost effective</option>
                      <option value="performance">Auto · strongest</option>
                    </select></Field>
                    {selectedNode.workerAuto === undefined
                      ? <div className={s.workerModelChooser}>
                        <span className={s.workerModelTitle}>Allowed worker models</span>
                        <small>The coordinator assigns each generated worker to one of these models.</small>
                        {state.models.map((model) => <label key={model.id} className={s.workerModelOption}>
                          <input type="checkbox" checked={(selectedNode.workerModelIds ?? []).includes(model.id)} onChange={(e) => {
                            const selected = (selectedNode.workerModelIds ?? []).filter((id) => state.models.some((item) => item.id === id));
                            updateDelegated({ workerModelIds: e.target.checked ? [...selected, model.id] : selected.filter((id) => id !== model.id) });
                          }} />
                          <span><strong>{model.name}</strong><small>{model.model} · {formatTokenCost(model)}</small></span>
                        </label>)}
                        {state.models.length === 0 && <><p>No models are configured yet.</p><button type="button" className={s.ghostButton} onClick={() => setModelEditor("new")}>+ Add a model</button></>}
                      </div>
                      : <>
                        <details className={s.poolMenu}>
                          <summary>Choose the worker model list · {workerPool.length} selected</summary>
                          <div className={s.poolList}>{state.models.map((model) => <label key={model.id} className={s.workerModelOption}>
                            <input type="checkbox" checked={workerPool.includes(model.id)} onChange={(e) => updateDelegated({ workerPool: e.target.checked ? [...workerPool, model.id] : workerPool.filter((id) => id !== model.id) })} />
                            <span><strong>{model.name}</strong><small>{model.model} · {formatTokenCost(model)}</small></span>
                          </label>)}
                            {state.models.length === 0 && <p>No models are configured yet.</p>}
                          </div>
                        </details>
                        <p className={s.resolvedNote}>Auto uses the <strong>{AUTO_STRATEGY_LABELS[selectedNode.workerAuto]}</strong> candidate: {selectedDelegation?.workers[0]?.name ?? "no usable candidates"}</p>
                      </>}
                  </div>
                  <div className={s.delegationSection}>
                    <span className={s.delegationTitle}>Validator</span>
                    <small>Reviews and corrects the coordinator&apos;s complete draft. This is static model review; code is not executed.</small>
                    <Field label="Validator model"><select value={selectedNode.validatorModelId ?? ""} onChange={(e) => updateDelegated({ validatorModelId: e.target.value || undefined })}>
                      <option value="">Use leader model{selectedDelegation?.leader ? ` · ${selectedDelegation.leader.name}` : ""}</option>
                      {state.models.map((m) => <option key={m.id} value={m.id}>{m.name} · {formatTokenCost(m)}</option>)}
                    </select></Field>
                  </div>
                  <Field label="Worker cap" hint={`Ceiling only. The leader chooses the exact count from 1 to ${selectedNode.maxWorkers ?? DEFAULT_DELEGATED_WORKERS}; the hard limit is ${LIMITS.delegatedWorkers}.`}><input type="number" min={1} max={LIMITS.delegatedWorkers} value={selectedNode.maxWorkers ?? DEFAULT_DELEGATED_WORKERS} onChange={(e) => updateNode({ maxWorkers: Math.max(1, Math.min(LIMITS.delegatedWorkers, Number(e.target.value) || 1)) })} /></Field>
                  <p className={s.delegationNote}>No prompt is needed. The leader selects focused parallel work, workers return only complete assigned deliverables without extra explanation, and the leader assembles a draft for the validator to review and correct. Worker output requests share an 8,192-token budget; each coordinator and validator request is capped at 8,192 tokens. The validator reasons from text only and cannot run the code. Auto modes rank leader and worker models purely by token cost. Each run uses one planning call, one call per worker, one synthesis call, and one validator call.</p>
                </>}
                {selectedNode.type === "condition" && <>
                  <Field label="Comparison"><select value={selectedNode.condition ?? "contains"} onChange={(e) => updateNode({ condition: e.target.value as PipelineNode["condition"] })}><option value="contains">Contains</option><option value="not-contains">Does not contain</option><option value="equals">Equals</option></select></Field>
                  <Field label="Literal text" hint="Case-sensitive. Matching output takes pass; otherwise fail. No invented confidence scores."><input value={selectedNode.value ?? ""} maxLength={LIMITS.templateChars} onChange={(e) => updateNode({ value: e.target.value })} /></Field>
                </>}
                {selectedNode.type === "variable" && <>
                  <Field label="Variable name" hint="Use letters, numbers, and underscores. Start with a letter or underscore."><input value={selectedNode.variable ?? ""} maxLength={64} onChange={(e) => updateNode({ variable: e.target.value })} /></Field>
                  <Field label="Value template"><textarea rows={4} value={selectedNode.value ?? ""} maxLength={LIMITS.templateChars} onChange={(e) => updateNode({ value: e.target.value })} /></Field>
                </>}
                {selectedNode.type === "output" && <Field label="Output template (optional)" hint="Leave empty to return the previous value."><textarea rows={4} value={selectedNode.prompt ?? ""} maxLength={LIMITS.templateChars} onChange={(e) => {
                  const nodes = state.graph.nodes.map((n) => { if (n.id !== selectedNode.id) return n; const next = { ...n }; if (e.target.value) next.prompt = e.target.value; else delete next.prompt; return next; }); changeGraph({ ...state.graph, nodes });
                }} /></Field>}
                {selectedNode.type === "custom" && (selectedCustomBlock
                  ? <div className={s.customInspector}>
                    <span className={s.customType}>{customBlockKind(selectedCustomBlock)}</span>
                    <strong>{selectedCustomBlock.name}</strong>
                    <p>{customBlockSummary(selectedCustomBlock, state.models)}</p>
                    {selectedCustomBlock.action.kind === "model" && <><span className={s.customInstructionLabel}>Model instructions</span><pre>{selectedCustomBlock.action.prompt || "No additional instructions."}</pre><small>Conversation system instructions are prepended only for chat runs.</small></>}
                    <button type="button" className={s.ghostButton} onClick={() => setCustomBlockEditor(selectedCustomBlock.id)}>Edit custom block</button>
                  </div>
                  : <p className={s.emptyNote}>This custom block definition is missing. Restore it in the Custom blocks library before running the pipeline.</p>)}
                {selectedNode.type === "start" && <p className={s.emptyNote}>The pipeline input enters here. Connect this block to a model or another block to begin.</p>}
                {["model", "variable", "output"].includes(selectedNode.type) && <p className={s.templateHelp}>Templates: <code>{"{{input}}"}</code> original input, <code>{"{{value}}"}</code> previous output, or a named variable such as <code>{"{{result}}"}</code>.</p>}
                <button className={s.dangerButton} onClick={() => { changeGraph({ nodes: state.graph.nodes.filter((n) => n.id !== selectedId), edges: state.graph.edges.filter((e) => e.from !== selectedId && e.to !== selectedId) }); setSelectedId(null); }}>Delete block</button>
              </fieldset> : <p className={s.emptyNote}>Select a block to configure its model, instructions, or branching rules.</p>}
              {selectedOutput !== undefined && <div className={s.stepOutput}><div className={s.sectionTitle}>Step output</div><pre>{selectedOutput || "(empty)"}</pre></div>}
              <div className={s.validation}><span className={s.sectionTitle}>Graph check</span>{graphErrors.length ? graphErrors.map((item) => <p key={item}>{item}</p>) : <p className={s.valid}>Connected and ready to run.</p>}<small>Only connected blocks execute. Conditions follow one branch. Loops are rejected.</small></div>
            </> : conversation ? <>
              <fieldset disabled={!!busy} className={s.fieldset}>
                <Field label="Conversation title"><input value={conversation.title} maxLength={100} onChange={(e) => updateConversation({ title: e.target.value })} /></Field>
                <Field label="System prompt" hint="Sent at the start of each request in this conversation."><textarea value={conversation.system} maxLength={LIMITS.templateChars} rows={6} placeholder="How should the model respond?" onChange={(e) => updateConversation({ system: e.target.value })} /></Field>
                <Field label="Recent messages to include" hint={`${Math.max(0, conversation.messages.length - conversation.historyLimit)} older messages excluded from the next request. Logs are kept.`}><input type="number" min={1} max={200} value={conversation.historyLimit} onChange={(e) => updateConversation({ historyLimit: Math.max(1, Math.min(200, Number(e.target.value) || 1)) })} /></Field>
              </fieldset>
              <div className={s.contextCard}><div className={s.sectionTitle}>Next request <span>ESTIMATE</span></div><strong>~{contextTokens.toLocaleString()} <small>input tokens</small></strong><div className={s.meter}><span style={{ width: `${contextRatio}%`, background: contextRatio > 95 ? "#f38ba8" : undefined }} /></div><p>{state.outputTokensMode === "auto" ? `Auto · up to ${chatOutputTokens.toLocaleString()} output tokens (${state.responseMode})` : `${chatOutputTokens.toLocaleString()} output tokens reserved per model call`}</p><p>{chatWindow ? `${chatWindow.toLocaleString()} token ${chatUsesPipeline ? "smallest configured model window" : "model window"}` : chatUsesPipeline ? "No model calls in the selected pipeline" : "Choose a model to set the window"}</p><small>{chatUsesPipeline ? `Includes the conversation history sent as pipeline input to ${chatPipeline?.name}. Delegated roles are generated at runtime, and each call's context is checked before it runs.` : "Includes your unsent draft."} Estimates are approximate; oversized context is blocked, not silently truncated.</small></div>
              <button className={s.ghostButton} onClick={() => setShowContext(!showContext)}>{showContext ? "Hide" : "Inspect"} request context</button>
              {showContext && <div className={s.contextPreview}>{chatUsesPipeline ? <>
                {conversation.system.trim() && <details><summary>Conversation instructions</summary><pre>{conversation.system}</pre></details>}
                  {chatPipelineModels.map(({ node, prompt, role }, index) => <details key={`${node.id}-${role}-${index}`}><summary>{node.label} · {role}</summary><pre>{[conversation.system.trim(), prompt].filter(Boolean).join("\n\n") || (role === "Coordinator" ? "Plans a worker team from the task at runtime." : role === "Worker model" ? "Worker role and assignment are generated by the coordinator at runtime." : "No system instructions")}</pre></details>)}
                <details open><summary>Pipeline input &middot; ~{estimateTokens([{ role: "user", content: pipelineInput }]).toLocaleString()} tokens</summary><pre>{pipelineInput}</pre></details>
              </> : nextContext.map((m, i) => <details key={i}><summary>{m.role} &middot; ~{estimateTokens([m]).toLocaleString()} tokens</summary><pre>{m.content}</pre></details>)}{context.length === 0 && !draft && <p className={s.emptyNote}>No context yet.</p>}</div>}
            </> : <p className={s.emptyNote}>Create a conversation to configure its system prompt and inspect context.</p>}
            <div className={s.settingsSection}>
              <Field label="Response detail" hint="This mode changes instructions sent to model steps and direct chat."><select value={state.responseMode} disabled={!!busy} onChange={(event) => setState((previous) => ({ ...previous, responseMode: event.target.value as StudioState["responseMode"] }))}><option value="minimal">Minimal</option><option value="detailed">Detailed</option></select></Field>
              <Field label="Output token reservation" hint="Auto reserves up to 512 tokens for Minimal or 4096 for Detailed, clamped to estimated remaining context. Manual uses the specified maximum."><select value={state.outputTokensMode} disabled={!!busy} onChange={(event) => setState((previous) => ({ ...previous, outputTokensMode: event.target.value as StudioState["outputTokensMode"] }))}><option value="auto">Auto (as needed)</option><option value="manual">Manual</option></select></Field>
              {state.outputTokensMode === "manual" && <Field label="Maximum output tokens" hint="Manual output cap for each request, shared by Pipeline and Chat."><input type="number" min={1} max={LIMITS.outputTokens} value={state.maxOutputTokens} disabled={!!busy} onChange={(event) => setState((previous) => ({ ...previous, maxOutputTokens: Math.max(1, Math.min(LIMITS.outputTokens, Number(event.target.value) || 1)) }))} /></Field>}
            </div>
          </div>
        </aside>}
      </div>
      <footer className={s.statusbar} role="status"><span className={`${s.statusDot} ${busy ? s.workingDot : ""}`} /><span>{status}</span><span className={s.statusPrivacy}>Chats saved in this browser &middot; Keys in memory only</span></footer>
      {modelEditor !== null && <ModelDialog key={modelEditor} existing={state.models.find((m) => m.id === modelEditor)} configuredModels={state.models} onSave={saveModel} onClose={() => setModelEditor(null)} onDelete={deleteModel} />}
      {customBlockEditor !== null && <CustomBlockDialog key={customBlockEditor} existing={state.customBlocks.find((block) => block.id === customBlockEditor)} models={state.models} onSave={saveCustomBlock} onClose={() => setCustomBlockEditor(null)} onDelete={deleteCustomBlock} />}
    </div>
  );
}
