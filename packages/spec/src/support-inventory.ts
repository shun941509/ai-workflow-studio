import type { NodeType } from './registry.js';

/** Documentation and authoring visibility only. These records never register handlers, authorize tools,
 * validate configuration, or prove that a user's installed Runner/model/account is ready. */
export interface SupportMode {
  readonly id: string;
  readonly label: string;
  readonly editor: boolean;
  readonly capabilities: readonly string[];
  readonly prerequisites: readonly string[];
}
export interface NodeSupport {
  readonly editorOrder: number | null;
  readonly modes: readonly SupportMode[];
  readonly constraints: readonly string[];
  readonly unavailable: readonly string[];
}

// Records intentionally contain no functions, schema defaults, model responses, secret values or executable paths.
// A mode means the default Runner contains an implementation, not that every schema-valid configuration runs.
const inventory = {
  input: { editorOrder: 0, modes: [{ id: 'workflow-input', label: '실행 입력 받기', editor: true, capabilities: [], prerequisites: ['실행 입력 스키마'] }], constraints: ['흐름의 시작 입력이며 외부 이벤트를 구독하지 않습니다.'], unavailable: [] },
  form: { editorOrder: 1, modes: [
    { id: 'initial', label: '실행 전 질문', editor: true, capabilities: [], prerequisites: ['입력 항목'] },
    { id: 'request', label: '실행 중 사용자 응답 대기', editor: true, capabilities: [], prerequisites: ['기본 흐름', 'Runner 사용자 화면'] },
  ], constraints: ['하위 흐름의 응답 대기는 지원하지 않습니다.', '사용자 응답은 보안 승인을 대신하지 않습니다.'], unavailable: ['하위 흐름 안의 질문 대기'] },
  trigger: { editorOrder: null, modes: [], constraints: ['일정·시간대 규격만 있으며 운영 예약 실행기는 없습니다.'], unavailable: ['예약 실행', '외부 이벤트 자동 시작'] },
  ai: { editorOrder: 2, modes: [
    { id: 'text', label: '문자열 응답', editor: true, capabilities: [], prerequisites: ['chat 모델 연결'] },
    { id: 'json', label: '결과 스키마에 맞는 JSON 응답', editor: true, capabilities: [], prerequisites: ['JSON 응답 모델 연결'] },
  ], constraints: ['한 번의 모델 요청이며 도구를 호출하지 않습니다.', '자료 첨부의 원문·권한·크기를 별도로 확인합니다.'], unavailable: ['자동 도구 사용', '임의 재계획'] },
  agent: { editorOrder: 3, modes: [
    { id: 'task', label: '단일 작업', editor: true, capabilities: ['agent.task@1', 'agent.single_step@1'], prerequisites: ['JSON 응답 chat 모델 연결'] },
    { id: 'agentic_rag.keyword.abstain', label: '키워드 재검색·근거 부족 시 답변 유보', editor: true, capabilities: ['agent.agentic_rag@1', 'agentic_rag.keyword@1', 'agentic_rag.abstain@1'], prerequisites: ['현재 실행의 키워드 색인 1~4개', '고정 Agentic chat 모델 연결', '검색 문맥 토크나이저'] },
  ], constraints: ['task는 도구·색인 없이 maxSteps=1입니다.', 'Agentic은 최대 32단계·4라운드·회당 3질의·100청크·12000 문맥 토큰이며 직접 자료 첨부를 받지 않습니다.', '유보·충돌이면 답변은 null이며 인용이 정답 품질을 보증하지 않습니다.'], unavailable: ['추가 질문', '외부 도구', 'Agentic 벡터·혼합·재순위·Graph 검색', '실행 그래프 자동 재구성'] },
  classify: { editorOrder: 4, modes: [{ id: 'model-labels', label: '모델 기반 라벨 분류', editor: true, capabilities: [], prerequisites: ['JSON 응답 chat 모델 연결', '명시적 분류 경로'] }], constraints: ['라벨은 최대 100개이며 불확실 응답 경로를 명시합니다.'], unavailable: [] },
  output: { editorOrder: 5, modes: [
    { id: 'text', label: '문자열 최종 결과', editor: true, capabilities: [], prerequisites: ['최종 결과 스키마'] },
    { id: 'json', label: 'JSON 최종 결과', editor: true, capabilities: [], prerequisites: ['최종 결과 스키마'] },
    { id: 'files', label: '기존 결과값 전달·파일 생성 없음', editor: false, capabilities: [], prerequisites: ['선행 작업의 실제 결과', '최종 결과 스키마'] },
  ], constraints: ['결과값을 최종 스키마로 검사합니다. 파일 생성과 다운로드 대상 등록은 file_output에서 수행합니다.'], unavailable: ['최종 결과 블록 안의 파일 생성·변환'] },
  tool: { editorOrder: null, modes: [
    { id: 'file.inspect', label: '현재 실행 파일의 메타데이터·무결성 확인', editor: false, capabilities: ['tool.builtin.file.inspect@1'], prerequisites: ['현재 실행에 등록된 관리 FileRef'] },
    { id: 'document.read_utf8', label: '현재 실행 파일의 UTF-8 원문 읽기', editor: false, capabilities: ['tool.builtin.document.read_utf8@1'], prerequisites: ['현재 실행에 등록된 텍스트 FileRef'] },
  ], constraints: ['등록된 builtin 읽기 도구 두 종류만 사용하며 외부 변경 효과를 만들지 않습니다.'], unavailable: ['외부 MCP 호출', '쓰기 도구', '임의 도구 설치·실행'] },
  retrieval: { editorOrder: 19, modes: [
    { id: 'keyword', label: '키워드 검색', editor: true, capabilities: ['retrieval.keyword@1'], prerequisites: ['현재 실행의 키워드 색인', '검색 문맥 토크나이저'] },
    { id: 'vector', label: '벡터 검색', editor: true, capabilities: ['retrieval.vector@1'], prerequisites: ['현재 실행의 벡터 색인', '고정 임베딩 연결', '검색 문맥 토크나이저'] },
    { id: 'hybrid', label: '키워드·벡터 RRF 혼합 검색', editor: true, capabilities: ['retrieval.hybrid@1'], prerequisites: ['현재 실행의 혼합 색인', '고정 임베딩 연결', '검색 문맥 토크나이저'] },
    { id: 'rerank', label: '검색 후보의 선택적 재순위', editor: true, capabilities: ['retrieval.rerank@1', 'reranker.openai_responses_v1@1'], prerequisites: ['선행 키워드·벡터·혼합 검색', '고정 reranker 연결'] },
  ], constraints: ['재순위는 독립 검색 전략이 아니라 검색 후보 최대 20개에 적용하는 옵션입니다.', '원문 인용·권한·세대는 검사하지만 검색 품질은 별도 평가 대상입니다.'], unavailable: ['GraphRAG local/global', '사용자 메타데이터 필터', '외부 벡터 데이터베이스 검색'] },
  knowledge: { editorOrder: 18, modes: [
    { id: 'open', label: '현재 실행의 고정 색인 열기', editor: true, capabilities: ['knowledge.open@1'], prerequisites: ['현재 실행의 IndexRef'] },
    { id: 'build.keyword', label: '키워드 색인 만들기', editor: true, capabilities: ['knowledge.build@1', 'knowledge.keyword@1', 'rag.run_local@1'], prerequisites: ['현재 실행의 UTF-8 문서 파일'] },
    { id: 'build.vector', label: '벡터 색인 만들기', editor: true, capabilities: ['knowledge.build@1', 'knowledge.vector@1', 'embedding.openai_small_256@1', 'rag.run_local@1'], prerequisites: ['현재 실행의 UTF-8 문서 파일', '고정 임베딩 연결'] },
    { id: 'build.hybrid', label: '키워드·벡터 혼합 색인 만들기', editor: true, capabilities: ['knowledge.build@1', 'knowledge.hybrid@1', 'embedding.openai_small_256@1', 'rag.run_local@1'], prerequisites: ['현재 실행의 UTF-8 문서 파일', '고정 임베딩 연결'] },
  ], constraints: ['색인 한 번에 파일 최대 32개·합계 8 MiB이며 고정 세대와 현재 권한을 확인합니다.'], unavailable: ['Graph 색인', '외부 DB 색인', '공유 조직 저장소의 실제 권한 연동', '색인 갱신·삭제 모드'] },
  resource: { editorOrder: 6, modes: [{ id: 'pinned-read', label: '고정 자료 읽기', editor: true, capabilities: [], prerequisites: ['검증된 자료 원본과 참조'] }], constraints: ['Runner는 텍스트·JSON 또는 Skill 지침 bundle을 읽습니다.', '실행 자료는 파일당 256 KiB·총 1 MiB이며 연결·전이 의존이 있으면 준비 검사에서 차단합니다.', '편집기의 자료 읽기 선택은 작업 지침과 문서에 한정됩니다.'], unavailable: ['MCP 연결 실행', '종속·외부 연결 자료의 Runner 소비'] },
  skill: { editorOrder: null, modes: [{ id: 'instructions', label: 'Skill 지침·참고자료 bundle 읽기', editor: false, capabilities: ['skill.instructions@1'], prerequisites: ['고정 SKILL.md와 자료 원본'] }], constraints: ['references/assets의 텍스트와 이진 메타데이터를 구분하며 scripts를 실행하지 않습니다.', '기존 AI의 명시적 Skill 첨부 지원은 새 Skill 편집 폼 제공을 뜻하지 않습니다.'], unavailable: ['execute 모드', '코드·스크립트 실행'] },
  memory: { editorOrder: 17, modes: [
    { id: 'run.get', label: '실행 기억 읽기', editor: true, capabilities: ['memory.run@1'], prerequisites: ['현재 실행의 기억 키'] },
    { id: 'run.put', label: '실행 기억 저장', editor: true, capabilities: ['memory.run@1'], prerequisites: ['기억 키와 저장할 값'] },
    { id: 'run.delete', label: '실행 기억 삭제', editor: true, capabilities: ['memory.run@1'], prerequisites: ['현재 실행의 기억 키'] },
  ], constraints: ['run 범위만 지원하며 put의 TTL은 최대 30일입니다.'], unavailable: ['프로젝트·계정 공용 기억'] },
  compensate: { editorOrder: null, modes: [], constraints: ['확인된 외부 변경과 보상 권한·멱등 실행 경계가 구현되지 않았습니다.'], unavailable: ['외부 변경 보상'] },
  transform: { editorOrder: 7, modes: [{ id: 'bounded-dsl', label: '선언한 데이터 변환 단계', editor: true, capabilities: [], prerequisites: ['허용 연산과 결과 스키마'] }], constraints: ['폐쇄된 변환 DSL만 실행하며 JavaScript 표현식이나 임의 코드를 평가하지 않습니다.'], unavailable: ['임의 코드 변환'] },
  program: { editorOrder: null, modes: [], constraints: ['OS 격리 실증은 운영 Worker 등록·실행 완료가 아닙니다.'], unavailable: ['Python·Node·Wasm 운영 Worker 실행'] },
  candidate_search: { editorOrder: null, modes: [{ id: 'tree.json-schema-v1', label: '제한된 후보 트리 탐색', editor: false, capabilities: ['candidate_search.tree@1', 'verifier.json-schema-v1@1', 'flow.local@1'], prerequisites: ['로컬 생성 하위 흐름', 'json-schema-v1 검증기', '후보·깊이·검증 상한'] }], constraints: ['BFS 첫 스키마 통과 후보를 선택합니다. 의미적 정답 검증이나 모델 평가 점수가 아닙니다.'], unavailable: ['graph 탐색', '임의 검증기', '외부 패키지 생성 흐름'] },
  merge: { editorOrder: 9, modes: [{ id: 'all_active', label: '활성 경로의 결과 합류', editor: true, capabilities: [], prerequisites: ['분기별 명시적인 값 누락 처리'] }], constraints: ['활성 경로만 기다리며 결과를 객체·목록·선택 방식으로 합칩니다. 병렬 실행기는 아닙니다.'], unavailable: [] },
  condition: { editorOrder: 8, modes: [{ id: 'bounded-expression', label: '선언된 조건 분기', editor: true, capabilities: [], prerequisites: ['제한된 조건식', '일치·불일치 경로'] }], constraints: ['참조값을 명시하며 임의 코드를 실행하지 않습니다.'], unavailable: [] },
  guardrail: { editorOrder: 10, modes: [{ id: 'rules', label: '보호 규칙 검사', editor: true, capabilities: [], prerequisites: ['지원하는 규칙 설정'] }], constraints: ['지원 규칙은 공통 검증기로 검사합니다. 권한·예산·보호 차단을 일반 오류 복구로 성공 처리할 수 없습니다.'], unavailable: ['모델이 승인하는 권한 우회'] },
  evaluate: { editorOrder: 11, modes: [
    { id: 'rules', label: '규칙 기반 평가', editor: true, capabilities: ['evaluate.rules@1'], prerequisites: ['한 개 이상의 평가 규칙', '명시적 통과 조건'] },
    { id: 'model', label: '모델 측정과 명시적 통과 조건', editor: false, capabilities: ['evaluate.model@1'], prerequisites: ['JSON 응답 chat 모델 연결', '평가 지침과 통과 조건'] },
  ], constraints: ['모델은 점수·근거를 제안하며 통과 여부는 선언된 조건식이 정합니다. 자동 사실 검증이나 자동 분기를 뜻하지 않습니다.'], unavailable: ['모델 평가 작성 폼'] },
  error: { editorOrder: 12, modes: [
    { id: 'rethrow', label: '확인된 업무 오류로 중단', editor: true, capabilities: [], prerequisites: ['실제 오류 경로와 문맥'] },
    { id: 'recover', label: '명시적 대체 결과로 복구', editor: true, capabilities: [], prerequisites: ['복구 가능한 업무 오류', '대체 결과'] },
  ], constraints: ['권한 거부·취소·한도·결과 불명은 일반 업무 오류로 바꿔 복구하지 않습니다.'], unavailable: [] },
  review: { editorOrder: 13, modes: [{ id: 'user-review', label: '사용자 수락·반려 대기', editor: true, capabilities: [], prerequisites: ['기본 흐름', 'Runner 사용자 화면'] }], constraints: ['업무 검토는 보안 승인이 아닙니다.'], unavailable: ['하위 흐름 안의 검토 대기'] },
  file_input: { editorOrder: 14, modes: [{ id: 'managed-files', label: '현재 실행 파일 선택·전달', editor: true, capabilities: [], prerequisites: ['기본 흐름의 사용자 파일 선택 또는 기존 관리 FileRef'] }], constraints: ['실행당 최대 100개·파일당 16 MiB이며 임의 OS 경로를 받지 않습니다.', '파일 업로드가 PDF/OCR 등 내용 해석 지원을 뜻하지 않습니다.'], unavailable: ['하위 흐름 안의 새 파일 선택 대기', '임의 파일 경로 읽기'] },
  document_extract: { editorOrder: 16, modes: [{ id: 'text.builtin_utf8', label: 'UTF-8 원문과 바이트 위치 읽기', editor: true, capabilities: ['document_extract.text@1', 'document_extract.builtin_utf8@1'], prerequisites: ['현재 실행의 TXT·Markdown·JSON 파일'] }], constraints: ['파일당 최대 2 MiB 원문을 읽으며 JSON/Markdown을 실행하거나 의미 구조로 변환하지 않습니다.'], unavailable: ['PDF·Word 추출', 'OCR', '표 추출', '문서 Worker'] },
  file_output: { editorOrder: 15, modes: [
    { id: 'text', label: '텍스트 파일', editor: true, capabilities: ['file_output.text@1'], prerequisites: ['문자열 내용'] },
    { id: 'markdown', label: 'Markdown 파일', editor: true, capabilities: ['file_output.markdown@1'], prerequisites: ['문자열 내용'] },
    { id: 'json', label: 'JSON 파일', editor: true, capabilities: ['file_output.json@1'], prerequisites: ['JSON 값'] },
    { id: 'csv', label: 'CSV 파일', editor: true, capabilities: ['file_output.csv@1'], prerequisites: ['지원 표 데이터'] },
    { id: 'copy', label: '현재 실행 파일의 원본 복사', editor: true, capabilities: ['file_output.copy@1'], prerequisites: ['현재 실행의 관리 FileRef'] },
  ], constraints: ['Runner가 관리하는 outputs에만 저장하며 확장자·이름·크기·원본 해시를 검사합니다.'], unavailable: ['PDF·DOCX 생성', '임의 OS 경로 저장', '외부 서비스 게시'] },
  parallel: { editorOrder: null, modes: [{ id: 'all', label: '고정 로컬 분기의 제한된 병렬 실행', editor: false, capabilities: ['parallel.all@1', 'flow.local@1'], prerequisites: ['고정 로컬 하위 흐름', '명시적 분기 입력·동시성·실패 정책'] }], constraints: ['자식은 부모 예산·취소를 공유하며 사용자 응답 대기를 지원하지 않습니다.'], unavailable: ['first_match', '외부 패키지 분기'] },
  agent_team: { editorOrder: null, modes: [
    { id: 'sequential', label: '고정 역할의 순차 실행', editor: false, capabilities: ['agent_team.sequential@1', 'flow.local@1'], prerequisites: ['고정 로컬 작업자 흐름'] },
    { id: 'parallel', label: '고정 역할의 병렬 실행', editor: false, capabilities: ['agent_team.parallel@1', 'flow.local@1'], prerequisites: ['고정 로컬 작업자 흐름', '공유 동시성 한도'] },
  ], constraints: ['서로 다른 작업자 최대 32명이며 통합 흐름도 로컬로 고정합니다. 자율 팀 편성이나 역할 간 임의 통신은 아닙니다.'], unavailable: ['동적 팀 구성', '임의 Agent 간 메시지 교환'] },
  orchestrator: { editorOrder: null, modes: [{ id: 'plan', label: '허용 흐름을 사용하는 계획 제안', editor: false, capabilities: ['orchestrator.plan@1', 'flow.local@1'], prerequisites: ['JSON 응답 chat 모델 연결', '허용 로컬 흐름 1~32개'] }], constraints: ['최대 작업 100개·재계획 0회입니다. 입력과 선행 관계를 검사한 계획만 반환하고 제안 작업을 실행하지 않습니다.'], unavailable: ['계획 dispatch', '실행 중 재계획', '외부 패키지 조율'] },
  subworkflow: { editorOrder: 20, modes: [{ id: 'local', label: '프로젝트 안의 고정 하위 흐름 호출', editor: true, capabilities: ['flow.local@1'], prerequisites: ['호출할 로컬 흐름', '명시적 입력·결과 스키마'] }], constraints: ['호출 재귀와 자식 권한 확대를 차단합니다. 사용자 응답·검토·파일 선택은 기본 흐름에서 받습니다.'], unavailable: ['외부 패키지 호출', '하위 흐름의 사용자 대기'] },
  loop: { editorOrder: null, modes: [
    { id: 'foreach', label: '목록 항목마다 고정 흐름 실행', editor: false, capabilities: ['loop.foreach@1', 'flow.local@1'], prerequisites: ['로컬 본문 흐름', '목록과 반복 상한'] },
    { id: 'until', label: '조건·상한까지 고정 흐름 반복', editor: false, capabilities: ['loop.until@1', 'flow.local@1'], prerequisites: ['로컬 본문 흐름', '상태·종료 조건·반복 상한'] },
  ], constraints: ['자식 실행은 부모 예산·취소·깊이 한도를 공유합니다.'], unavailable: ['무제한 반복', '외부 패키지 본문 흐름'] },
} as const satisfies Record<NodeType, NodeSupport>;

/** Deep freezing prevents a UI consumer from changing documentation or another consumer's palette at runtime. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const NODE_SUPPORT_INVENTORY = freeze(inventory);
/** External-account/host execution evidence is independent of source implementation and internal tests. */
export const SUPPORT_INVENTORY_VERIFICATION = freeze({ externalServices: 'unverified', hostExecution: 'unverified' } as const);
export type EditorNodeType = { [Type in NodeType]: typeof inventory[Type]['editorOrder'] extends number ? Type : never }[NodeType];
/** Derive the exact existing palette order; this does not relax editorSupportIssues or runtime validators. */
export const EDITOR_NODE_TYPES: readonly EditorNodeType[] = freeze((Object.keys(inventory) as NodeType[])
  .filter((type): type is EditorNodeType => inventory[type].editorOrder !== null)
  .sort((left, right) => inventory[left].editorOrder - inventory[right].editorOrder));
/** Documentation drift oracle only. RunnerService must continue deriving its advertised capabilities from installed handlers. */
export const DOCUMENTED_RUNNER_CAPABILITIES: readonly string[] = freeze([...new Set(Object.entries(inventory).flatMap(([type, item]) => item.modes.length
  ? [`node.${type}@1`, ...item.modes.flatMap(mode => [...mode.capabilities])] : []))].sort());
