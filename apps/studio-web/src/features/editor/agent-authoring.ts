import { FORBIDDEN_KEYS, validateNodeShape, type Workflow, type WorkflowNode } from '@studio/spec';
import { validateAgenticRag, validateTaskAgent } from '@studio/workflow-core';

export type AgentNode = Extract<WorkflowNode, { type: 'agent' }>;
export type AgentStrategy = AgentNode['config']['strategy'];

/** Browser-safe authoring limits mirror the fixed Runner contract; contract tests detect drift without an app-to-app import. */
export const AGENTIC_AUTHORING = Object.freeze({
  contractId: 'openai-agentic-keyword-abstain-v1', model: 'gpt-5.4-mini-2026-03-17',
  maxIndexes: 4, maxTaskCharacters: 16000, maxExtraContextBytes: 16384,
  maxSteps: 32, maxRounds: 4, maxQueriesPerRound: 3, maxRetrievedChunks: 100, maxContextTokens: 12000,
});
export const AGENTIC_DEFAULTS = Object.freeze({ maxSteps: 12, maxRounds: 3, maxQueriesPerRound: 2, maxRetrievedChunks: 30, maxContextTokens: 3000 });

function currentAgent(workflow: Workflow, nodeId: string): AgentNode {
  const node = workflow.nodes.find(item => item.id === nodeId);
  if (!node || node.type !== 'agent') throw new Error('현재 흐름의 에이전트 블록을 선택하세요.');
  return node;
}

/** Reuse the generated schema before stricter operational checks; empty/decimal/unknown options never become silently clamped values. */
function assertShape(node: AgentNode): void {
  const checked = validateNodeShape(node);
  if (!checked.valid) throw new Error(`에이전트 설정 형식을 확인하세요. ${checked.issues.map(issue => issue.message).join(' ')}`);
}

/** Only statically known input values are checked here. This never asserts that a supplied IndexRef is owned or active. */
export function validateAuthoredAgent(node: AgentNode, workflow?: Workflow): void {
  assertShape(node);
  if (node.config.strategy === 'task') validateTaskAgent(node);
  else {
    validateAgenticRag(node);
    const task = node.inputBindings.task;
    if (task?.from === 'literal' && (typeof task.value !== 'string' || !task.value.trim() || task.value.length > AGENTIC_AUTHORING.maxTaskCharacters)) throw new Error('에이전트가 할 일은 비어 있지 않은 16,000자 이하의 문자열이어야 합니다.');
    const context = node.inputBindings.context;
    if (context?.from === 'literal' && new TextEncoder().encode(JSON.stringify(context.value)).byteLength > AGENTIC_AUTHORING.maxExtraContextBytes) throw new Error('직접 입력한 참고 내용은 JSON으로 표현한 UTF-8 크기가 16 KiB 이하여야 합니다.');
    const indexes = node.inputBindings.indexes;
    if (indexes?.from === 'literal' && (!Array.isArray(indexes.value) || indexes.value.length < 1 || indexes.value.length > AGENTIC_AUTHORING.maxIndexes)) throw new Error('검색용 색인 목록은 현재 실행의 서로 다른 키워드 색인 1~4개를 담은 배열이어야 합니다.');
  }
  if (workflow && (!Object.hasOwn(workflow.modelProfiles, node.config.modelProfile) || workflow.modelProfiles[node.config.modelProfile]?.kind !== 'chat')) throw new Error('선언된 대화(chat) 모델 프로필을 선택하세요. 임베딩·재정렬 프로필은 사용할 수 없습니다.');
}

/** Explicit strategy edits are one history patch. Imported settings, long text, attachments and error routes are not discarded to make a mode appear ready. */
export function changeAgentStrategy(workflow: Workflow, nodeId: string, strategy: AgentStrategy, options: { discardSearchSettings?: true } = {}): Partial<Workflow> {
  const node = currentAgent(workflow, nodeId);
  if (!['task', 'agentic_rag'].includes(strategy)) throw new Error('지원하는 에이전트 실행 방식을 선택하세요.');
  if (node.config.strategy === strategy) return {};
  assertShape(node);
  let changed: AgentNode;
  if (strategy === 'agentic_rag') {
    validateTaskAgent(node);
    if (node.attachments.length) throw new Error('검색 모드는 직접 자료 첨부를 지원하지 않습니다. 자료·도구 탭에서 연결을 먼저 해제하세요.');
    if (node.config.instructions.length > AGENTIC_AUTHORING.maxTaskCharacters) throw new Error('검색 모드의 지침은 16,000자 이하여야 합니다. 기존 지침을 직접 정리한 뒤 전환하세요.');
    if (node.execution.retry.maxAttempts !== 1 || node.execution.onError !== 'fail' || workflow.edges.some(edge => edge.from.nodeId === node.id && edge.from.port === 'error')) throw new Error('검색 모드는 자동 재시도와 오류 경로를 지원하지 않습니다. 기존 실행 설정·오류 연결을 먼저 정리하세요.');
    if (Object.keys(node.inputBindings).some(key => !['task', 'context'].includes(key))) throw new Error('기존 에이전트 입력을 확인하세요. 지원하지 않는 입력을 자동으로 지우지 않습니다.');
    changed = { ...node, config: { ...node.config, strategy, maxSteps: AGENTIC_DEFAULTS.maxSteps, retrievalPolicy: { maxRounds: AGENTIC_DEFAULTS.maxRounds, maxQueriesPerRound: AGENTIC_DEFAULTS.maxQueriesPerRound, maxRetrievedChunks: AGENTIC_DEFAULTS.maxRetrievedChunks, maxContextTokens: AGENTIC_DEFAULTS.maxContextTokens, onInsufficient: 'abstain' } } };
  } else {
    if (options.discardSearchSettings !== true && (node.config.retrievalPolicy || Object.hasOwn(node.inputBindings, 'indexes'))) throw new Error('단일 작업으로 바꾸면 검색 설정과 색인 입력이 제거됩니다. 제거 범위를 확인하고 전환하세요.');
    const { retrievalPolicy: _removedPolicy, ...config } = node.config;
    const { indexes: _removedIndexes, ...inputBindings } = node.inputBindings;
    changed = { ...node, config: { ...config, strategy, maxSteps: 1 }, inputBindings };
    // Tool configuration is unrelated to the confirmed search removal and cannot be hidden by the transition.
    validateTaskAgent(changed);
  }
  return { nodes: workflow.nodes.map(item => item === node ? changed : item) as Workflow['nodes'] };
}

/** Profile identifiers are implementation aliases; existing profiles of every kind reserve their names. */
export function nextAgenticAlias(workflow: Workflow): string {
  if (!Object.hasOwn(workflow.modelProfiles, 'agentic_default')) return 'agentic_default';
  let suffix = 2;
  while (Object.hasOwn(workflow.modelProfiles, `agentic_${suffix}`)) suffix++;
  return `agentic_${suffix}`;
}

/** Declaration and reference commit atomically through the caller's scoped draft history. No credentials or model account are created. */
export function addAgenticDeclaration(workflow: Workflow, nodeId: string, alias: string): Partial<Workflow> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(alias) || FORBIDDEN_KEYS.has(alias)) throw new Error('프로필 식별자는 영문·숫자로 시작하는 영문·숫자·밑줄·하이픈 1~64자로 입력하세요.');
  if (Object.hasOwn(workflow.modelProfiles, alias)) throw new Error('이미 있는 프로필 이름입니다. 기존 대화 프로필을 선택하거나 다른 이름을 입력하세요.');
  const node = currentAgent(workflow, nodeId);
  if (node.config.strategy !== 'agentic_rag') throw new Error('키워드 검색 에이전트 모드를 먼저 선택하세요.');
  return {
    modelProfiles: { ...workflow.modelProfiles, [alias]: { kind: 'chat', requiredFeatures: ['json_schema'] } },
    nodes: workflow.nodes.map(item => item === node ? { ...node, config: { ...node.config, modelProfile: alias } } : item) as Workflow['nodes'],
  };
}
