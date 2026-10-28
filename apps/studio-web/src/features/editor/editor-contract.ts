import { EDITOR_NODE_TYPES, getNodeDefinition, type EditorNodeType, type Workflow, type WorkflowNode, type NodeType, type ValidationIssue } from '@studio/spec';
import { validateExpression, validateTransformSteps, validateGuardrail, validateManagedOutput, validateTextExtraction, validateRunRagNode } from '@studio/workflow-core';
import { issueLocation, flowView } from './flow-helpers';
import { validateAuthoredRag } from './rag-authoring';
import { validateAuthoredAgent } from './agent-authoring';

/** The authoring surface is a tested subset of the registry, not an assertion about every installed Runner. */
export const EDITOR_TYPES = EDITOR_NODE_TYPES;
export type EditorType = EditorNodeType;
/** Palette copy describes the offered operational mode, while the canonical registry retains the full type contract. */
export function editorNodeDescription(type: NodeType): string {
  const descriptions: Partial<Record<NodeType, string>> = {
    agent: 'AI가 한 번 작업하거나 키워드 문서를 검색하며 답합니다.',
    document_extract: 'TXT·Markdown·JSON의 원문과 위치를 읽습니다.',
    memory: '현재 실행 안에서 값을 저장하거나 읽습니다.',
    knowledge: '현재 실행의 문서를 키워드·벡터·혼합 색인으로 구성합니다.',
    retrieval: '키워드·벡터·혼합 검색으로 문서의 근거를 찾습니다.',
  };
  return descriptions[type] ?? getNodeDefinition(type)!.description;
}
export const editorDefinitions = EDITOR_TYPES.map((type) => ({ ...getNodeDefinition(type)!, description: editorNodeDescription(type) }));
export function isEditorType(type: string): type is EditorType { return (EDITOR_TYPES as readonly string[]).includes(type); }

/** Dynamic decision ports are derived from canonical config; error is available only after opting into routing. */
export function outputPorts(node: WorkflowNode): string[] {
  const ports = node.type === 'classify' ? [...node.config.labels.map((label) => label.id), 'unclassified'] : [...getNodeDefinition(node.type)!.controlPorts.outputs];
  return [...ports, ...(node.execution.onError === 'route' && node.type !== 'output' ? ['error'] : [])];
}
export const portNames: Record<string, string> = { next: '다음 작업', true: '조건 일치', false: '조건 불일치', accepted: '수락', rejected: '반려', unclassified: '분류 불가', error: '업무 오류' };

/** The same capability gate runs in the browser and the export route so JSON import cannot bypass the UI scope. */
export function editorSupportIssues(workflow: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [flowId, definition] of [['main', workflow], ...Object.entries(workflow.subworkflows)] as const) {
  if (!definition) continue;
  const prefix = flowId === 'main' ? '' : `/subworkflows/${flowId}`;
  const add = (message: string, node: WorkflowNode, suffix = '') => issues.push({ severity: 'error', stage: 'readiness', code: 'EDITOR_MODE_UNSUPPORTED', message, nodeId: node.id, instancePath: `${prefix}/nodes/${definition.nodes.indexOf(node)}${suffix}` });
  for (const node of definition.nodes) {
    if (node.type === 'subworkflow' && node.config.flowRef.kind !== 'local') add(`${node.label}: 프로젝트 안의 고정 하위 흐름만 호출할 수 있습니다.`, node, '/config/flowRef');
    if (flowId !== 'main' && (node.type === 'review' || node.type === 'form' && node.config.mode === 'request' || node.type === 'file_input' && node.inputBindings.files?.from === 'literal' && Array.isArray(node.inputBindings.files.value) && !node.inputBindings.files.value.length)) add(`${node.label}: 하위 흐름에서는 사용자 응답·파일 선택을 기다릴 수 없습니다. 기본 흐름에서 받아 전달하세요.`, node, '/config');
    // These checks inspect the declared AST/options without executing user inputs or fabricating sample results.
    try {
      if (node.type === 'transform') validateTransformSteps(node.config.steps);
      if (node.type === 'condition') validateExpression(node.config.expression);
      if (node.type === 'guardrail') validateGuardrail(node.config);
      if (node.type === 'file_output') validateManagedOutput(node.config);
      if (node.type === 'agent') validateAuthoredAgent(node, workflow);
      if (node.type === 'document_extract') validateTextExtraction(node);
      if (node.type === 'knowledge' || node.type === 'retrieval') {
        // Backend additions do not silently widen the explicitly supported authoring modes.
        validateAuthoredRag(node);
        validateRunRagNode(node);
      }
      if (node.type === 'evaluate') { validateExpression(node.config.passRule); for (const rule of node.config.rules ?? []) validateExpression(rule.expression); }
    } catch (error) { add(`${node.label}: ${error instanceof Error ? error.message : '설정 형식을 확인하세요.'}`, node, '/config'); }
    if (!isEditorType(node.type)) add(`${node.label}: 이 블록은 아직 편집·다운로드를 지원하지 않습니다.`, node);
    if (node.type === 'evaluate' && node.config.mode !== 'rules') add(`${node.label}: 편집기는 현재 규칙 평가를 지원합니다. 모델 평가 설정은 보존되지만 다운로드는 준비되지 않았습니다.`, node, '/config/mode');
    if (node.type === 'evaluate' && node.config.mode === 'rules' && !node.config.rules?.length) add(`${node.label}: 평가 규칙을 하나 이상 추가하세요.`, node, '/config/rules');
    if (node.type === 'output' && node.config.format === 'files') add(`${node.label}: 파일 결과 편집은 아직 준비되지 않았습니다. 텍스트 또는 JSON을 선택하세요.`, node, '/config/format');
    if (!['ai', 'agent'].includes(node.type) && node.attachments.length) add(`${node.label}: 자료 첨부는 AI 작업과 에이전트에서 지원합니다. 자료 읽기 블록은 읽을 자료를 선택하세요.`, node, '/attachments');
    if (node.type === 'error' && (node.inputBindings.error?.from !== 'error' || node.config.mode === 'recover' && !node.inputBindings.fallback)) add(`${node.label}: 오류 문맥과 복구 시 대체 결과를 입력·결과에서 연결하세요.`, node, '/inputBindings');
    if (node.type === 'classify' && node.config.labels.length > 100) add(`${node.label}: 분류는 최대 100개입니다.`, node, '/config/labels');
    if (node.type === 'file_input' && (node.config.maxFiles > 100 || node.config.maxBytesPerFile > 16 * 1024 * 1024)) add(`${node.label}: 파일은 최대 100개, 파일당 16 MiB까지 선택할 수 있습니다.`, node, '/config');
    if (node.type === 'memory' && (node.config.scope !== 'run' || node.config.ttlMs !== undefined && (node.config.operation !== 'put' || node.config.ttlMs > 2592000000))) add(`${node.label}: 현재 실행 안의 기억만 지원하며 유효기간은 저장할 때 최대 30일입니다.`, node, '/config');
    if (node.type === 'memory' && node.config.operation === 'put' && !node.inputBindings.value) add(`${node.label}: 저장할 값을 연결하세요.`, node, '/inputBindings/value');
    if (node.type === 'file_output' && !node.inputBindings[node.config.format === 'copy' ? 'file' : 'content']) add(`${node.label}: ${node.config.format === 'copy' ? '복사할 파일' : '파일 내용'}을 연결하세요.`, node, '/inputBindings');
  }
  }
  return issues;
}

/** Field labels explain data roles independently from control connections. */
export const bindingNames: Record<string, string> = { content: '작업할 내용', context: '참고 내용', initialValues: '처음 표시할 값', result: '최종 결과', value: '검사·처리할 값', error: '발생한 오류', fallback: '대체 결과', criteria: '평가 참고 기준', task: '에이전트가 할 일', key: '기억 이름', file: '복사할 파일', files: '선택한 파일', documents: '색인에 넣을 문서', index: '검색용 색인', indexes: '검색용 색인 목록', query: '검색어' };
export function bindingFields(node: WorkflowNode): { key: string; required: boolean }[] {
  const schema = getNodeDefinition(node.type)!.inputSchema;
  const keys = new Set([...Object.keys((schema.properties ?? {}) as object), ...Object.keys(node.inputBindings)]);
  if (node.type === 'knowledge') return [{ key: node.config.operation === 'build' ? 'documents' : 'index', required: true }];
  if (node.type === 'retrieval') return [{ key: 'query', required: true }, { key: 'index', required: true }];
  // Agentic requires an array even for a single index. Task imports retain invalid indexes in JSON without offering them as a supported field.
  if (node.type === 'agent') return [...keys].filter(key => node.config.strategy === 'agentic_rag' || key !== 'indexes').map(key => ({ key, required: key === 'task' || node.config.strategy === 'agentic_rag' && key === 'indexes' }));
  return [...keys].filter(key => !(node.type === 'memory' && node.config.operation !== 'put' && key === 'value') && !(node.type === 'file_output' && key !== (node.config.format === 'copy' ? 'file' : 'content'))).map((key) => ({ key, required: ((schema.required ?? []) as string[]).includes(key) || node.type === 'error' && key === 'fallback' && node.config.mode === 'recover' || node.type === 'memory' && node.config.operation === 'put' && key === 'value' || node.type === 'file_output' }));
}

/** A value source is always explicit; adding a block never fabricates a result or silently changes a user's graph. */
export function initialBindings(type: NodeType): WorkflowNode['inputBindings'] {
  return type === 'error' ? { error: { from: 'error', pointer: '', onMissing: 'error' } } : type === 'file_input' ? { files: { from: 'literal', value: [] } } : {};
}

const issueMessages: Record<string, string> = {
  INVALID_ENTRY: '입력 또는 시작 질문 블록을 하나만 두고 시작 블록으로 지정하세요.', ENTRY_NOT_FOUND: '시작할 입력 블록을 선택하세요.', INVALID_OUTPUT_COUNT: '최종 결과 블록을 하나만 두세요.',
  INVALID_EDGE: '삭제된 블록으로 향하는 연결을 다시 선택하세요.', INVALID_PORT: '변경된 분류·분기 연결점을 다시 연결하세요.', INVALID_ERROR_ROUTE: '업무 오류 연결은 오류 처리 블록으로 이어 주세요.',
  ENTRY_HAS_PREDECESSOR: '시작 블록으로 들어오는 연결은 제거하세요.', MERGE_REQUIRED: '여러 경로를 받으려면 경로 합류 블록을 사용하세요.', UNCONNECTED_PORT: '다음 작업 연결에서 모든 실행 경로의 도착 블록을 선택하세요.',
  PARALLEL_REQUIRED: '한 연결점에는 다음 작업을 하나만 연결하세요.', INVALID_LABELS: '분류 이름은 중복되거나 예약된 이름(in, next, error, unclassified)일 수 없습니다.',
  INPUT_BINDING_REQUIRED: '입력·결과 탭에서 필수 데이터를 연결하세요.', UNKNOWN_INPUT_BINDING: '이 블록에서 사용하지 않는 입력 이름을 제거하세요.', INPUT_TYPE_MISMATCH: '직접 입력한 값의 형식을 확인하세요.',
  MODEL_PROFILE_NOT_FOUND: '기본 탭에서 선언된 모델 프로필을 선택하세요.', MODEL_PROFILE_KIND_MISMATCH: '이 작업에 맞는 모델 프로필을 선택하세요.', RESOURCE_NOT_FOUND: '자료·도구 탭에서 사용할 자료의 버전을 선택하세요.',
  UNREACHABLE_NODE: '시작 블록에서 이 블록까지 실행 순서를 연결하세요.', CYCLE_DETECTED: '같은 블록으로 돌아가는 연결은 사용할 수 없습니다.',
  INVALID_ERROR_BINDING: '발생한 오류는 오류 처리 블록에서만 참조할 수 있습니다.', BINDING_PATH_NOT_FOUND: '입력·결과에서 선택한 값 위치가 결과 형식에 있는지 확인하세요.', BINDING_NODE_NOT_FOUND: '입력·결과에서 삭제된 결과 블록을 다시 선택하세요.',
  BINDING_NOT_PREDECESSOR: '데이터를 만드는 블록이 이 블록보다 먼저 실행되도록 연결하세요.', BINDING_NOT_AVAILABLE: '실행되지 않을 수 있는 분기의 입력은 값이 없을 때 제외하거나 대체 값을 선택하세요.'
};

/** Human-readable issues retain their machine code and source location for navigation and support. */
export function explainEditorIssue(issue: ValidationIssue, workflow: Workflow): ValidationIssue {
  const location = issueLocation(issue, workflow);
  const node = flowView(workflow, location.flowId).nodes.find(item => item.id === location.nodeId);
  const message = issueMessages[issue.code] ?? issue.message;
  const scoped = location.flowId === 'main' ? '' : `[${location.flowId}] `;
  return { ...issue, nodeId: node?.id ?? issue.nodeId, message: scoped + (node && issueMessages[issue.code] ? `${node.label}: ${message}` : message) };
}
