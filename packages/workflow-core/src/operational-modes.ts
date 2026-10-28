import type { WorkflowNode } from '@studio/spec';
import { CoreOperationError } from './transform/json.js';

/** Display filenames never grant filesystem access; the same rules run in authoring and managed storage. */
export function validateArtifactFilename(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.normalize('NFC') !== value || /[\\/:\x00-\x1f\x7f-\x9f<>"|?*]/u.test(value)
    || /[. ]$/.test(value) || value === '.' || value === '..' || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(value)) throw new CoreOperationError('ARTIFACT_NAME_INVALID', '파일 이름에 경로나 예약된 이름을 사용할 수 없습니다.');
  return value;
}

/** These are implemented modes, not the full future schema: unsupported configuration is never silently downgraded. */
export function validateManagedOutput(config: Extract<WorkflowNode, { type: 'file_output' }>['config']): void {
  validateArtifactFilename(config.filename);
  if (config.outputDirectory !== 'outputs' || config.workerProfile !== undefined) throw new CoreOperationError('FILE_LOCATION_UNSUPPORTED', '현재 파일 저장 위치는 Runner의 관리되는 outputs 폴더만 지원합니다.');
  if (config.format === 'copy') return;
  const extensions: Record<string, readonly string[]> = { text: ['txt'], markdown: ['md', 'markdown'], json: ['json'], csv: ['csv'] };
  const expected = extensions[config.format]; if (!expected) throw new CoreOperationError('FILE_FORMAT_UNSUPPORTED', '이 파일 형식에는 검증된 문서 변환 실행기가 필요합니다.');
  if (!expected.includes(config.filename.split('.').at(-1)!.toLowerCase()) || config.filename.lastIndexOf('.') <= 0) throw new CoreOperationError('FILE_EXTENSION_INVALID', '파일 확장자가 선택한 결과 형식과 다릅니다.');
}

/** Planning and tool execution are separate capabilities from this single-response task agent. */
export function validateTaskAgent(node: Extract<WorkflowNode, { type: 'agent' }>): void {
  if (node.config.strategy !== 'task' || node.config.toolAllowlist.length || node.config.maxSteps !== 1 || node.config.retrievalPolicy !== undefined || Object.hasOwn(node.inputBindings, 'indexes')) throw new CoreOperationError('AGENT_MODE_UNSUPPORTED', '현재 에이전트는 도구·색인 없는 task 전략과 maxSteps=1만 지원합니다.');
  if (node.config.instructions.length > 100000) throw new CoreOperationError('AGENT_CONFIG_LIMIT', '에이전트 지침은 100,000자 이하로 구성하세요.');
}

/** Agentic RAG initially searches pinned run-local keyword indexes and abstains; human clarification requires durable child waits. */
export function validateAgenticRag(node: Extract<WorkflowNode, { type: 'agent' }>): void {
  const policy = node.config.retrievalPolicy;
  if (node.config.strategy !== 'agentic_rag' || !policy || node.config.toolAllowlist.length || node.attachments.length || policy.onInsufficient !== 'abstain' || policy.clarificationFlowRef !== undefined) throw new CoreOperationError('AGENTIC_MODE_UNSUPPORTED', '현재 Agentic RAG는 추가 도구·첨부 없이 키워드 검색 후 근거 부족 시 종료합니다. 추가 질문은 아직 지원하지 않습니다.');
  if (node.config.maxSteps < 3 || node.config.maxSteps > 32 || policy.maxRounds > 4 || policy.maxQueriesPerRound > 3 || policy.maxRetrievedChunks > 100 || policy.maxContextTokens < 20 || policy.maxContextTokens > 12000 || node.config.instructions.length > 16000) throw new CoreOperationError('AGENTIC_LIMIT_UNSUPPORTED', 'Agentic RAG는 3~32단계, 최대4회·회당3질의·100청크·20~12000문맥토큰을 지원합니다.');
  if (Object.keys(node.inputBindings).some(key => !['task', 'context', 'indexes'].includes(key)) || !node.inputBindings.indexes || !node.inputBindings.task) throw new CoreOperationError('AGENTIC_INPUT_REQUIRED', '작업과 현재 실행의 키워드 색인 목록을 연결하세요.');
  if (node.execution.retry.maxAttempts !== 1 || node.execution.onError !== 'fail') throw new CoreOperationError('AGENTIC_RETRY_UNSUPPORTED', '여러 유료 단계가 포함된 Agentic RAG는 자동 재시도·오류 경로 우회를 지원하지 않습니다.');
}

/** A builtin text decoder cannot claim OCR, table extraction, worker execution or language-specific parsing. */
export function validateTextExtraction(node: Extract<WorkflowNode, { type: 'document_extract' }>): void {
  if (node.config.mode !== 'text' || node.config.workerProfile !== undefined || node.config.languages?.length || node.attachments.length) throw new CoreOperationError('DOCUMENT_MODE_UNSUPPORTED', '현재 문서 추출은 별도 실행기 없이 UTF-8 텍스트 원문을 읽는 모드만 지원합니다.');
}

/** Operational run-local modes are explicit; editor authoring support can be narrower than this backend contract. */
export function validateRunRagNode(node: Extract<WorkflowNode, { type: 'knowledge' | 'retrieval' }>): void {
  const fail = (message: string): never => { throw new CoreOperationError('RAG_MODE_UNSUPPORTED', message); };
  if (node.attachments.length) fail('지식·검색 블록에는 현재 실행의 파일 참조를 입력으로 연결하세요.');
  if (node.type === 'retrieval') {
    const hybrid = node.config.mode === 'hybrid';
    if (!['keyword', 'vector', 'hybrid'].includes(node.config.mode) || Object.keys(node.config).some(key => !['mode', 'topK', 'maxContextTokens', ...(hybrid ? ['keywordTopK', 'vectorTopK', 'candidateLimit', 'fusion'] : []), ...(node.config.reranker ? ['reranker', 'candidateLimit'] : [])].includes(key))) fail('현재 실행의 키워드·벡터·RRF 혼합 검색만 지원합니다.');
    if (hybrid && (!node.config.fusion || node.config.fusion.method !== 'rrf' || !node.config.keywordTopK || !node.config.vectorTopK || !node.config.candidateLimit || node.config.topK > node.config.candidateLimit)) fail('혼합 검색에는 두 검색 수·후보 수와 RRF 설정이 필요합니다.');
    // Reranking must see a declared candidate pool before top K; silently ranking an already truncated result changes semantics.
    if (node.config.reranker && (!Number.isSafeInteger(node.config.candidateLimit) || node.config.candidateLimit! < node.config.topK || node.config.candidateLimit! > 20)) fail('재순위 검색은 최종 결과 수 이상, 최대 20개의 후보 수를 명시하세요.');
    if (node.config.maxContextTokens < 20) fail('검색 문맥은 고정 안내문을 포함할 수 있도록 최소 20토큰을 지정하세요.');
    if (Object.keys(node.inputBindings).some(key => !['index', 'query'].includes(key))) fail('키워드 검색에는 색인과 검색어만 연결할 수 있습니다.');
    return;
  }
  if (node.config.operation === 'build') {
    const settings = node.config.indexSettings;
    const vector = settings?.kind === 'vector' || settings?.kind === 'hybrid';
    if (!settings || (vector ? node.config.profile !== 'local-run-embedding-v1' || !settings.embeddingProfile : node.config.profile !== 'local-run-keyword-v1' || settings.kind !== 'keyword') || Object.keys(settings).some(key => !['kind', 'chunkSize', 'chunkOverlap', ...(vector ? ['embeddingProfile'] : [])].includes(key)) || settings.chunkOverlap >= settings.chunkSize || settings.chunkSize < 100 || settings.chunkSize > 20000 || settings.chunkOverlap < 0) fail('현재 실행용 프로필과 UTF-8 청크 설정, 벡터 색인의 임베딩 연결이 필요합니다.');
    if (Object.keys(node.inputBindings).some(key => key !== 'documents')) fail('색인 생성에는 현재 실행의 파일 목록만 연결하세요.');
  } else if (node.config.operation === 'open') {
    if (Object.keys(node.config).some(key => key !== 'operation') || Object.keys(node.inputBindings).some(key => key !== 'index')) fail('색인 열기는 현재 실행에서 만든 고정 색인 참조만 받습니다.');
  } else fail('지식 색인은 현재 실행에서 만들기·열기만 지원합니다.');
}
