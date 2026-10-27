import type { Workflow, WorkflowNode } from './generated/types.generated.js';
import { schemaBundle } from './generated/schema-bundle.generated.js';

export type NodeType = WorkflowNode['type'];
export const BASIC_CAPABILITIES = ['node.input@1', 'node.ai@1', 'node.output@1'] as const;

/** Definitions describe contracts, not installed handlers; only BASIC_CAPABILITIES are executable in P2. */
export interface NodeDefinition {
  type: NodeType;
  typeVersion: 1;
  title: string;
  description: string;
  category: string;
  configSchema: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  controlPorts: { inputs: string[]; outputs: string[] };
  requiredCapabilities: string[];
  handlerId: string;
  availableInP2: boolean;
  uiDefinition: { tabs: readonly ['basic', 'resources', 'bindings'] };
}

const metadata: readonly [NodeType, string, string, string][] = [
  ['input', '입력', '실행에 필요한 입력을 받습니다.', '입력·결과'],
  ['form', '사용자에게 질문', '필요한 내용을 사용자에게 확인합니다.', '입력·결과'],
  ['trigger', '예약 시작', '설정한 일정에 작업을 시작합니다.', '입력·결과'],
  ['ai', 'AI 작업', '지침에 따라 입력을 처리합니다.', 'AI 작업'],
  ['agent', '에이전트', '허용된 도구로 목표를 수행합니다.', 'AI 작업'],
  ['classify', '분류', '내용을 분류해 다음 경로를 선택합니다.', '흐름 제어'],
  ['output', '결과', '완성된 결과를 전달합니다.', '입력·결과'],
  ['tool', '도구 실행', '연결된 서비스의 도구를 사용합니다.', '도구·자료'],
  ['retrieval', '자료 검색', '색인에서 근거를 찾습니다.', '지식·검색'],
  ['knowledge', '지식 색인', '문서를 검색 가능한 지식으로 구성합니다.', '지식·검색'],
  ['resource', '자료 읽기', '고정한 버전의 자료를 읽습니다.', '도구·자료'],
  ['skill', 'Skill 활용', '지침 묶음 또는 지정된 작업을 활용합니다.', '도구·자료'],
  ['memory', '기억', '허용된 범위에서 정보를 저장하거나 읽습니다.', '지식·검색'],
  ['compensate', '변경 보상', '확인된 외부 변경에 보상 작업을 수행합니다.', '안전·검토'],
  ['transform', '데이터 변환', '정해진 연산으로 데이터를 바꿉니다.', '데이터·파일'],
  ['program', '프로그램', '격리된 환경에서 고정 코드를 실행합니다.', '데이터·파일'],
  ['candidate_search', '후보 탐색', '등록된 검증기로 후보를 비교합니다.', 'AI 작업'],
  ['merge', '경로 합류', '활성 경로의 결과를 합칩니다.', '흐름 제어'],
  ['condition', '조건', '조건에 따라 다음 경로를 선택합니다.', '흐름 제어'],
  ['guardrail', '보호 검사', '규칙을 위반한 실행을 차단합니다.', '안전·검토'],
  ['evaluate', '결과 평가', '기준에 따라 결과를 평가합니다.', '안전·검토'],
  ['error', '오류 처리', '복구 가능한 업무 오류를 처리합니다.', '안전·검토'],
  ['review', '사용자 검토', '결과를 사용자가 검토합니다.', '안전·검토'],
  ['file_input', '파일 입력', '허용된 파일을 작업에 전달합니다.', '데이터·파일'],
  ['document_extract', '문서 추출', '문서의 텍스트·표·위치를 추출합니다.', '데이터·파일'],
  ['file_output', '파일 만들기', '결과를 실제 파일로 만듭니다.', '데이터·파일'],
  ['parallel', '병렬 작업', '하위 작업을 제한된 동시성으로 실행합니다.', '협업·반복'],
  ['agent_team', '에이전트 팀', '역할을 나눠 작업합니다.', '협업·반복'],
  ['orchestrator', '작업 조율', '허용된 작업으로 계획하고 실행을 조율합니다.', '협업·반복'],
  ['subworkflow', '하위 워크플로', '고정한 하위 흐름을 호출합니다.', '협업·반복'],
  ['loop', '반복', '정해진 상한 안에서 작업을 반복합니다.', '협업·반복'],
];

const jsonData = {};
const inputContracts: Record<NodeType, { fields: Record<string, unknown>; required: string[] }> = {
  input: { fields: {}, required: [] }, form: { fields: { context: jsonData, initialValues: jsonData }, required: [] }, trigger: { fields: {}, required: [] },
  ai: { fields: { content: jsonData, context: jsonData }, required: ['content'] }, agent: { fields: { task: { type: 'string' }, context: jsonData, indexes: { type: 'array' } }, required: ['task'] },
  classify: { fields: { content: jsonData }, required: ['content'] }, output: { fields: { result: jsonData }, required: ['result'] }, tool: { fields: { arguments: { type: 'object' } }, required: ['arguments'] },
  retrieval: { fields: { query: { type: 'string' }, index: jsonData, filters: { type: 'object' } }, required: ['query'] }, knowledge: { fields: { documents: { type: 'array' }, index: jsonData }, required: [] },
  resource: { fields: {}, required: [] }, skill: { fields: { arguments: jsonData }, required: [] }, memory: { fields: { key: { type: 'string' }, value: jsonData }, required: ['key'] },
  compensate: { fields: { effect: jsonData }, required: ['effect'] }, transform: { fields: { value: jsonData }, required: ['value'] }, program: { fields: { arguments: jsonData }, required: ['arguments'] },
  candidate_search: { fields: { goal: jsonData, initialCandidates: { type: 'array' } }, required: ['goal'] }, merge: { fields: {}, required: [] }, condition: { fields: { value: jsonData }, required: ['value'] },
  guardrail: { fields: { value: jsonData }, required: ['value'] }, evaluate: { fields: { value: jsonData, criteria: jsonData }, required: ['value'] }, error: { fields: { error: jsonData, fallback: jsonData }, required: ['error'] },
  review: { fields: { value: jsonData, context: jsonData }, required: ['value'] }, file_input: { fields: { files: { type: 'array' } }, required: ['files'] }, document_extract: { fields: { file: jsonData }, required: ['file'] },
  file_output: { fields: { content: jsonData, file: jsonData }, required: [] }, parallel: { fields: { branches: { type: 'object' }, context: jsonData }, required: ['branches'] },
  agent_team: { fields: { task: jsonData, context: jsonData }, required: ['task'] }, orchestrator: { fields: { goal: jsonData, constraints: jsonData }, required: ['goal'] },
  subworkflow: { fields: { input: jsonData }, required: ['input'] }, loop: { fields: { items: { type: 'array' }, state: jsonData, context: jsonData }, required: [] },
};

const defaults: Record<NodeType, Record<string, unknown>> = {
  input: {}, form: { mode: 'initial', title: '필요한 내용을 입력해 주세요' }, trigger: { kind: 'schedule', cron: '0 9 * * 1-5', timeZone: 'Asia/Seoul', misfire: 'skip', overlap: 'skip' },
  ai: { modelProfile: 'text-default', instructions: '입력 내용을 처리하세요. 입력에 없는 사실을 만들지 마세요.', responseFormat: { mode: 'text' }, maxOutputTokens: 1024 },
  agent: { modelProfile: 'text-default', instructions: '허용된 도구와 근거를 사용해 요청을 처리하세요.', toolAllowlist: [], maxSteps: 8, resultSchema: true, strategy: 'task' },
  classify: { modelProfile: 'text-default', labels: [{ id: 'general', description: '일반 항목' }], onUncertain: 'unclassified' }, output: { format: 'text' },
  tool: { tool: { kind: 'builtin', id: 'knowledge.search', version: 1 } }, retrieval: { mode: 'keyword', topK: 5, maxContextTokens: 6000 }, knowledge: { operation: 'open' },
  resource: { resource: 'pending-resource' }, skill: { resource: 'pending-skill', mode: 'instructions' }, memory: { operation: 'get', scope: 'run' }, compensate: { method: 'pending-compensation' },
  transform: { steps: [{ op: 'pick', options: { keys: [] } }], resultSchema: true }, program: { codeRef: { resource: 'pending-skill', path: 'scripts/main.py' }, workerProfile: 'python-isolated', resultSchema: true },
  candidate_search: { mode: 'tree', generatorFlowRef: { kind: 'local', flowId: 'pending-flow' }, verifierId: 'pending-verifier', maxCandidates: 10, maxDepth: 3, maxVerifications: 10 },
  merge: { waitFor: 'all_active', combine: 'object', collision: 'error' }, condition: { expression: { literal: true } }, guardrail: { rules: [{ id: 'content', kind: 'length', parameters: { min: 1 } }], onViolation: 'block' },
  evaluate: { mode: 'rules', resultSchema: true, passRule: { literal: true }, rules: [{ id: 'defined', expression: { op: 'exists', args: [{ var: '' }] } }] },
  error: { mode: 'rethrow' }, review: { question: '결과를 검토해 주세요', responseSchema: { type: 'object', properties: { feedback: { type: 'string' } }, additionalProperties: false } },
  file_input: { mimeTypes: ['text/plain', 'application/pdf'], maxFiles: 10, maxBytesPerFile: 10485760 }, document_extract: { mode: 'text' }, file_output: { format: 'text', filename: 'result.txt', outputDirectory: 'outputs' },
  parallel: { branches: [{ id: 'first', flowRef: { kind: 'local', flowId: 'pending-flow' } }], mode: 'all', maxConcurrency: 4, failurePolicy: 'fail_fast' },
  agent_team: { members: [{ id: 'worker', role: '작업 담당자', flowRef: { kind: 'local', flowId: 'pending-flow' } }], mode: 'sequential', maxConcurrency: 1 },
  orchestrator: { mode: 'plan', allowedFlows: [{ kind: 'local', flowId: 'pending-flow' }], modelProfile: 'text-default', maxReplans: 3, maxTasks: 20 },
  subworkflow: { flowRef: { kind: 'local', flowId: 'pending-flow' } }, loop: { mode: 'foreach', bodyFlowRef: { kind: 'local', flowId: 'pending-flow' }, maxIterations: 10 },
};

/** Palette metadata is shared; consumers must still compare required capabilities with the target Runner. */
export const NODE_DEFINITIONS: readonly NodeDefinition[] = metadata.map(([type, title, description, category]) => {
  const schema = (schemaBundle.$defs as Record<string, { properties: { config: Record<string, unknown> } }>)[`nodes_${type}_v1`]!;
  const input = inputContracts[type];
  return {
    type, typeVersion: 1, title, description, category, configSchema: schema.properties.config,
    inputSchema: { type: 'object', properties: input.fields, required: input.required, additionalProperties: type === 'merge' },
    outputSchema: { type: 'object', properties: { data: {}, text: { type: 'string' }, files: { type: 'array' }, sources: { type: 'array' }, effects: { type: 'array' } }, required: ['data'], additionalProperties: false },
    controlPorts: { inputs: type === 'input' || type === 'trigger' ? [] : ['in'], outputs: type === 'output' ? [] : type === 'condition' ? ['true', 'false'] : type === 'review' ? ['accepted', 'rejected'] : type === 'classify' ? ['unclassified'] : ['next'] },
    requiredCapabilities: [`node.${type}@1`], handlerId: `studio.${type}.v1`, availableInP2: ['input', 'ai', 'output'].includes(type), uiDefinition: { tabs: ['basic', 'resources', 'bindings'] },
  };
});

export function getNodeDefinition(type: string, typeVersion = 1): NodeDefinition | undefined {
  return NODE_DEFINITIONS.find(definition => definition.type === type && definition.typeVersion === typeVersion);
}

/** New nodes explicitly carry defaults; imports are never silently repaired by this helper. */
export function createNode(type: NodeType): WorkflowNode {
  const definition = getNodeDefinition(type);
  if (!definition) throw new Error(`Unknown node type: ${type}`);
  return {
    id: `n_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`, type, typeVersion: 1,
    label: definition.title, inputBindings: {}, config: structuredClone(defaults[type]), attachments: [],
    execution: { timeoutMs: 60000, retry: { maxAttempts: 1, backoffMs: 1000, retryOn: [] }, onError: 'fail' },
  } as WorkflowNode;
}

/** A usable starter is a real three-node workflow; no result or model response is pre-filled. */
export function createBasicWorkflow(name = '새 워크플로'): Workflow {
  const input = createNode('input'); input.id = 'start'; input.label = '작업할 내용';
  const ai = createNode('ai'); ai.id = 'work'; ai.label = 'AI 작업';
  ai.inputBindings = { content: { from: 'node', nodeId: input.id, pointer: '/data/text', onMissing: 'error' } };
  const output = createNode('output'); output.id = 'finish'; output.label = '결과';
  output.inputBindings = { result: { from: 'node', nodeId: ai.id, pointer: '/data', onMissing: 'error' } };
  return {
    schemaVersion: '1.0.0', id: `wf_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`, revision: 1, name, entryNodeId: input.id,
    inputs: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 20000 } }, required: ['text'], additionalProperties: false },
    outputs: { type: 'string', minLength: 1 }, modelProfiles: { 'text-default': { kind: 'chat', requiredFeatures: ['text'] } }, resources: {}, subworkflows: {},
    nodes: [input, ai, output], edges: [
      { id: 'start_to_work', from: { nodeId: input.id, port: 'next' }, to: { nodeId: ai.id, port: 'in' } },
      { id: 'work_to_finish', from: { nodeId: ai.id, port: 'next' }, to: { nodeId: output.id, port: 'in' } },
    ],
    policy: { approvalMode: 'per_effect', networkMode: 'broker_only', filesystemMode: 'workspace_only', limits: { maxConcurrentNodes: 4, maxNodeInstances: 1000, maxModelCalls: 100, maxTotalTokens: 200000, maxActiveMs: 1800000, maxChildDepth: 8 } },
  } as Workflow;
}
