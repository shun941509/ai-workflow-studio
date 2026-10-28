import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createBasicWorkflow, validateJsonValue, validateWorkflowShape, type UserSchema, type Workflow } from '@studio/spec';
import { analyzeWorkflow, collectRequirements } from '@studio/workflow-core';
import { buildPackage, inspectPackage } from '@studio/package-kit';
import { array, edge, encode, from, input, jsonBytes, license, literal, loadCatalog, merge, node, object, projectAssets, repository, text } from './project-authoring.js';
import { artifactDigest, checkCatalog, digestBytes } from './check.js';
import type { OfficialExample } from './contracts.generated.js';

/** Authors one original two-policy task, not renamed copies. It never calls a model or creates release evidence. */
const id = 'EP-106', catalog = await loadCatalog(), entry = catalog.entries.find(value => value.id === id)!;
if (entry.state !== 'planned' || entry.artifact) throw new Error(`${id}: refusing to overwrite authored content.`);
const folder = resolve(repository, 'catalog/official/projects', id);
try { await access(folder); throw new Error(`${id}: directory already exists.`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

const delivery = `# 가상 구름서가 — 일반 지역 배송 정책\n\n문서 ID: CLOUD-DELIVERY-1\n문서범위: 일반 지역 배송 일정과 확인 사항\n자료 성격: AI Workflow Studio가 직접 작성한 원작 가상 연습문서입니다. 실제 상점·주문·택배·고객 정책이 아닙니다.\n\n## D1 일정\n배송 기간은 결제가 확정된 다음 영업일부터 2~4영업일입니다. 영업일은 월요일부터 금요일이며 공휴일은 포함하지 않습니다. 결제 당일을 첫 배송일로 세지 않습니다. 이 범위는 일반 지역과 재고가 있는 상품에만 적용합니다.\n\n## D2 확인 사항\n주문 상세에 표시된 결제 확정일, 일반 지역 여부, 재고 상태를 확인합니다. 예약 상품과 별도 일정 상품은 이 문서의 기간을 적용할 수 없습니다. 주문 상세를 확인하지 못했다면 특정 도착 날짜를 약속하지 않습니다.\n\n## D3 미기재 사항\n이 문서는 배송비 금액, 실시간 운송 상태, 특정 주문의 도착일, 분실 보상을 정의하지 않습니다. 해당 정보는 미기재로 남기며 검색 결과가 있다는 이유로 금액이나 날짜를 만들어내지 않습니다. 실제 조회·발송·계정 변경은 이 연습에 포함하지 않습니다.\n`;
const returns = `# 가상 구름서가 — 미사용 상품 반품 정책\n\n문서 ID: CLOUD-RETURN-1\n문서범위: 미사용 상품 반품 접수 조건과 절차\n자료 성격: AI Workflow Studio가 직접 작성한 원작 가상 연습문서입니다. 실제 상점·주문·결제·고객 정책이 아닙니다.\n\n## R1 접수 조건\n반품 접수는 수령일부터 14일 이내에 가능합니다. 미사용 상품이고 원래 포장과 구성품이 보존되어 있어야 합니다. 날짜 조건만 맞는다고 사용한 상품이 자동 승인되는 것은 아닙니다.\n\n## R2 접수 절차\n주문 식별번호, 수령일, 미사용 여부, 포장·구성품 보존 여부를 정리한 요청 초안을 만듭니다. 접수한 요청의 상태가 확인될 때까지 승인 완료나 환급 완료라고 표시하지 않습니다. 이 예제는 요청 초안을 실제 전송하지 않습니다.\n\n## R3 미기재 사항\n반품 비용 금액, 환급 완료까지의 일수, 실제 접수 주소, 파손 상품의 예외 처리는 이 문서에 없습니다. 원문에 없는 비용·연락처·예외를 일반 상식으로 채우지 않습니다. 판단에 필요한 사실이 부족하면 답변을 유보합니다.\n`;
const sample = { question: '가상 구름서가의 일반 지역 배송 소요 기간과 미사용 상품 반품 접수 조건을 각각 설명하고 함께 정리해 주세요.' };
const inputs = object({ question: { type: 'string', minLength: 1, maxLength: 3000, title: '배송과 반품에 관한 복합 질문' } });
// Two explicitly named answer parts prevent a structurally incomplete one-part answer. Semantic coverage still needs real-model review.
const part = object({ subquestion: { type: 'string', minLength: 1, maxLength: 1000 }, answer: text });
const resultSchema = object({ delivery: part, returns: part, integratedAnswer: text, limitations: array(text, 0, 6), externalActions: { const: 'none' } });
const agentResult: UserSchema = { type: 'object', required: ['status', 'result', 'citations', 'stopReason', 'usage'], properties: { status: { enum: ['answered', 'insufficient_evidence', 'conflicting_evidence'] }, result: true, citations: { type: 'array' }, stopReason: text, usage: { type: 'object' } }, additionalProperties: false, allOf: [{ if: { properties: { status: { const: 'answered' } } }, then: { properties: { result: resultSchema, citations: { type: 'array', minItems: 2 } } }, else: { properties: { result: { type: 'null' } } } }] };
const request = node('input', 'request', '복합 질문 입력'), files = node('file_input', 'files', '서로 다른 정책 문서 선택');
files.config = { mimeTypes: ['text/plain', 'text/markdown'], maxFiles: 4, maxBytesPerFile: 65536 }; files.inputBindings = { files: literal([]) };
const inspectArgs = merge('inspect_args', '첫 원문의 무결성 확인 준비', { file: from('files', '/data/0') }), inspect = node('tool', 'inspect', '등록된 원문 검사 도구');
inspect.config = { tool: { kind: 'builtin', id: 'file.inspect', version: 1 } }; inspect.inputBindings = { arguments: from('inspect_args') };
const build = node('knowledge', 'build', '현재 실행의 정책 색인 만들기'); build.config = { operation: 'build', profile: 'local-run-keyword-v1', indexSettings: { kind: 'keyword', chunkSize: 800, chunkOverlap: 80 } }; build.inputBindings = { documents: from('files') };
const scope = node('retrieval', 'scope', '문서 범위 먼저 확인'); scope.config = { mode: 'keyword', topK: 4, maxContextTokens: 1600 }; scope.inputBindings = { index: from('build'), query: literal('문서범위') };
const indexes = node('merge', 'index_list', '허용한 색인 목록'); indexes.config = { waitFor: 'all_active', combine: 'array', collision: 'error' }; indexes.inputBindings = { current: from('build') };
const context = merge('context', '질문과 문서 범위 전달', { request: from('request'), firstFileIntegrity: from('inspect'), scope: from('scope', '/data/context') });
const agent = node('agent', 'research', '질문 분해와 제한된 재검색'); agent.config = {
  strategy: 'agentic_rag', modelProfile: 'project-model', maxSteps: 12, toolAllowlist: [], resultSchema,
  retrievalPolicy: { maxRounds: 3, maxQueriesPerRound: 2, maxRetrievedChunks: 30, maxContextTokens: 6000, onInsufficient: 'abstain' },
  instructions: [
    '가상 구름서가의 배송 일정과 미사용 상품 반품 조건을 함께 묻는 두 부분 질문을 다룹니다. 전체 질문을 읽고 배송과 반품을 각각 하위 질문으로 명시하세요.',
    '먼저 search action의 같은 라운드에 배송·반품 두 하위 질의를 제안하세요. 공급자가 주는 indexes alias만 사용합니다. 문서범위는 탐색 방향을 위한 사전 정보이며 이 내용만으로 답변하거나 citations를 만들어서는 안 됩니다.',
    '원문에서 실제 사용하는 단어 배송, 반품을 중심으로 질의를 만듭니다. 처음 질의가 비면 남은 한도 안에서 단어를 바꾸어 검색할 수 있습니다. 웹·외부 API·도구 호출·권한 확장은 하지 않습니다.',
    'answer는 배송과 반품을 모두 뒷받침하는 서로 다른 정책 문서 근거를 검색한 경우에만 허용합니다. delivery와 returns 각각 subquestion·answer를 채우고 integratedAnswer에서 두 조건을 함께 설명하세요. evidenceIds에는 실제 검색한 두 문서의 근거를 모두 포함하세요.',
    '관련 문서가 검색되어도 배송비·반품 비용·환급 일수·특정 도착일처럼 원문에 없는 사실, 한 부분이라도 답할 근거가 없는 질문, 이 두 정책 범위 밖 질문이면 abstain합니다. 부분 답변을 완전 답변으로 제출하지 않습니다. 사용자에게 추가 질문하는 기능은 없습니다.',
    '원문에 없는 정책을 추론하지 마세요. 영업일과 달력일을 섞지 않고 특정 주문 상태·승인·환급·실제 발송을 실행했다고 주장하지 않습니다. externalActions는 none이며 limitations에는 원문 범위와 가상 자료라는 점을 표시합니다.',
  ].join('\n'),
}; agent.inputBindings = { task: input('/question'), context: from('context'), indexes: from('index_list') };
const coverage = node('guardrail', 'coverage', '하위 답변과 인용 개수 확인'); coverage.config = { rules: [{ id: 'complete_parts', kind: 'schema', parameters: { schema: agentResult } }], onViolation: 'block' }; coverage.inputBindings = { value: from('research') };
const result = merge('result', '원문·검색·통합 답변 보존', { question: input('/question'), firstFileIntegrity: from('inspect'), scopeSearch: from('scope'), research: from('research') }), finish = node('output', 'finish', '근거 포함 결과'); finish.config = { format: 'json' }; finish.inputBindings = { result: from('result') };
const guide = `# EP-106 운영 자료 사용\n\n1. sample-input.json의 복합 질문을 입력합니다.\n2. project-model에 gpt-5.4-mini-2026-03-17 대화·작업 연결을 명시적으로 선택합니다.\n3. 파일 선택에서 delivery-policy.md와 return-policy.md를 함께 업로드합니다.\n4. research.result의 delivery·returns·integratedAnswer와 research.citations의 서로 다른 원문을 대조합니다.\n\n이 두 원문은 실제 상점 정책이 아닌 원작 가상 자료입니다. 실제 모델 답변·정답 fixture·키·개발 명령은 포함하지 않습니다. 키워드 검색은 로컬이지만 질문·문맥·선택 근거는 각 모델 토큰 확인·생성 요청에 전송됩니다. 외부 서비스 사용 비용이 발생할 수 있습니다. 근거 부족이면 답변을 유보합니다. 추가 질문·웹 검색·벡터·Graph 검색은 이 예제의 기능이 아닙니다.\n`;
const assets = await projectAssets(id, [], sample, { 'guide.md': guide, 'delivery-policy.md': delivery, 'return-policy.md': returns });
const nodes: Workflow['nodes'] = [request, files, inspectArgs, inspect, build, scope, indexes, context, agent, coverage, result, finish];
const workflow: Workflow = { ...createBasicWorkflow(entry.name), id: 'official_EP_106', entryNodeId: request.id, inputs, outputs: object({ question: inputs.properties.question!, firstFileIntegrity: { type: 'object' }, scopeSearch: { type: 'object' }, research: agentResult }), modelProfiles: { 'project-model': { kind: 'chat', requiredFeatures: ['json_schema'] } }, resources: assets.refs, subworkflows: {}, nodes, edges: nodes.slice(0, -1).map((n, i) => edge(n.id, nodes[i + 1]!.id)) };
workflow.policy.limits = { maxConcurrentNodes: 1, maxNodeInstances: 30, maxModelCalls: 4, maxTotalTokens: 30000, maxActiveMs: 600000, maxChildDepth: 1 }; agent.execution.timeoutMs = 180000;
const acceptance = [
  '복합 질문에서 배송·반품 하위 질문을 실제로 생성하고 최소 두 하위 질의를 실행합니다. 한 부분이 누락된 answer JSON은 결과 스키마에서 거부합니다.',
  '배송 답변은 결제 확정 다음 영업일부터 2~4영업일, 반품 답변은 수령일부터 14일·미사용·원래 포장·구성품 조건을 각 원문과 대조합니다. 실제 정책이라고 표시하지 않습니다.',
  '두 문서의 실제 UTF-8 범위·원본 hash·IndexRef를 citation에서 확인합니다. 답변에 필요한 서로 다른 문서 근거를 골랐는지 실제 모델 검수에서 확인합니다.',
  '원문에 없는 비용·환급 일수·도착일 또는 어느 한 부분의 근거가 없으면 insufficient_evidence로 유보합니다. 관련 검색이 있다는 것과 필요한 사실이 있다는 것을 구분합니다.',
  '최대 3라운드·회당 2질의·12단계·30청크·누적 검색 문맥 6000토큰과 root 4모델 호출·30000토큰 한도를 넘지 않습니다. 실제 모델 사용량과 로컬 문맥 토큰은 구별합니다.',
];
const readme = `# ${entry.name}\n\n${entry.definition.purpose}. ${entry.definition.inputOutput}.\n\n## 시작\n\n${guide.split('\n').slice(2).join('\n')}\n## 설계 블록과 실제 연결\n\n원래 설계: ${entry.definition.blocksAndConnections}. 실제 운영 그래프는 input→file_input→merge(도구 인수)→tool(file.inspect)→knowledge→retrieval(문서 범위)→merge(색인 목록·문맥)→agent(agentic_rag)→guardrail→merge→output입니다. 원래 agent·tool·retrieval·merge를 실제로 사용합니다. tool은 현재 실행의 첫 원문 무결성·메타데이터를 확인하며 모든 파일은 knowledge에서 다시 검증합니다. retrieval은 문서 범위를 먼저 탐색합니다. Agentic의 하위 검색은 Runner 내부에 고정한 동일 키워드 검색 kernel이 수행합니다. tool 노드가 모델에게 임의 검색/MCP 권한을 주는 구조가 아닙니다.\n\n범용 질문 분해의 첫 운영 예로 배송·반품 두 정책을 함께 묻는 질문을 다룹니다. resultSchema는 delivery와 returns를 각각 필수로 요구합니다. 다른 도메인·질문 구성으로 확장하려면 입력 안내·결과 스키마·원문·평가를 함께 바꾸세요. 무관한 질문을 두 정책 답변으로 억지 변환하지 않습니다.\n\n## 결과 확인\n\n${acceptance.map((line, i) => `${i + 1}. ${line}`).join('\n')}\n\n공통 완료 기준: ${entry.definition.acceptanceCriteria}. guardrail은 답변 두 부분과 최소 2인용의 구조를 검사합니다. 서로 다른 문서인지, 각 답변이 근거에 의해 뒷받침되는지, 자연어 질문의 뜻을 모두 덮는지는 이 구조 검사만으로 보증되지 않으며 실제 모델 평가·사람 검토가 필요합니다. 선택된 인용의 ID·원본·권한은 Runner가 검증합니다.\n\nresearch.status는 answered, insufficient_evidence, conflicting_evidence로 구분됩니다. 뒤의 둘은 result=null입니다. 유보 결과를 정상적으로 만든 run이 succeeded여도 완전 답변을 얻었다는 뜻은 아닙니다. 추가 질문(EP-107)이나 웹 최신성 확인(EP-110)을 했다고 표시하지 않습니다.\n\n## 한도·실패·개인정보\n\n파일은 UTF-8 TXT/Markdown 최대 4개, 각각 64 KiB입니다. 입력 자료·지침은 권한을 확장하는 명령으로 취급하지 않습니다. 색인은 현재 실행 안에서만 사용하고 권한 철회는 이후 모델 전송·결과 공개를 차단합니다. 토큰 확인 실패·사용량 불명·잘못된 모델/근거·예산 초과·원본 변조·취소를 가짜 성공으로 덮지 않습니다. 결과 불명은 예약을 보존하며 자동 재실행하지 않습니다. 원문을 모델의 reference 첨부로 직접 우회하지 않습니다.\n\n키워드 검색은 의미·동의어·형태소 검색이 아니므로 빈 검색을 사실의 부재로 단정하지 않습니다. 운영 고정 모델과 계정은 사용자가 준비해야 하고 실제 모델 접근·응답 품질은 unverified입니다.\n\n## 검증 상태와 권리\n\n3종 운영 ZIP·실제 SQLite·원문 업로드·검색·인용·공유 예산 경계는 계정 없이 검사합니다. 계획/답변 공급자만 tests 내부 대역으로 검증하며 제품 fallback·답변 fixture는 넣지 않습니다. 실제 모델, Codex·Claude Code·OpenCode 앱의 실제 호스트 구동, 검수·게시는 unverified입니다. implemented는 usable/published가 아닙니다.\n\n동봉 원문은 직접 작성한 가상 상점 자료로서 실제 고객·기관·제3자 정책을 사용하지 않았습니다. LICENSE.md를 보존하세요. 제3자 권리를 부여하지 않습니다.\n`;

// Validate all operational outputs before writing; neither catalogue identity nor release verification is fabricated.
const shape = validateWorkflowShape(workflow); if (!shape.valid) throw new Error(JSON.stringify(shape.issues)); const issues = analyzeWorkflow(workflow).filter(value => value.severity === 'error'); if (issues.length) throw new Error(JSON.stringify(issues)); if (!validateJsonValue(inputs, sample).valid) throw new Error('Invalid sample');
const archives = new Map<string, Uint8Array>(); for (const host of ['codex', 'claude-code', 'opencode'] as const) { const zip = await buildPackage({ workflow, resources: assets.files, host }); await inspectPackage(zip.bytes); archives.set(host, zip.bytes); }
const filesToWrite = { ...assets.files, 'workflow.json': jsonBytes(workflow), 'sample-input.json': jsonBytes(sample), 'README.md': encode(readme), 'LICENSE.md': encode(license(id)) };
for (const [path, bytes] of Object.entries(filesToWrite)) { const target = resolve(folder, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' }); }
const latest = await loadCatalog(), unchanged = JSON.stringify(latest.entries.filter(value => value.id !== id)), owned = latest.entries.find(value => value.id === id)!; if (owned.state !== 'planned' || owned.artifact) throw new Error('EP-106 changed concurrently');
const inventory = Object.entries(filesToWrite).map(([path, bytes]) => ({ path, sha256: digestBytes(bytes), role: path === 'workflow.json' ? 'entrypoint' : path === 'README.md' ? 'readme' : path === 'LICENSE.md' ? 'license' : 'payload' })) as NonNullable<OfficialExample['artifact']>['files'];
owned.artifact = { rootPath: `catalog/official/projects/${id}`, entrypoint: 'workflow.json', sha256: artifactDigest(inventory), files: inventory }; owned.state = 'implemented'; owned.requiredCapabilities = [...new Set([...owned.requiredCapabilities, ...collectRequirements(workflow).capabilities])].sort() as OfficialExample['requiredCapabilities'];
const report = await checkCatalog({ ...latest, entries: [owned] }, { root: repository, requireCompleteInventory: false }); if (!report.valid) throw new Error(JSON.stringify(report.issues)); if (JSON.stringify(latest.entries.filter(value => value.id !== id)) !== unchanged) throw new Error('Unowned catalogue row changed'); await writeFile(resolve(repository, 'catalog/official/catalog.json'), jsonBytes(latest));
const spec = { $comment: 'Internal acceptance plan, not actual-model/host evidence. Excluded from operational ZIPs.', projectId: id, sourceContract: owned.definition, artifactSha256: owned.artifact.sha256, actualModelAcceptance: acceptance, actualModelStatus: 'unverified', actualHostsStatus: { codex: 'unverified', 'claude-code': 'unverified', opencode: 'unverified' }, sourceProvenance: 'New original fictional delivery/return documents; no third-party source or actual merchant policy asserted', scope: 'Keyword Agentic decomposition; structured omission rejection and abstention, no clarification/web' };
await writeFile(resolve(repository, 'tests/catalog/project-specs/EP-106.json'), jsonBytes(spec), { flag: 'wx' });
const downloadFolder = resolve(repository, 'artifacts/catalog/EP-106'); await mkdir(downloadFolder, { recursive: true }); for (const [host, bytes] of archives) await writeFile(resolve(downloadFolder, `EP-106-${host}.zip`), bytes, { flag: 'wx' });
process.stdout.write('Authored EP-106 and three inspected operational ZIPs. Actual-model, actual-host and publication evidence remains absent.\n');
