"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, useReactFlow, useUpdateNodeInternals, useNodesInitialized, type Node, type NodeProps, type Connection, type NodeChange, type EdgeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createNode, getNodeDefinition, validateWorkflowShape, parseWorkflowJson, parseStrictJson, type Workflow, type WorkflowNode, type ValidationIssue } from "@studio/spec";
import { analyzeWorkflow } from "@studio/workflow-core";
import { Badge, Button, Field } from "@studio/ui";
import { ArrowLeft, Plus, Sparkles, LogIn, FileOutput, Download, Undo2, Redo2, Trash2, Braces, CheckCircle2, AlertCircle, CloudUpload, X, MousePointer2, Link2, Settings2, FileText } from "lucide-react";
import { newLocalDraft, normalizeLayout, nextNodePosition, readLocalDraft, writeLocalDraft, type LocalDraft } from "./local-drafts";
import { ResourcePicker } from './ResourcePicker';
import { withResourceAttachment, withoutResourceAttachment, releaseUnusedResourcePins } from './resource-links';
import { editorDefinitions, editorSupportIssues, explainEditorIssue, isEditorType, initialBindings, outputPorts, portNames, type EditorType } from './editor-contract';
import { ConfigInspector } from './ConfigInspector';
import { BindingEditor } from './BindingEditor';
import { ControlConnections } from './ControlConnections';

type CanvasNode = Node<{ block: WorkflowNode; invalid: boolean }, "workflow">;
const blockIcons: Partial<Record<EditorType, typeof LogIn>> = { input: LogIn, ai: Sparkles, output: FileOutput, form: FileText, classify: Link2, condition: Link2, resource: FileText, transform: Settings2, merge: Link2, guardrail: CheckCircle2, evaluate: CheckCircle2, error: AlertCircle, review: CheckCircle2 };

/** Custom nodes expose control ports only; all data movement stays in explicit bindings. */
const WorkflowBlock = memo(function WorkflowBlock({ id, data, selected }: NodeProps<CanvasNode>) {
  const type = data.block.type; const Icon = blockIcons[type as EditorType] ?? Settings2;
  const definition = getNodeDefinition(type)!; const ports = outputPorts(data.block); const portKey = ports.join('|');
  const updateInternals = useUpdateNodeInternals();
  // React Flow must recalculate handle geometry after a classification label or error route changes.
  useEffect(() => { updateInternals(id); }, [id, portKey, updateInternals]);
  return <div className={`workflow-node node-${type} ${selected ? "selected" : ""} ${data.invalid ? "invalid" : ""}`}>
    {definition.controlPorts.inputs.map((port) => <Handle key={port} type="target" position={Position.Left} id={port} aria-label={`${data.block.label} 실행 입력`}/>)}
    <div className="node-top"><span className="node-icon"><Icon size={19}/></span><span className="node-kind">{definition.title}</span>{data.invalid ? <AlertCircle size={14} className="node-warning"/> : <span className="node-ready-dot"/>}</div>
    <strong>{data.block.label}</strong><p>{data.block.type === "ai" ? data.block.config.instructions : definition.description}</p>
    <div className="node-footer"><span>{type === "input" ? "프로젝트 입력" : type === "output" ? "최종 결과" : `${ports.length}개 실행 경로`}</span><span>···</span></div>
    <div className="node-ports">{ports.map((port) => <div className="node-port" key={port}>{ports.length > 1 ? <span>{portNames[port] ?? port}</span> : null}<Handle type="source" position={Position.Right} id={port} aria-label={`${data.block.label} ${portNames[port] ?? port}`}/></div>)}</div>
  </div>;
});
const nodeTypes = { workflow: WorkflowBlock };

/** The provider owns viewport state; the canonical document remains independent of React Flow. */
export function WorkflowEditor(props: { draftId?: string; projectId?: string; cloudConfigured: boolean }) { return <ReactFlowProvider><EditorInner {...props}/></ReactFlowProvider>; }

function EditorInner({ draftId, projectId, cloudConfigured }: { draftId?: string; projectId?: string; cloudConfigured: boolean }) {
  const [draft, setDraft] = useState<LocalDraft>(() => newLocalDraft());
  const [loaded, setLoaded] = useState(false); const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<string>(); const [tab, setTab] = useState<"basic" | "resources" | "io">("basic");
  const [localStatus, setLocalStatus] = useState("브라우저에 저장 중…");
  const [notice, setNotice] = useState(""); const [savingCloud, setSavingCloud] = useState(false);
  const [past, setPast] = useState<LocalDraft[]>([]); const [future, setFuture] = useState<LocalDraft[]>([]);
  const [showIssues, setShowIssues] = useState(false); const [showJson, setShowJson] = useState(false); const [jsonText, setJsonText] = useState("");
  const [showExport, setShowExport] = useState(false); const [host, setHost] = useState("codex"); const [exporting, setExporting] = useState(false);
  const [bindingText, setBindingText] = useState(""); const [bindingError, setBindingError] = useState("");
  const [jsonError, setJsonError] = useState(""); const [paletteSearch, setPaletteSearch] = useState("");
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const [measurements, setMeasurements] = useState<Record<string, { width: number; height: number }>>({});
  const nodesInitialized = useNodesInitialized();
  const flow = useReactFlow<CanvasNode>(); const dragOrigin = useRef<LocalDraft | null>(null); const latest = useRef(draft);
  latest.current = draft;
  const workflow = draft.workflow;
  const issues = useMemo(() => { const shape = validateWorkflowShape(workflow); return (shape.valid ? [...analyzeWorkflow(shape.value), ...editorSupportIssues(shape.value)] : shape.issues).map((issue) => explainEditorIssue(issue, workflow)); }, [workflow]);
  const errors = issues.filter((issue) => issue.severity === "error");
  const block = workflow.nodes.find((node) => node.id === selected);

  // Loading precedes autosave so a failed cloud read cannot overwrite a stored local recovery copy.
  useEffect(() => { let cancelled = false; (async () => {
    try {
      // Canonicalizing this draft's address must not reload its snapshot or reset the selected block.
      if (loaded && !projectId && draftId === latest.current.workflow.id) return;
      let next: LocalDraft;
      if (projectId) {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" });
        const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "프로젝트를 불러오지 못했습니다.");
        const checked = validateWorkflowShape(body.draft?.workflow); if (!checked.valid) throw new Error("저장된 프로젝트 형식을 확인해야 합니다.");
        next = { storageVersion: 1, workflow: checked.value, editor: normalizeLayout(body.draft.editor, checked.value), updatedAt: body.draft.updated_at, cloud: { id: projectId, version: body.draft.version } };
      } else if (draftId) { const stored = readLocalDraft(draftId); if (!stored) throw new Error("이 브라우저에서 해당 초안을 찾을 수 없습니다."); next = stored; }
      else next = latest.current;
      if (!cancelled) { setDraft(next); setSelected(next.workflow.nodes.find((node) => node.type === "ai")?.id ?? next.workflow.entryNodeId); setLoaded(true); }
    } catch (error) { if (!cancelled) setLoadError(error instanceof Error ? error.message : "프로젝트를 불러오지 못했습니다."); }
  })(); return () => { cancelled = true; }; }, [projectId, draftId]);

  // Browser persistence is a recovery aid, not an acknowledgement from the account storage service.
  useEffect(() => { if (!loaded) return; setLocalStatus("브라우저에 저장 중…"); const timer = window.setTimeout(() => { try {
    writeLocalDraft(draft);
    // A successfully stored new draft needs a stable URL so browser refresh reopens this project.
    if (!projectId) { const url = new URL(window.location.href); if (url.searchParams.get('draft') !== draft.workflow.id) { url.searchParams.set('draft', draft.workflow.id); window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`); } }
    setLocalStatus("이 브라우저에 저장됨");
  } catch { setLocalStatus("브라우저 저장 실패"); setNotice("저장 공간을 확인해 주세요. 설계 JSON을 내려받아 내용을 보관할 수 있습니다."); } }, 800); return () => window.clearTimeout(timer); }, [draft, loaded, projectId]);
  useEffect(() => { if (!loaded) return; const save = () => { try { writeLocalDraft(latest.current); } catch { /* The visible autosave state reports quota failures; unload must not throw. */ } }; window.addEventListener("pagehide", save); return () => window.removeEventListener("pagehide", save); }, [loaded]);
  useEffect(() => { setBindingText(JSON.stringify(block?.inputBindings ?? {}, null, 2)); setBindingError(""); }, [selected, block?.inputBindings]);
  // Adding a card should reveal the complete graph; dragging keeps the user's chosen viewport unchanged.
  useEffect(() => { if (!loaded || !nodesInitialized) return; const frame = requestAnimationFrame(() => { void flow.fitView({ padding: .18, duration: 180, maxZoom: 1 }); }); return () => cancelAnimationFrame(frame); }, [loaded, nodesInitialized, workflow.nodes.length, flow]);

  /** Immutable snapshots make undo/redo cover executable data and layout without mutating references. */
  const commit = useCallback((change: (value: LocalDraft) => LocalDraft) => {
    // State updaters may run twice in Strict Mode; history changes belong to the event boundary.
    const current = latest.current;
    const next = { ...change(current), updatedAt: new Date().toISOString() };
    latest.current = next;
    setPast((history) => [...history.slice(-49), current]);
    setFuture([]);
    setDraft(next);
  }, []);
  const patchNode = (patch: Partial<WorkflowNode>) => { if (selected) commit((current) => ({ ...current, workflow: releaseUnusedResourcePins(current.workflow, { ...current.workflow, nodes: current.workflow.nodes.map((node) => node.id === selected ? { ...node, ...patch } as WorkflowNode : node) as Workflow["nodes"] }) })); };
  const undo = useCallback(() => { const previous = past.at(-1); if (!previous) return; setFuture((items) => [draft, ...items]); setPast((items) => items.slice(0, -1)); setDraft({ ...previous, updatedAt: new Date().toISOString() }); }, [past, draft]);
  const redo = useCallback(() => { const next = future[0]; if (!next) return; setPast((items) => [...items, draft]); setFuture((items) => items.slice(1)); setDraft({ ...next, updatedAt: new Date().toISOString() }); }, [future, draft]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); if (event.shiftKey) redo(); else undo(); } if (event.key === "Escape") { setShowJson(false); setShowExport(false); } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [undo, redo]);
  // Modal keyboard focus stays in the active dialog and returns to the invoking control on close.
  useEffect(() => { if (!showJson && !showExport) return; const previous = document.activeElement; const dialog = document.querySelector<HTMLElement>('[role="dialog"]'); if (!dialog) return; const selector = 'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]'; dialog.querySelector<HTMLElement>(selector)?.focus(); const trap = (event: KeyboardEvent) => { if (event.key !== "Tab") return; const controls = [...dialog.querySelectorAll<HTMLElement>(selector)]; const first = controls[0]; const last = controls.at(-1); if (!first || !last) return; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }; document.addEventListener("keydown", trap); return () => { document.removeEventListener("keydown", trap); if (previous instanceof HTMLElement) previous.focus(); }; }, [showJson, showExport]);

  const addNode = (type: EditorType, position?: { x: number; y: number }) => {
    const node = createNode(type); node.id = `n_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
    node.inputBindings = initialBindings(type);
    // Existing projects already have a start input; an added question asks during the run by default.
    if (node.type === 'form') node.config = { mode: 'request', title: '필요한 내용을 입력해 주세요', schema: { type: 'object', properties: {}, required: [], additionalProperties: false } };
    if (node.type === 'agent') node.config = { ...node.config, maxSteps: 1 };
    if (node.type === 'knowledge') node.config = { operation: 'build', profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 2000, chunkOverlap: 200 } };
    commit((current) => ({ ...current, workflow: { ...current.workflow, nodes: [...current.workflow.nodes, node] }, editor: { ...current.editor, positions: { ...current.editor.positions, [node.id]: position ?? nextNodePosition(current.editor.positions) } } }));
    setSelected(node.id); setNotice("블록을 추가했습니다. 연결선과 입력 참조를 설정해 주세요.");
  };
  const removeNodes = (ids: string[]) => {
    if (workflow.nodes.filter((node) => !ids.includes(node.id)).length < 2) { setNotice("워크플로에는 최소 두 개의 블록이 필요합니다. 블록을 추가한 뒤 삭제해 주세요."); return; }
    commit((current) => {
      const next = { ...current.workflow, resources: { ...current.workflow.resources }, nodes: current.workflow.nodes.filter((node) => !ids.includes(node.id)) as Workflow['nodes'], edges: current.workflow.edges.filter((edge) => !ids.includes(edge.from.nodeId) && !ids.includes(edge.to.nodeId)) };
      const entries = next.nodes.filter((node) => node.type === 'input' || node.type === 'form' && node.config.mode === 'initial');
      if (ids.includes(next.entryNodeId) && entries.length === 1) next.entryNodeId = entries[0]!.id;
      // Removing the final attached node also removes its private material from subsequent exports.
      return { ...current, workflow: releaseUnusedResourcePins(current.workflow, next), editor: { ...current.editor, positions: Object.fromEntries(Object.entries(current.editor.positions).filter(([id]) => !ids.includes(id))) } };
    });
    if (selected && ids.includes(selected)) setSelected(undefined);
  };
  const nodes = useMemo<CanvasNode[]>(() => workflow.nodes.map((node) => ({ id: node.id, type: "workflow", measured: measurements[node.id], position: draft.editor.positions[node.id] ?? { x: 0, y: 0 }, data: { block: node, invalid: issues.some((issue) => issue.nodeId === node.id && issue.severity === "error") }, selected: node.id === selected })), [workflow.nodes, draft.editor.positions, issues, selected, measurements]);
  const edges = useMemo(() => workflow.edges.map((edge) => ({ id: edge.id, source: edge.from.nodeId, target: edge.to.nodeId, sourceHandle: edge.from.port, targetHandle: edge.to.port, selected: selectedEdges.includes(edge.id), type: "smoothstep", style: { stroke: selectedEdges.includes(edge.id) ? "#2563eb" : "#a2b4d2", strokeWidth: selectedEdges.includes(edge.id) ? 3 : 2 } })), [workflow.edges, selectedEdges]);
  const onConnect = (connection: Connection) => { if (!connection.source || !connection.target || connection.source === connection.target) return; commit((current) => ({ ...current, workflow: { ...current.workflow, edges: [...current.workflow.edges, { id: `e_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`, from: { nodeId: connection.source, port: connection.sourceHandle ?? "next" }, to: { nodeId: connection.target, port: connection.targetHandle ?? "in" } }] } })); };
  const onNodesChange = (changes: NodeChange<CanvasNode>[]) => {
    // Controlled React Flow nodes must retain measured dimensions for fit-view and handle geometry.
    // Measurements are transient UI state and never enter workflow.json or the editor's stored positions.
    if (changes.some((change) => change.type === 'dimensions')) setMeasurements((current) => {
      const next = { ...current }; let changed = false;
      for (const change of changes) if (change.type === 'dimensions' && change.dimensions && (current[change.id]?.width !== change.dimensions.width || current[change.id]?.height !== change.dimensions.height)) { next[change.id] = change.dimensions; changed = true; }
      return changed ? next : current;
    });
    const removed = changes.filter((change) => change.type === "remove").map((change) => change.id); if (removed.length) removeNodes(removed);
    const positions = changes.filter((change) => change.type === "position"); if (positions.length) setDraft((current) => { const next = { ...current.editor.positions }; for (const change of positions) if (change.type === "position" && change.position) next[change.id] = change.position; return { ...current, editor: { ...current.editor, positions: next }, updatedAt: new Date().toISOString() }; });
  };
  const onEdgesChange = (changes: EdgeChange[]) => { for (const change of changes) if (change.type === "select") setSelectedEdges((ids) => change.selected ? [...new Set([...ids, change.id])] : ids.filter((id) => id !== change.id)); const ids = changes.filter((change) => change.type === "remove").map((change) => change.id); if (ids.length) commit((current) => ({ ...current, workflow: { ...current.workflow, edges: current.workflow.edges.filter((edge) => !ids.includes(edge.id)) } })); };
  const focusIssue = (issue: ValidationIssue) => { if (!issue.nodeId) return; setSelected(issue.nodeId); setTab(issue.instancePath.includes("inputBindings") ? "io" : "basic"); void flow.fitView({ nodes: [{ id: issue.nodeId }], duration: 200, maxZoom: 1 }); };

  /** Cloud saves acknowledge only a successful server response, including optimistic-version conflicts. */
  const saveCloud = async () => { setSavingCloud(true); setNotice(""); const snapshot = latest.current; try {
    const response = await fetch(snapshot.cloud ? `/api/projects/${snapshot.cloud.id}` : "/api/projects", { method: snapshot.cloud ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflow: snapshot.workflow, editor: snapshot.editor, expectedVersion: snapshot.cloud?.version }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "계정 저장에 실패했습니다.");
    const cloud = snapshot.cloud ? { id: snapshot.cloud.id, version: body.version } : { id: body.project.id, version: body.draft.version };
    setDraft((current) => ({ ...current, cloud })); setNotice(latest.current.workflow === snapshot.workflow ? "계정에 저장했습니다." : "선택한 시점의 내용을 계정에 저장했습니다. 이후 변경은 다시 저장해 주세요.");
  } catch (error) { setNotice(error instanceof Error ? error.message : "계정 저장에 실패했습니다."); } finally { setSavingCloud(false); } };

  /** Downloads contain the current explicitly selected browser snapshot, not pretend signed releases. */
  const downloadZip = async () => { setExporting(true); setNotice(""); try { const response = await fetch("/api/exports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflow, editor: draft.editor, host }) }); if (!response.ok) { const body = await response.json(); throw new Error(body.error?.message ?? "ZIP을 만들지 못했습니다."); } const blob = await response.blob(); saveBlob(blob, `workflow-${host}.zip`); setShowExport(false); setNotice("운영 ZIP을 내려받았습니다. Runner와 모델 연결을 준비한 뒤 실행해 주세요."); } catch (error) { setNotice(error instanceof Error ? error.message : "다운로드에 실패했습니다."); } finally { setExporting(false); } };
  const applyJson = () => { const parsed = parseWorkflowJson(jsonText); if (!parsed.valid) { setJsonError(parsed.issues.map((issue) => issue.message).join("\n")); return; } if (parsed.value.nodes.some((node) => !isEditorType(node.type)) || Object.keys(parsed.value.subworkflows).length) { setJsonError("현재 편집기는 안내된 20개 블록과 단일 흐름을 지원합니다. 하위 흐름은 아직 가져올 수 없습니다."); return; } commit((current) => ({ ...current, workflow: parsed.value, editor: normalizeLayout(current.editor, parsed.value) })); setShowJson(false); setSelected(parsed.value.entryNodeId); setNotice("설계 내용을 적용했습니다."); };
  const applyBindings = () => { if (!block) return; let value: unknown; try { value = parseStrictJson(bindingText); } catch { setBindingError("JSON 형식을 확인해 주세요."); return; } const candidate = { ...workflow, nodes: workflow.nodes.map((node) => node.id === selected ? { ...node, inputBindings: value } : node) }; const checked = validateWorkflowShape(candidate); if (!checked.valid) { setBindingError(checked.issues.map((issue) => issue.message).join("\n")); return; } commit((current) => ({ ...current, workflow: releaseUnusedResourcePins(current.workflow, checked.value) })); setBindingError(""); setNotice("입력 참조를 적용했습니다."); };

  if (loadError) return <div className="loading-panel"><AlertCircle size={24}/><h2>프로젝트를 열 수 없습니다</h2><p>{loadError}</p><Link href="/projects" className="button button-primary">내 프로젝트로 이동</Link></div>;
  if (!loaded) return <div className="loading-panel">프로젝트를 불러오고 있습니다…</div>;
  return <div className="editor-workspace">
    <div className="editor-titlebar"><div className="editor-title"><Link href="/projects" className="icon-button" aria-label="내 프로젝트로 돌아가기"><ArrowLeft size={19}/></Link><div><input aria-label="프로젝트 이름" value={workflow.name} maxLength={120} onChange={(event) => commit((current) => ({ ...current, workflow: { ...current.workflow, name: event.target.value } }))}/><span><span className="small-dot"/>{localStatus}</span></div><Badge>브라우저 초안</Badge></div><div className="editor-actions"><Button variant="ghost" onClick={undo} disabled={!past.length} aria-label="실행 취소"><Undo2/></Button><Button variant="ghost" onClick={redo} disabled={!future.length} aria-label="다시 실행"><Redo2/></Button><span className="toolbar-divider"/><Button variant="secondary" onClick={() => { setShowIssues((value) => !value); }}><CheckCircle2/>준비 상태 확인{errors.length ? ` (${errors.length})` : ""}</Button><Button variant="secondary" onClick={saveCloud} disabled={savingCloud || !cloudConfigured} title={!cloudConfigured ? "계정 저장 연결이 필요합니다" : undefined}><CloudUpload/>{savingCloud ? "저장 중" : "계정에 저장"}</Button><Button onClick={() => { if (errors.length) setShowIssues(true); else setShowExport(true); }}><Download/>ZIP 다운로드</Button></div></div>
    {notice ? <div className="editor-notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="안내 닫기"><X size={14}/></button></div> : null}
    <div className="editor-grid"><aside className="node-palette"><div className="palette-heading"><strong>블록</strong><Badge>{editorDefinitions.length}개 사용 가능</Badge></div><p>AI가 일할 순서대로 연결하세요.</p><input className="palette-search" aria-label="블록 검색" placeholder="블록 검색" value={paletteSearch} onChange={(event) => setPaletteSearch(event.target.value)}/>
      {[...new Set(editorDefinitions.map((definition) => definition.category))].map((category) => <div key={category}><div className="palette-section-label">{category}</div>{editorDefinitions.filter((definition) => definition.category === category && `${definition.title} ${definition.description}`.includes(paletteSearch)).map((definition) => { const Icon = blockIcons[definition.type as EditorType] ?? Settings2; return <button key={definition.type} className={`palette-node node-${definition.type}`} draggable onDragStart={(event) => { event.dataTransfer.setData("application/studio-node", definition.type); event.dataTransfer.effectAllowed = "move"; }} onClick={() => addNode(definition.type as EditorType)}><span className="palette-node-icon"><Icon size={18}/></span><span><strong>{definition.title}</strong><small>{definition.description}</small></span><Plus size={14}/></button>; })}</div>)}
      <div className="palette-tip"><MousePointer2 size={16}/><p>블록을 클릭하거나<br/>캔버스로 끌어 놓으세요.</p></div><div className="palette-bottom"><p>도구와 자료가 더 필요하신가요?</p><Link href="/resources">도구 및 자료 관리 →</Link></div></aside>
    <div className="canvas-area" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); const type = event.dataTransfer.getData("application/studio-node"); if (isEditorType(type)) addNode(type, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}>
      <div className="canvas-caption"><span className="canvas-label"><span className="canvas-dot"/>워크플로</span><span>{workflow.nodes.length}개 블록 · {workflow.edges.length}개 연결</span></div>
      <ReactFlow<CanvasNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_event, node) => setSelected(node.id)} onPaneClick={() => setSelected(undefined)} onNodeDragStart={() => { dragOrigin.current = latest.current; }} onNodeDragStop={() => { const previous = dragOrigin.current; if (previous) { setPast((items) => [...items.slice(-49), previous]); setFuture([]); dragOrigin.current = null; } }} fitView fitViewOptions={{ padding: .22, maxZoom: 1 }} minZoom={.3} maxZoom={1.5} deleteKeyCode={["Backspace", "Delete"]} aria-label="워크플로 캔버스"><Background color="#d9e0eb" gap={22} size={1}/><Controls showInteractive={false}/><MiniMap nodeColor={(node) => workflow.nodes.find((block) => block.id === node.id)?.type === "ai" ? "#b8d0fb" : workflow.nodes.find((block) => block.id === node.id)?.type === "input" ? "#bde6d8" : "#ded0fa"} pannable zoomable/></ReactFlow>
      <div className="canvas-guidance"><Link2 size={14}/><span>블록의 연결점으로 순서를 이어 주세요. 데이터는 입력·결과에서 설정합니다.</span></div>
      {showIssues ? <div className="validation-panel"><div><strong>{errors.length ? `확인이 필요한 항목 ${errors.length}개` : "설계 검사를 통과했습니다"}</strong><button className="icon-button" onClick={() => setShowIssues(false)} aria-label="검사 결과 닫기"><X size={16}/></button></div>{issues.length ? <ul>{issues.map((issue, index) => <li key={`${issue.code}-${index}`}><button onClick={() => focusIssue(issue)}><AlertCircle size={15}/><span>{issue.message}<small>{issue.hint}</small></span></button></li>)}</ul> : <p>실행 전 Runner에서 실제 모델 연결과 실행 환경을 확인합니다.</p>}</div> : null}
    </div>
    <aside className="node-inspector"><label className="node-selector"><span>설정할 블록</span><select aria-label="설정할 블록" value={selected ?? ""} onChange={(event) => setSelected(event.target.value || undefined)}><option value="">블록 선택</option>{workflow.nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label><div className="inspector-heading"><span><Settings2 size={16}/>블록 설정</span>{block ? <Button variant="ghost" onClick={() => removeNodes([block.id])} aria-label="선택한 블록 삭제"><Trash2 size={15}/></Button> : null}</div><div className="inspector-tabs" role="tablist" aria-label="블록 설정 탭">{([['basic','기본'],['resources','자료·도구'],['io','입력·결과']] as const).map(([key, text]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{text}</button>)}</div>
    {block ? <div className="inspector-content" role="tabpanel" key={`${block.id}-${tab}`}>
      {tab === 'basic' ? <ConfigInspector node={block} workflow={workflow} onNode={patchNode} onWorkflow={(patch) => commit((current) => ({ ...current, workflow: { ...current.workflow, ...patch } }))}/> : tab === 'resources' ? <ResourcePicker configured={cloudConfigured} node={block} resources={workflow.resources} onAttach={(reference) => { try { commit((current) => ({ ...current, workflow: withResourceAttachment(current.workflow, block.id, reference) })); setNotice('자료 버전을 고정해 연결했습니다.'); } catch (error) { setNotice(error instanceof Error ? error.message : '자료를 연결하지 못했습니다.'); } }} onDetach={(id) => commit((current) => ({ ...current, workflow: withoutResourceAttachment(current.workflow, block.id, id) }))}/> : <>
        <BindingEditor node={block} workflow={workflow} onChange={(inputBindings) => patchNode({ inputBindings })}/>
        <details className="advanced-settings"><summary>입력 참조 고급 JSON</summary><Field label="입력 참조" htmlFor="node-bindings" hint="직접 JSON을 편집할 때만 사용합니다. 노드 결과는 /data부터 참조합니다."><textarea id="node-bindings" className="code-input" rows={10} value={bindingText} onChange={(event) => setBindingText(event.target.value)}/></Field>{bindingError ? <p className="form-error" role="alert">{bindingError}</p> : null}<Button variant="secondary" onClick={applyBindings}>입력 참조 적용</Button></details>
        <details className="advanced-settings"><summary>결과 계약 보기</summary><pre className="schema-preview">{JSON.stringify(block.type === 'output' ? workflow.outputs : block.type === 'input' ? workflow.inputs : getNodeDefinition(block.type)?.outputSchema, null, 2)}</pre></details>
      </>}
      <ControlConnections node={block} workflow={workflow} onChange={(edges) => commit((current) => ({ ...current, workflow: { ...current.workflow, edges } }))}/>
    </div> : <div className="inspector-empty no-selection"><MousePointer2 size={30}/><h3>블록을 선택해 주세요</h3><p>선택한 블록의 작업 내용과<br/>입력·결과를 설정할 수 있습니다.</p></div>}
    <div className="inspector-bottom"><Button variant="ghost" onClick={() => { setJsonText(JSON.stringify(workflow, null, 2)); setJsonError(""); setShowJson(true); }}><Braces size={16}/>설계 JSON 보기·가져오기</Button></div></aside></div>
    {showExport ? <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !exporting) setShowExport(false); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="modal-heading"><h2 id="export-title">내 도구에서 이어서 실행</h2><button className="icon-button" onClick={() => setShowExport(false)} aria-label="다운로드 창 닫기"><X/></button></div><p>현재 브라우저 초안을 운영용 ZIP으로 내려받습니다.</p><div className="host-options">{[['codex','Codex'],['claude-code','Claude Code'],['opencode','OpenCode']].map(([value,label]) => <label key={value} className={host === value ? "selected" : ""}><input type="radio" name="host" value={value} checked={host === value} onChange={() => setHost(value!)} /><strong>{label}</strong><span>Studio Runner 연결 포함</span></label>)}</div><div className="export-info"><strong>실행 전 준비</strong><p>Studio Runner 설치와 실제 모델 연결이 필요합니다. 이 ZIP은 개인 프로젝트이며 공식 검수·서명된 배포가 아닙니다.</p></div><Button onClick={downloadZip} disabled={exporting}><Download/>{exporting ? "ZIP을 만드는 중…" : "ZIP 다운로드"}</Button></section></div> : null}
    {showJson ? <div className="modal-backdrop"><section className="modal-card json-modal" role="dialog" aria-modal="true" aria-labelledby="json-title"><div className="modal-heading"><h2 id="json-title">워크플로 설계 파일</h2><button className="icon-button" onClick={() => setShowJson(false)} aria-label="설계 창 닫기"><X/></button></div><p>실행 설계를 JSON으로 보관하거나 가져올 수 있습니다. 인증정보는 입력하지 마세요.</p><textarea aria-label="워크플로 JSON" className="code-input" rows={20} value={jsonText} onChange={(event) => setJsonText(event.target.value)}/>{jsonError ? <p className="form-error" role="alert">{jsonError}</p> : null}<div className="modal-actions"><Button variant="secondary" onClick={() => saveBlob(new Blob([JSON.stringify(workflow, null, 2)], { type: "application/json" }), "workflow.json")}>JSON 내려받기</Button><Button onClick={applyJson}>내용 적용</Button></div></section></div> : null}
  </div>;
}

/** Object URLs are revoked after the browser receives the download to avoid accumulating blob memory. */
function saveBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
