import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildMaterialsPackage, verifyResources, type ResourceDescriptor } from '@studio/package-kit';
import type { ResourceRef } from '@studio/spec';
import { artifactDigest, checkCatalog } from './check.js';
import type { OfficialCatalog } from './inventory.js';
import type { OfficialExample } from './contracts.generated.js';

/**
 * Creates original, fictional business documents once. Existing operational files are authoritative:
 * reruns refuse to overwrite them. Future edits require an intentional revision/hash update, not regeneration.
 * Python/SQLite authoring helpers stay outside downloaded resources; no provider or test runner is packaged.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(root, 'catalog/official/catalog.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as OfficialCatalog;
const ids = Array.from({ length: 20 }, (_, index) => `ER-${String(index + 41).padStart(3, '0')}`);
const encode = (text: string) => new TextEncoder().encode(text);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const documents = new Map<string, { entrypoint: string; files: Map<string, Uint8Array> }>();

/** Every source is newly authored; identifiers denote fictional roles/services, never real customers. */
function add(id: string, body: string, payloads: Record<string, string> = {}) {
  const entry = catalog.entries.find((item) => item.id === id)!;
  const header = `# ${entry.name}\n\n문서 ID: ${id} / 버전 1.0 / 기준일 2026-10-01\n\n이 문서와 데이터의 기관 “한빛 업무연구소”, 제품 “라온 협업보드”, 역할·업무·기록은 모두 가상입니다. 실제 고객·개인·제3자 문서를 사용하지 않았습니다. 예시를 실제 서비스 정책이나 사건으로 오인하지 마세요.\n\n`;
  documents.set(id, { entrypoint: 'document.md', files: new Map([['document.md', encode(header + body.trim() + '\n')], ...Object.entries(payloads).map(([name, text]) => [name, encode(text)] as [string, Uint8Array])]) });
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// ER-041: a usable operations policy with concrete decision rules and section identifiers.
add('ER-041', `## OPS-01 목적과 역할
업무 요청을 정리하고 제공 자료를 바탕으로 초안을 만드는 작업을 대상으로 합니다. R-PLAN은 범위와 우선순위, R-EDITOR는 초안, R-QA는 근거 검토, R-OPS는 허용된 운영 확인을 맡습니다. 역할 이름은 실제 전문 자격을 뜻하지 않습니다.

## OPS-02 읽기 범위
요청에 첨부한 자료와 명시적으로 허용된 프로젝트만 읽습니다. 다른 프로젝트를 같은 조직이라는 이유로 조회하지 않습니다. 조회 목적·자료 ID·버전을 기록하며 비밀 값은 결과에 복사하지 않습니다.

## OPS-03 변경 승인
외부 발송, 공유 범위 확대, 원본 삭제, 비용 발생은 대상 ID·정확한 인자·영향·복구 방법을 검토한 후 승인된 범위에서만 실행합니다. 초안 작성 승인은 발송 승인을 포함하지 않습니다. 승인 이후 대상이나 인자가 바뀌면 재확인이 필요합니다.

## OPS-04 실행 한도
업무별로 사용자 지정 시간·호출·비용 상한을 먼저 확인합니다. 상한이 정해지지 않았으면 필요한 최소 범위를 제안합니다. 부모 작업과 하위 작업의 합계가 같은 상한을 공유하며 역할 수가 늘어도 예산은 늘지 않습니다.

## OPS-05 중단 기준
필수 입력 누락, 접근 권한 불일치, 출처 없는 핵심 사실, 상한 도달, 결과 불명인 외부 변경을 발견하면 해당 행동을 중단합니다. 영향을 받지 않는 읽기·정리 작업은 허용 범위 안에서 계속할 수 있습니다.

## OPS-06 결과 불명과 인계
쓰기 요청의 응답이 없으면 실패로 단정하지 않습니다. 작업 ID로 외부 상태를 확인하고 중복 실행을 피합니다. 인계에는 현재 상태·확인한 근거·미해결 질문·남은 한도·다음 확인 대상을 담습니다.

## OPS-07 완료 판정
산출물 존재, 요구사항별 검사, 원문 근거, 사용자 검토 필요 여부를 확인합니다. 도구 호출이나 모델 응답만으로 목표 완료를 선언하지 않습니다. 완료·부분 완료·확인 대기를 구분합니다.

## 적용 사례
회의록으로 이메일 초안을 작성하라는 요청은 OPS-02 범위에서 자료를 읽고 OPS-07로 초안을 검사합니다. 실제 메일 발송은 OPS-03의 별도 변경 승인 대상입니다. 승인 기록이 없으면 초안만 전달합니다.`);

const openapi = {
  openapi: '3.1.0', info: { title: 'Raon fictional reporting API', version: '2.0.0', description: 'Fictional contract for document-reading practice. No live service.' }, servers: [{ url: 'https://api.raon.example.invalid' }],
  paths: {
    '/reports': { get: { operationId: 'listReports', security: [{ bearerAuth: ['reports:read'] }], parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'A page; next_cursor=null means the last page.', content: { 'application/json': { schema: { type: 'object', required: ['items', 'next_cursor'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Report' } }, next_cursor: { type: ['string', 'null'] } } } } } }, '401': { description: 'Missing or invalid authentication.' }, '403': { description: 'No reports:read permission.' } } } },
    '/reports/{reportId}': { get: { operationId: 'getReport', security: [{ bearerAuth: ['reports:read'] }], parameters: [{ name: 'reportId', in: 'path', required: true, schema: { type: 'string', pattern: '^RPT-[0-9]{3}$' } }], responses: { '200': { description: 'Existing authorized report.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Report' } } } }, '404': { description: 'Missing or inaccessible report; details are not disclosed.' } } } },
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Opaque example token; never put an actual secret in this document.' } }, schemas: { Report: { type: 'object', required: ['id', 'title', 'status', 'created_at'], additionalProperties: false, properties: { id: { type: 'string' }, title: { type: 'string', minLength: 1, maxLength: 120 }, status: { type: 'string', enum: ['draft', 'review', 'approved'] }, created_at: { type: 'string', format: 'date-time' }, summary: { type: ['string', 'null'] } } } } },
};
add('ER-042', `## API-01 읽을 명세
함께 제공한 openapi.json은 가상 보고서 조회 API v2입니다. 실제 접속 가능한 API가 아닙니다. 인증 비밀을 준비하거나 URL에 호출할 필요 없이 계약 해석에 사용할 수 있습니다.

## API-02 경로와 입력
GET /reports는 목록 조회이며 limit은 1~50의 정수, 기본값은 20입니다. cursor는 선택 값입니다. GET /reports/{reportId}는 reportId가 필수이고 RPT-001 같은 형식입니다. 두 경로의 operationId는 각각 listReports, getReport입니다.

## API-03 응답 해석
Report의 필수 필드는 id·title·status·created_at입니다. summary는 선택 필드이며 명시적 null도 허용합니다. 필드 생략과 null은 같은 계약이 아닙니다. status는 draft·review·approved만 허용합니다. created_at은 날짜만 있는 문자열이 아니라 date-time입니다.

## API-04 인증과 오류
명세는 bearerAuth와 reports:read 범위를 기술합니다. 실제 권한이 강제되는지는 서버를 별도로 검증해야 합니다. 401은 인증 문제, 403은 범위 부족이며, 상세 조회 404는 없는 항목과 접근 불가 항목을 구분해서 노출하지 않습니다.

## API-05 페이지 종료
목록 응답은 items와 next_cursor가 필수입니다. next_cursor=null이 마지막 페이지를 뜻합니다. items가 빈 배열인지 여부만으로 종료를 추측하지 않습니다.

## API-06 적용 예
“한 번에 100개를 조회할 수 있는가?”에는 paths./reports.get.parameters의 limit.maximum=50을 근거로 아니라고 설명합니다. “보고서 생성이 가능한가?”에는 제공 명세에 POST가 없다고 답하되 실제 서비스 전체가 생성을 지원하지 않는다고 일반화하지 않습니다.`, { 'openapi.json': json(openapi) });

const schemaSql = `-- Fictional read-only practice data. Creation statements belong to the supplied example, not an operational database.\nPRAGMA foreign_keys=ON;\nCREATE TABLE projects(project_id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','paused','closed')));\nCREATE TABLE roles(role_id TEXT PRIMARY KEY,title TEXT NOT NULL);\nCREATE TABLE tasks(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),owner_role_id TEXT REFERENCES roles(role_id),title TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('todo','doing','done')),due_date TEXT);\nCREATE TABLE reports(report_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),title TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','review','approved')));\n`;
const seedSql = `-- All records describe fictional projects and roles; no personal information.\nINSERT INTO projects VALUES('P-ALPHA','문서 검색 개선','active'),('P-BETA','보고서 자동 정리','active'),('P-GAMMA','운영 안내 개정','paused');\nINSERT INTO roles VALUES('R-PLAN','기획 역할'),('R-OPS','운영 역할'),('R-QA','검토 역할'),('R-EDITOR','편집 역할');\nINSERT INTO tasks VALUES('T-001','P-ALPHA','R-PLAN','검색 질문 범위 정리','done','2026-10-05'),('T-002','P-ALPHA','R-QA','인용 누락 점검','doing','2026-10-12'),('T-003','P-ALPHA',NULL,'접근 범위 안내 검토','todo',NULL),('T-004','P-BETA','R-EDITOR','보고서 목차 정리','done','2026-10-06'),('T-005','P-BETA','R-QA','표 합계 대조','done','2026-10-08'),('T-006','P-BETA','R-OPS','생성 오류 분류','doing','2026-10-15'),('T-007','P-GAMMA','R-PLAN','개정 요구 취합','done','2026-10-04'),('T-008','P-GAMMA',NULL,'공개 범위 결정','todo',NULL);\nINSERT INTO reports VALUES('RPT-001','P-ALPHA','검색 범위 초안','2026-10-01T09:00:00Z','approved'),('RPT-002','P-ALPHA','인용 점검 중간 결과','2026-10-10T09:00:00Z','review'),('RPT-003','P-BETA','표 대조 요약','2026-10-08T08:00:00Z','approved'),('RPT-004','P-GAMMA','운영 안내 개정안','2026-10-11T07:00:00Z','draft');\n`;
const dictionary = { projects: { primaryKey: 'project_id', fields: { project_id: 'TEXT NOT NULL', name: 'TEXT NOT NULL', status: 'TEXT: active|paused|closed' } }, roles: { primaryKey: 'role_id', fields: { role_id: 'TEXT NOT NULL', title: 'TEXT NOT NULL' } }, tasks: { primaryKey: 'task_id', fields: { task_id: 'TEXT NOT NULL', project_id: 'TEXT NOT NULL -> projects.project_id', owner_role_id: 'TEXT NULL -> roles.role_id', title: 'TEXT NOT NULL', status: 'TEXT: todo|doing|done', due_date: 'TEXT NULL, YYYY-MM-DD' } }, reports: { primaryKey: 'report_id', fields: { report_id: 'TEXT NOT NULL', project_id: 'TEXT NOT NULL -> projects.project_id', title: 'TEXT NOT NULL', created_at: 'TEXT NOT NULL, ISO8601 UTC', status: 'TEXT: draft|review|approved' } } };
add('ER-043', `## DB-01 데이터 범위
sample.sqlite는 projects 3행, roles 4행, tasks 8행, reports 4행을 담은 실제 SQLite 파일입니다. 각 행은 가상 업무이며 사람 이름·연락처가 없습니다. schema.sql과 seed.sql은 이 파일의 구조와 원본 데이터입니다.

## DB-02 관계
tasks.project_id와 reports.project_id는 projects.project_id를 참조합니다. tasks.owner_role_id는 roles.role_id를 참조하며 NULL은 담당 미정입니다. 프로젝트와 작업을 조인하면 프로젝트가 작업 수만큼 반복되므로 프로젝트 수를 단순 COUNT(*)로 계산하지 않습니다.

## DB-03 시간과 상태
due_date는 날짜만 있는 YYYY-MM-DD 텍스트이며 시간대 변환 대상이 아닙니다. reports.created_at은 UTC 시각입니다. tasks의 done과 reports의 approved는 서로 다른 상태 체계입니다. 모든 필드 정의는 dictionary.json에 있습니다.

## DB-04 읽기 조건
제공 DB는 읽기 전용 연결 모드와 제한된 파일 권한으로 여세요. PRAGMA query_only는 보조 설정이며 운영 DB의 권한 통제를 대신하지 않습니다. 예제의 생성 SQL을 운영 데이터베이스에서 실행하지 마세요.

## DB-05 대조 가능한 사실
P-ALPHA 작업은 3건이고 완료는 1건입니다. P-BETA 작업은 3건이고 완료는 2건입니다. 담당 미정 작업은 T-003·T-008입니다. 승인된 보고서는 RPT-001·RPT-003입니다. 이 값은 실제 제공 DB로 읽기 조회해 대조할 수 있습니다.`, { 'dictionary.json': json(dictionary), 'schema.sql': schemaSql, 'seed.sql': seedSql });

add('ER-044', `## CHG-01 적용 범위와 분류
한빛 업무연구소의 가상 변경 요청은 문구 수정, 공개 범위 변경, 데이터 구조 변경으로 나눕니다. 문구 수정도 외부 공개 내용이 바뀌면 공개 검토를 거칩니다. 분류가 불명확하면 낮은 위험으로 추정하지 않습니다.

## CHG-02 준비
요청 C-101은 라온 안내문 2절의 용어를 바꾸는 제안입니다. 현재 버전 v3, 목표 v4, 변경 위치, 영향을 받는 링크, 복구할 v3 사본을 준비합니다. 이 예의 상태는 제안이며 실제 승인이 아닙니다.

## CHG-03 승인
범위 담당 R-PLAN이 목적·대상을 확인하고 R-QA가 전후 차이와 검사 계획을 검토합니다. 공개 범위 확대는 R-OPS의 접근 범위 확인도 필요합니다. 승인 기록에는 대상 ID·버전·인자·승인 시점을 고정합니다.

## CHG-04 적용과 확인
승인된 스냅샷과 실제 변경 인자를 대조한 뒤 적용합니다. 변경 후 문서 버전, 필수 절, 링크, 공개 범위를 재확인합니다. 적용 응답이 없으면 결과 불명 상태로 두고 실제 외부 상태를 확인합니다.

## CHG-05 복구와 종료
검사에 실패하면 원래 권한 안의 사전 합의된 복구만 제안합니다. 복구 요청도 결과가 확인되어야 완료입니다. 종료 보고에는 전후 버전·검사 근거·미해결 항목·실제 완료 여부를 남깁니다.`, { 'change-request.json': json({ id: 'C-101', fictional: true, status: 'proposed', target: 'GUIDE-RAON-02', beforeVersion: 3, proposedVersion: 4, change: '2절의 “실행 완료”를 “초안 작성 완료”로 정확히 표현', requiredReviewRoles: ['R-PLAN', 'R-QA'], approval: null }) });

add('ER-045', `## INC-01 사건 범위
대상은 가상 라온 협업보드의 보고서 생성 기능입니다. 사건 I-204에서 2026-10-14 09:10 UTC 이후 생성 요청 일부가 실패했고 조회 기능은 정상으로 관측되었습니다. 전체 서비스 장애로 확대 해석하지 않습니다.

## INC-02 첫 확인
관측 시점, 요청 ID, 실패 기능, 사용자 영향 범위를 기록합니다. 승인된 읽기 로그와 상태 조회만 이용합니다. 다른 프로젝트 로그·고객 원문·비밀 환경 변수를 조사 범위에 추가하지 않습니다.

## INC-03 우선순위
데이터 손상·비밀 노출 가능성이 있으면 해당 처리를 중단하고 지정된 운영 역할에 알립니다. 단순 지연과 처리 결과 불명은 구분합니다. 요청을 다시 보내기 전에 기존 ID로 완료 여부를 확인합니다.

## INC-04 인계와 완화
R-OPS는 확인된 로그·시각·범위를 정리하고 R-PLAN은 사용자 안내 범위를 결정합니다. 재시작·설정 변경은 별도 변경 승인 대상입니다. 이 안내서 자체가 운영 변경 권한을 부여하지 않습니다.

## INC-05 복구 판정
새 요청의 성공만으로 모든 이전 요청이 복구되었다고 말하지 않습니다. 실패한 요청 ID의 상태와 정상 경로를 대조합니다. 종료 전 잔여 실패·확인 대기 요청·다음 보고 시점을 기록합니다.`, { 'incident-timeline.csv': 'event_id,time_utc,request_id,event,observed_scope\nE1,2026-10-14T09:10:00Z,REQ-204-1,generation_timeout,report-generation\nE2,2026-10-14T09:12:00Z,REQ-204-2,generation_error,report-generation\nE3,2026-10-14T09:14:00Z,REQ-204-3,read_success,report-read\nE4,2026-10-14T09:17:00Z,REQ-204-1,status_unknown,one-request\nE5,2026-10-14T09:25:00Z,REQ-204-4,generation_success,new-request-only\n' });

const faq = [
  ['FAQ-001', '라온 협업보드는 무엇인가요?', '가상 팀의 업무 카드와 보고서를 정리하는 연습용 제품입니다. 실제 상용 서비스가 아닙니다.'],
  ['FAQ-002', 'Basic의 구성원 한도는?', 'Basic은 워크스페이스당 최대 5명의 구성원을 등록할 수 있습니다.'],
  ['FAQ-003', 'Team의 구성원 한도는?', 'Team은 워크스페이스당 최대 25명의 구성원을 등록할 수 있습니다.'],
  ['FAQ-004', '파일 크기 한도는?', '파일 하나당 Basic 20 MiB, Team 100 MiB입니다. MiB는 1,048,576바이트입니다.'],
  ['FAQ-005', '삭제한 카드를 복구할 수 있나요?', '휴지통 보관 기간은 Basic 30일, Team 90일입니다. 보관 기간이 지난 카드의 복구는 이 문서에서 보장하지 않습니다.'],
  ['FAQ-006', '외부 공개는 기본인가요?', '새 프로젝트는 비공개입니다. 외부 공개에는 범위 담당자의 별도 승인이 필요합니다.'],
  ['FAQ-007', 'CSV 내보내기가 가능한가요?', '두 플랜 모두 읽기 권한이 있는 카드의 CSV 내보내기를 지원합니다. 숨겨진 필드는 내보내지 않습니다.'],
  ['FAQ-008', 'API 조회는 어느 플랜에 있나요?', 'API 조회는 Team에서 지원합니다. reports:read 범위와 프로젝트 접근 권한이 모두 필요합니다.'],
  ['FAQ-009', '초대 링크는 얼마나 유효한가요?', '초대 링크는 생성 후 48시간 동안 유효하며 사용하면 다시 사용할 수 없습니다.'],
  ['FAQ-010', '시간은 어떻게 보이나요?', '기록은 UTC로 저장하고 화면에서는 사용자가 선택한 시간대로 표시합니다. 날짜만 있는 기한은 시각으로 변환하지 않습니다.'],
  ['FAQ-011', '지원 문의에 무엇을 보내나요?', '요청 ID·발생 시각·기능 이름·가린 오류 화면을 보냅니다. 비밀번호·API 키·고객 원문은 보내지 않습니다.'],
  ['FAQ-012', '실패한 보고서 요청을 다시 보내도 되나요?', '응답이 없으면 기존 요청 ID로 처리 상태를 먼저 확인합니다. 결과 불명 상태에서 새 요청 ID로 자동 재전송하지 않습니다.'],
].map(([id, question, answer]) => ({ id: id!, question: question!, answer: answer!, version: 1, effectiveFrom: '2026-10-01', access: 'fictional-public' }));
add('ER-046', `## FAQ 원본 범위
아래 항목은 기준일의 가상 제품 정책입니다. 가격·결제 수단·특정 지역 지원·법적 보증은 포함하지 않습니다. 해당 질문에는 근거 부족이라고 답해야 합니다.

${faq.map((item) => `## ${item.id} ${item.question}\n${item.answer}`).join('\n\n')}

## 활용 규칙
답변에는 항목 ID와 기준일을 연결합니다. 플랜을 혼동하지 말고 MiB·일·시간 단위를 유지합니다. JSON 원문은 faq.json에 있으며 파일 안의 각 항목이 인용 단위입니다.`, { 'faq.json': json(faq) });

const features = [
  ['F-001','구성원 한도','number','members',5,25,'워크스페이스당'], ['F-002','파일 크기','number','MiB',20,100,'파일 하나당'],
  ['F-003','휴지통 보관','number','days',30,90,'삭제 시점부터'], ['F-004','CSV 내보내기','boolean','',true,true,'읽기 권한 필드만'],
  ['F-005','API 조회','boolean','',false,true,'reports:read와 프로젝트 권한 필요'], ['F-006','프로젝트 기본 공개','boolean','',false,false,'명시적 공개 승인 필요'],
  ['F-007','초대 유효 시간','number','hours',48,48,'일회용 링크'], ['F-008','UTC 저장','boolean','',true,true,'표시 시간대는 사용자 선택'],
  ['F-009','필드별 접근 제한','boolean','',false,true,'권한 밖 필드는 검색·CSV에서 제외'], ['F-010','감사 기록 보관','number','days',7,90,'조회 권한 별도'],
  ['F-011','동시 보고서 생성','number','jobs',1,3,'상한 초과는 대기'], ['F-012','사용자 정의 역할','boolean','',false,true,'범위 담당자만 관리'],
].map(([id,name,type,unit,basic,team,constraint]) => ({ id, name, type, unit, plans: { Basic: basic, Team: team }, constraint, fictional: true }));
add('ER-047', `## CAT-01 비교 대상
가상 제품 라온 협업보드의 Basic·Team을 비교합니다. 모든 기능은 고유 ID가 있고 숫자·불리언을 구분합니다. false를 값 누락으로 해석하지 않습니다.

| 기능 ID | 기능 | Basic | Team | 단위·제약 |
|---|---|---|---|---|
${features.map((item) => `| ${item.id} | ${item.name} | ${item.plans.Basic} | ${item.plans.Team} | ${item.unit} / ${item.constraint} |`).join('\n')}

## CAT-02 적용 예
구성원 8명과 API 조회가 필요하면 F-001·F-005를 모두 만족하는 플랜을 찾습니다. Basic은 두 기준을 충족하지 못하고 Team은 충족합니다. 가격 정보가 없으므로 비용 대비 추천은 할 수 없습니다.

## CAT-03 검토 기준
features.json의 ID·자료형·단위·제약을 유지해 비교표를 만드세요. 조건 하나만 보고 나머지를 생략하지 말고, 자료에 없는 기능은 미확인으로 남깁니다.`, { 'features.json': json(features) });

const meetings = [
  { id: 'MTG-01', date: '2026-10-02', title: '검색 개선 범위', lines: ['L01 R-PLAN: 이번 범위는 제공 문서의 인용 정확도 개선으로 한정합니다.', 'L02 결정: 외부 웹 검색은 이번 작업에서 제외합니다.', 'L03 R-QA: 인용 누락 사례를 10월 7일까지 정리하겠습니다.', 'L04 R-EDITOR: 사용자 안내문도 바꾸면 좋겠습니다. 아직 담당과 기한은 정하지 않았습니다.'] },
  { id: 'MTG-02', date: '2026-10-08', title: '표 보고서 검토', lines: ['L01 R-QA: 합계 계산 기준은 원본 CSV와 동일하게 유지해야 합니다.', 'L02 결정: 합계 검산은 R-QA가 10월 10일까지 수행합니다.', 'L03 R-EDITOR: 목차 정리는 오늘 완료했습니다.', 'L04 제안: 외부 공개는 다음 회의에서 논의합니다. 지금 발행하는 결정은 아닙니다.'] },
  { id: 'MTG-03', date: '2026-10-12', title: '안내문 개정', lines: ['L01 결정: 이전 회의의 공개 제안은 보류하고 내부 초안만 작성합니다.', 'L02 R-EDITOR: 초안은 10월 16일까지 작성하겠습니다.', 'L03 결정: 최종 검토 담당은 아직 미정입니다.', 'L04 R-OPS: 공개 범위 확인 후 별도 승인이 필요합니다.'] },
];
add('ER-048', `## 기록 원칙
모든 역할·발언은 가상입니다. 결정·개인 약속·제안을 구분하고, 원문에 없는 담당·기한은 미정으로 남깁니다. 행 ID로 근거를 연결할 수 있습니다.

${meetings.map((meeting) => `## ${meeting.id} ${meeting.date} ${meeting.title}\n\n${meeting.lines.join('\n\n')}`).join('\n\n')}

## 추출 시 주의
MTG-01 L04는 안내문 변경 제안이며 확정 업무 배정이 아닙니다. MTG-02 L03은 이미 완료된 상태입니다. MTG-03 L01은 외부 공개를 보류한 최신 결정입니다. 상대 날짜 “오늘”은 해당 회의 날짜로만 해석합니다.`, { 'meetings.json': json(meetings) });

const revisions = [
  { id:'RULE-EXPORT-v1', version:1, status:'approved', publishedAt:'2026-09-20', effectiveFrom:'2026-10-01', effectiveTo:'2026-10-31', scope:'fictional-standard-export', noticeDays:2, text:'표준 자료 내보내기 변경은 적용 2일 전까지 범위 담당자에게 알린다.' },
  { id:'RULE-EXPORT-v2', version:2, status:'approved', publishedAt:'2026-10-20', effectiveFrom:'2026-11-01', effectiveTo:null, scope:'fictional-standard-export', noticeDays:5, text:'표준 자료 내보내기 변경은 적용 5일 전까지 범위 담당자에게 알리고 검토 기록을 남긴다.' },
  { id:'RULE-EXPORT-v3-draft', version:3, status:'draft', publishedAt:'2026-10-25', effectiveFrom:null, effectiveTo:null, scope:'fictional-standard-export', noticeDays:7, text:'검토 중인 제안: 7일 전 알림. 승인·시행되지 않았다.' },
];
add('ER-049', `## REV-01 기준을 고르는 순서
질문의 적용 날짜와 업무 범위를 먼저 확인합니다. 승인 상태, 시행 시작·종료일, 범위가 모두 일치하는 버전을 선택합니다. 게시일이 최신이라는 이유로 아직 시행 전인 버전이나 초안을 적용하지 않습니다.

${revisions.map((item) => `## ${item.id}\n상태: ${item.status}; 게시일: ${item.publishedAt}; 시행: ${item.effectiveFrom ?? '미정'} ~ ${item.effectiveTo ?? '종료 미정'}; 범위: ${item.scope}.\n\n${item.text}`).join('\n\n')}

## REV-02 날짜별 적용
2026-10-22의 표준 내보내기 변경에는 v1의 2일 기준이 적용됩니다. v2가 게시되었어도 시행 전입니다. 2026-11-03에는 v2의 5일 기준과 검토 기록 요구가 적용됩니다. 날짜가 없으면 어느 버전인지 확정하지 않습니다.

## REV-03 보존할 차이
v2는 알림 기간을 늘리고 검토 기록을 추가했습니다. 과거 작업의 적합성을 평가할 때 당시 시행 버전을 사용하며 이후 기준으로 과거를 단정하지 않습니다.`, { 'revisions.json': json(revisions) });

const terms = [
 ['TERM-01','workflow','워크플로','정해진 작업 순서와 데이터 연결','단일 AI 응답으로 축약 금지'],['TERM-02','draft','초안','검토 전 작업 사본','완성본으로 번역 금지'],['TERM-03','approval','승인','특정 범위의 행동을 허용한 결정','제안·요청과 구분'],['TERM-04','review','검토','내용을 기준에 따라 살피는 과정','승인 완료와 구분'],
 ['TERM-05','revision','개정 버전','내용이 바뀐 고정 판본','실행 횟수와 구분'],['TERM-06','run','실행','하나의 수행 이력','프로젝트 정의와 구분'],['TERM-07','retry','재시도','조건을 확인한 추가 수행','새 작업 생성과 구분'],['TERM-08','resume','재개','중단된 수행을 이어감','처음부터 반복과 구분'],
 ['TERM-09','timeout','시간 초과','기다리는 한도를 넘음','실패 확정으로 번역 금지'],['TERM-10','unknown outcome','결과 불명','외부 처리 여부를 모름','취소 완료와 구분'],['TERM-11','source','출처','근거가 나온 원본','검색 결과 제목만으로 대체 금지'],['TERM-12','citation','인용','주장과 원문 위치의 연결','단순 링크 목록과 구분'],
 ['TERM-13','scope','범위','허용된 대상과 행동의 경계','조직 전체로 확대 금지'],['TERM-14','permission','권한','접근·행동을 허용하는 조건','인증과 구분'],['TERM-15','authentication','인증','주체를 확인하는 과정','권한 전체를 뜻하지 않음'],['TERM-16','retention','보관 기간','정해진 데이터 유지 기간','복구 보증과 구분'],
 ['TERM-17','nullable','null 허용','명시적 null 값이 유효함','선택 필드와 구분'],['TERM-18','optional','선택 항목','필드 생략 가능','null 허용과 구분'],['TERM-19','record','레코드','구조화된 한 건의 데이터','로그 전체와 구분'],['TERM-20','checkpoint','체크포인트','검증된 중간 상태','실행 성공 자체와 구분'],
 ['TERM-21','index','색인','검색을 위한 파생 구조','원문 자체와 구분'],['TERM-22','rerank','재정렬','기존 후보의 관련성 순서 변경','새 문서 생성과 구분'],['TERM-23','entity','개체','식별된 대상','이름이 같다고 동일 개체 아님'],['TERM-24','relationship','관계','개체 사이의 명시된 연결','인과로 확대 금지'],
].map(([id,en,ko,meaning,restriction])=>({id,en,ko,meaning,restriction}));
add('ER-050', `## TERM-00 사용 원칙
다음 매핑은 이 가상 자료집의 고정 용어입니다. 대문자 제품 코드·원문 ID는 그대로 두고 문맥상 다른 의미를 가진 일반 단어에 무조건 치환하지 않습니다.

| ID | English | 한국어 | 의미 | 주의 |
|---|---|---|---|---|
${terms.map((item)=>`| ${item.id} | ${item.en} | ${item.ko} | ${item.meaning} | ${item.restriction} |`).join('\n')}

## 적용 예
“Retry after an unknown outcome”은 “결과 불명 후 재시도”라는 문자 대응만으로 실행 지침을 만들면 안 됩니다. 결과 불명은 확인 필요 상태이고 재전송 허용을 뜻하지 않습니다. “optional summary”는 summary 생략 가능을 뜻하며 null 허용은 별도 계약을 확인합니다.`, { 'glossary.json': json(terms), 'glossary.csv': 'id,en,ko,meaning,restriction\n'+terms.map((item)=>[item.id,item.en,item.ko,item.meaning,item.restriction].map((value)=>`"${String(value).replaceAll('"','""')}"`).join(',')).join('\n')+'\n' });

// PDF and scan payloads are added below by bounded local authoring, then pinned like every other source file.
add('ER-051', `## REP-01 보고서 범위
report.pdf는 2026년 10월 가상 운영 기록을 정리한 실제 2쪽 PDF입니다. 1쪽은 팀별 작업, 2쪽은 문의 유형별 처리 현황입니다. PDF 기본 서체로 작성한 영어 표이며 한국어 설명과 열 매핑은 이 문서에 있습니다.

## REP-02 열과 단위
1쪽 Team·Planned·Completed·Remaining은 팀·계획 건수·완료 건수·남은 건수입니다. 2쪽 Category·Received·Closed·Pending은 문의 유형·접수·처리·대기 건수입니다. 모든 값은 정수 건수이며 페이지별 총계를 혼합하지 않습니다.

## REP-03 확인 기준
1쪽은 4팀과 합계 행, 2쪽은 4유형과 합계 행을 갖습니다. 1쪽 합계는 28·23·5, 2쪽은 36·31·5입니다. table-cells.json에 페이지·행·열·정답 문자열·PDF 좌표가 있습니다. 좌표 원점은 PDF의 왼쪽 아래입니다.

## REP-04 활용
표 추출기가 만든 CSV를 expected-tables.csv와 대조하세요. 숫자만 맞는지뿐 아니라 열 이름, 각 행의 ID, 합계, 페이지를 확인합니다. 이 정답 데이터는 활용용 평가 자료이며 추출을 실제 실행했다는 증거가 아닙니다.`);
add('ER-052', `## SCAN-01 자료 성격
scans.pdf와 scan-01.jpg·scan-02.jpg는 가상 업무 양식을 래스터 이미지로 그린 스캔 모사본입니다. 실제 종이를 스캔했다고 주장하지 않습니다. PDF에는 검색 가능한 원문 텍스트 층이 없으므로 OCR 입력으로 사용할 수 있습니다.

## SCAN-02 문서 내용
1쪽은 REQ-DEMO-001 장비 요청서입니다. 부서는 Operations, 품목은 Laptop stand, 수량은 2이며 요청일은 2026-10-03입니다. 필요일까지는 비어 있어 추측하지 않아야 합니다. 2쪽은 EXP-DEMO-002 비용 정리 문서로 Training 자료 비용 18,000 KRW, 상태 Pending review를 담습니다. 개인 이름·계좌·연락처는 없습니다.

## SCAN-03 정답과 위치
ocr-ground-truth.json에 페이지별 전체 전사와 필드 값, 이미지 픽셀 사각형을 제공합니다. 이미지 크기는 1200×1600이며 원점은 왼쪽 위입니다. 빈 필드는 null이고 blank=true입니다. 이미지 좌표를 PDF 좌표와 혼동하지 마세요.

## SCAN-04 검토
OCR 결과의 문자·날짜·수량·금액·통화와 원문 위치를 대조합니다. 비어 있는 기한을 요청일과 같다고 채우면 실패입니다. 현재 원본 제작 및 파일 검사는 실제 OCR 제공자 실행 검증을 대신하지 않습니다.`);

const roles = [
 {id:'R-PLAN',title:'기획 역할',owns:['범위 결정','우선순위','공개 요청 검토'],can:['요구사항 읽기','계획 초안','범위 승인'],cannot:['운영 설정 직접 변경','비밀 값 조회']},
 {id:'R-OPS',title:'운영 역할',owns:['운영 상태 확인','접근 범위 점검','사건 인계'],can:['허용 로그 읽기','승인된 상태 조회'],cannot:['승인 없는 재시작','다른 조직 로그 조회']},
 {id:'R-QA',title:'검토 역할',owns:['결과 기준 검사','근거 대조'],can:['제공 원문 읽기','검사 결과 작성'],cannot:['검사 없이 통과 표시','외부 발행']},
 {id:'R-EDITOR',title:'편집 역할',owns:['초안 작성','문구 정리','통합 문서'],can:['제공 자료 편집 사본 작성'],cannot:['원본 덮어쓰기','공개 승인 대행']},
];
add('ER-053', `## ROLE-01 범위표
아래는 가상 조직의 역할이며 실제 개인을 지정하지 않습니다. 역할별 허용 행동은 작업별 권한을 추가로 좁힐 수 있고 역할 이름만으로 새 권한이 생기지 않습니다.

${roles.map((role)=>`## ${role.id} ${role.title}\n책임: ${role.owns.join('·')}.\n\n허용: ${role.can.join('·')}.\n\n제외: ${role.cannot.join('·')}.`).join('\n\n')}

## ROLE-02 배정 사례
보고서 초안은 R-EDITOR, 결과 검사는 R-QA, 공개 범위 결정은 R-PLAN, 실제 접근 범위 확인은 R-OPS에 연결합니다. 법률 판단·결제 승인·인사 평가는 이 표에 책임 역할이 없으므로 담당 미정으로 남깁니다.

## ROLE-03 인계
각 작업에 최종 책임 역할 한 개를 기록하고 협업 역할은 따로 적습니다. 권한이 없는 업무를 처리하기 위해 존재하지 않는 역할이나 담당자를 만들지 않습니다.`, { 'roles.json': json(roles), 'assignments.json': json([{task:'보고서 초안',owner:'R-EDITOR',reviewer:'R-QA'},{task:'공개 범위 확인',owner:'R-OPS',reviewer:'R-PLAN'},{task:'법률 판단',owner:null,reviewer:null,reason:'정의된 역할 없음'}]) });

const approvals = [
 {id:'AP-01',type:'private-draft',condition:'제공 자료로 비공개 초안 작성',stages:['scope-check','draft','result-check'],requiredApprovers:[],externalWrite:false},
 {id:'AP-02',type:'external-publish',condition:'내용을 외부에 공개',stages:['scope-check','content-review','access-review','owner-approval','publish','read-back'],requiredApprovers:['R-QA','R-OPS','R-PLAN'],externalWrite:true},
 {id:'AP-03',type:'original-delete',condition:'원본 파일 삭제',stages:['target-pin','backup-check','owner-approval','delete','state-check'],requiredApprovers:['R-PLAN'],externalWrite:true},
 {id:'AP-04',type:'service-config',condition:'운영 서비스 설정 변경',stages:['target-pin','impact-review','rollback-plan','owner-approval','apply','health-check'],requiredApprovers:['R-OPS','R-PLAN'],externalWrite:true},
 {id:'AP-05',type:'cost-incurring',condition:'비용이 발생하는 작업',stages:['scope-check','cost-bound','owner-approval','execute','usage-check'],requiredApprovers:['R-PLAN'],externalWrite:true},
 {id:'AP-06',type:'unknown-outcome',condition:'외부 변경 결과를 확인하지 못함',stages:['pause-new-write','status-query','human-check-if-needed'],requiredApprovers:[],externalWrite:false},
];
add('ER-054', `## FLOW-01 분류와 우선순위
요청에 해당하는 모든 조건을 확인합니다. 한 요청이 외부 공개와 비용 발생을 동시에 포함하면 두 흐름의 필수 검토를 모두 보존합니다. 결과 불명 상태에서는 AP-06을 먼저 적용하고 새 변경을 보류합니다.

${approvals.map((rule)=>`## ${rule.id} ${rule.type}\n조건: ${rule.condition}.\n\n순서: ${rule.stages.join(' → ')}.\n\n필수 승인·검토 역할: ${rule.requiredApprovers.join(', ') || '추가 역할 지정 없음; 기존 범위 준수'}.`).join('\n\n')}

## FLOW-02 승인 고정
승인은 대상 ID·버전·정규화 인자에 대해 받습니다. 승인 뒤 인자가 달라지면 검토 단계로 돌아갑니다. 이 정의서의 역할 목록은 실제 승인이 존재한다는 기록이 아닙니다.

## FLOW-03 적용 사례
보고서 초안 요청은 AP-01입니다. 같은 보고서를 외부 링크로 공개하는 추가 요청은 AP-02입니다. 공개 호출이 시간 초과이면 발행 실패로 단정하지 않고 AP-06의 상태 조회를 수행할 계획을 만듭니다.`, { 'approval-flows.json': json(approvals) });

const entities = [
 {id:'ORG-HANBIT',type:'organization',name:'한빛 업무연구소',aliases:['Hanbit Lab'],namespace:'org'},
 {id:'SVC-BOARD',type:'service',name:'라온 협업보드',aliases:['Raon Board','라온'],namespace:'service'},
 {id:'SVC-API',type:'service',name:'Atlas API',aliases:['Atlas'],namespace:'service'},
 {id:'PRJ-ATLAS',type:'project',name:'Atlas 문서 정리',aliases:['Atlas'],namespace:'project'},
 {id:'DATA-CARDS',type:'dataset',name:'업무 카드 저장소',aliases:['cards','카드 데이터'],namespace:'dataset'},
 {id:'DATA-REPORTS',type:'dataset',name:'보고서 저장소',aliases:['reports','보고서 데이터'],namespace:'dataset'},
 {id:'SVC-BACKUP',type:'service',name:'보관 서비스',aliases:['Archive Service'],namespace:'service'},
 {id:'ROLE-OPS',type:'role',name:'운영 역할',aliases:['R-OPS','Operations role'],namespace:'role'},
 {id:'ROLE-QA',type:'role',name:'검토 역할',aliases:['R-QA','Review role'],namespace:'role'},
 {id:'DOC-POLICY',type:'document',name:'접근 정책 v1',aliases:['Access policy'],namespace:'document'},
];
add('ER-055', `## ENTITY-01 식별 원칙
entities.json의 ID가 안정된 식별자이며 표시 이름만으로 병합하지 않습니다. 유형과 namespace를 먼저 좁히고 별칭을 대조합니다. 모든 개체는 가상입니다.

| ID | 유형 | 이름 | 별칭 | 이름 공간 |
|---|---|---|---|---|
${entities.map((item)=>`| ${item.id} | ${item.type} | ${item.name} | ${item.aliases.join(', ')} | ${item.namespace} |`).join('\n')}

## ENTITY-02 동명이인·동명 대상
Atlas는 SVC-API와 PRJ-ATLAS의 공통 별칭입니다. “서비스 Atlas”는 SVC-API로, “Atlas 프로젝트”는 PRJ-ATLAS로 해소할 수 있습니다. “Atlas”만 주어지면 두 후보를 유지하고 자동 병합하지 않습니다.

## ENTITY-03 신규 이름
등록되지 않은 대상은 existing ID에 억지로 대응시키지 않습니다. 신규 후보로 분리하고 출처·유형·namespace를 검토한 후 별도 ID를 부여합니다. 이 사전을 읽었다는 것만으로 실제 그래프 색인이 구축되지는 않습니다.`, { 'entities.json': json(entities), 'resolution-cases.json': json([{input:'Raon Board',namespace:'service',expected:['SVC-BOARD'],decision:'resolved'},{input:'Atlas',namespace:null,expected:['SVC-API','PRJ-ATLAS'],decision:'ambiguous'},{input:'Atlas',namespace:'project',expected:['PRJ-ATLAS'],decision:'resolved'},{input:'Nova',namespace:'service',expected:[],decision:'unregistered'}]) });

const graphSources = [
 {id:'SRC-1',section:'2.1',text:'라온 협업보드는 업무 카드 저장소를 사용한다.'},
 {id:'SRC-2',section:'3.2',text:'Atlas API는 보고서 저장소를 사용한다.'},
 {id:'SRC-3',section:'4.1',text:'업무 카드 저장소는 보관 서비스의 백업 대상이다.'},
 {id:'SRC-4',section:'5.1',text:'라온 협업보드의 운영 책임 역할은 운영 역할이다.'},
 {id:'SRC-5',section:'5.2',text:'Atlas API는 라온 협업보드에 의존한다.'},
];
const relationTypes = [{type:'USES',from:['service'],to:['dataset'],meaning:'서비스가 데이터셋을 사용한다'},{type:'BACKED_UP_BY',from:['dataset'],to:['service'],meaning:'데이터셋의 백업을 서비스가 담당한다'},{type:'OWNED_BY',from:['service'],to:['role'],meaning:'서비스 운영 책임 역할'},{type:'DEPENDS_ON',from:['service'],to:['service'],meaning:'서비스 운영 의존; 인과 보장 아님'}];
const edges = [{id:'E-1',type:'USES',from:'SVC-BOARD',to:'DATA-CARDS',sourceId:'SRC-1'},{id:'E-2',type:'USES',from:'SVC-API',to:'DATA-REPORTS',sourceId:'SRC-2'},{id:'E-3',type:'BACKED_UP_BY',from:'DATA-CARDS',to:'SVC-BACKUP',sourceId:'SRC-3'},{id:'E-4',type:'OWNED_BY',from:'SVC-BOARD',to:'ROLE-OPS',sourceId:'SRC-4'},{id:'E-5',type:'DEPENDS_ON',from:'SVC-API',to:'SVC-BOARD',sourceId:'SRC-5'}];
add('ER-056', `## ONTO-01 관계 계약
관계 레코드는 id·type·from·to·sourceId를 요구합니다. from→to 방향과 허용된 개체 유형을 검사합니다. 별칭 해소가 불명확한 상태에서 간선을 확정하지 않습니다.

${relationTypes.map((item)=>`- ${item.type}: ${item.from.join('|')} → ${item.to.join('|')}; ${item.meaning}.`).join('\n')}

## ONTO-02 원문 근거
${graphSources.map((item)=>`- ${item.id}, ${item.section}: ${item.text}`).join('\n')}

## ONTO-03 올바른 간선
edges.json의 5개 간선은 위 원문과 entities.json을 연결합니다. E-3은 DATA-CARDS→SVC-BACKUP 방향입니다. “보관 서비스가 카드 저장소를 사용한다”라는 역방향 USES로 바꾸면 원문과 다른 관계가 됩니다.

## ONTO-04 거절할 후보
sourceId 없는 간선, 미등록 개체, ROLE-OPS→DATA-CARDS의 USES는 계약에 맞지 않습니다. DEPENDS_ON 경로가 있다는 사실만으로 특정 장애의 원인이나 실제 복구 성공을 주장하지 않습니다.`, { 'ontology.json': json(relationTypes), 'entities.json': json(entities), 'sources.json': json(graphSources), 'edges.json': json(edges), 'invalid-candidates.json': json([{id:'BAD-1',type:'USES',from:'ROLE-OPS',to:'DATA-CARDS',sourceId:'SRC-1',reason:'출발 개체 유형 불일치'},{id:'BAD-2',type:'BACKED_UP_BY',from:'DATA-CARDS',to:'SVC-BACKUP',sourceId:null,reason:'원문 출처 누락'}]) });

const accessDocuments = [
 {id:'ACL-D1',tenant:'lab-a',scope:'public',groups:[],text:'라온 공개 소개: 업무 카드를 정리합니다.'},
 {id:'ACL-D2',tenant:'lab-a',scope:'group',groups:['ops'],text:'가상 운영 점검 주기는 월요일입니다.'},
 {id:'ACL-D3',tenant:'lab-a',scope:'group',groups:['review'],text:'가상 검토 회의는 수요일입니다.'},
 {id:'ACL-D4',tenant:'lab-b',scope:'public',groups:[],text:'다른 가상 조직의 소개입니다.'},
 {id:'ACL-D5',tenant:'lab-a',scope:'private',groups:[],text:'개인 작업 초안은 검색 대상이 아닙니다.'},
];
const principals = [{id:'U-READER',tenant:'lab-a',groups:[]},{id:'U-OPS',tenant:'lab-a',groups:['ops']},{id:'U-REVIEW',tenant:'lab-a',groups:['review']},{id:'U-B',tenant:'lab-b',groups:[]}];
add('ER-057', `## ACL-01 범위 규칙
이 자료의 사용자 ID는 가상 주체 식별자이며 실제 개인이 아닙니다. 먼저 tenant가 정확히 일치해야 합니다. 그 안에서 public은 허용, group은 하나 이상의 그룹 일치가 필요합니다. private은 이 검색 사례에서 항상 제외합니다.

## ACL-02 원본과 파생 자료
청크·임베딩·그래프 간선·커뮤니티 요약에도 원본 범위가 따라가야 합니다. 서로 다른 범위의 자료를 합친 요약은 모든 기여 원문을 읽을 수 있는 주체에게만 허용합니다. 검색 후보를 만든 뒤 문구만 가리는 것으로 충분하지 않습니다.

## ACL-03 명시된 허용 결과
U-READER는 ACL-D1, U-OPS는 ACL-D1·ACL-D2, U-REVIEW는 ACL-D1·ACL-D3, U-B는 ACL-D4만 볼 수 있습니다. ACL-D5는 아무 조회 사례에도 포함하지 않습니다. 자료가 public이어도 다른 tenant에 공개되는 것은 아닙니다.

## ACL-04 삭제·변경
원문 권한이 바뀌거나 삭제되면 청크·색인·캐시·요약에서 이전 권한으로 결과를 내보내지 않도록 재검증해야 합니다. 이 문서는 정책과 정답 사례이며 실제 서비스의 권한 필터가 구현·검증되었다는 증거가 아닙니다.`, { 'access-documents.json': json(accessDocuments), 'principals.json': json(principals), 'expected-access.json': json({'U-READER':['ACL-D1'],'U-OPS':['ACL-D1','ACL-D2'],'U-REVIEW':['ACL-D1','ACL-D3'],'U-B':['ACL-D4']}), 'derived-records.json': json([{id:'SUM-1',sourceIds:['ACL-D1','ACL-D2'],requiredTenant:'lab-a',requiredGroups:['ops']},{id:'EDGE-1',sourceIds:['ACL-D2','ACL-D3'],requiredTenant:'lab-a',requiredGroups:['ops','review']}]) });

const evalCorpus = [
 {id:'D1',section:'1',text:'Basic 플랜은 구성원을 최대 5명까지 등록할 수 있다.'},
 {id:'D2',section:'2',text:'Team 플랜은 구성원을 최대 25명까지 등록할 수 있다.'},
 {id:'D3',section:'3',text:'파일 하나의 크기 제한은 Basic 20 MiB, Team 100 MiB이다.'},
 {id:'D4',section:'4',text:'CSV 내보내기는 두 플랜에서 지원하며 읽기 권한이 없는 필드는 제외한다.'},
 {id:'D5',section:'5',text:'초대 링크는 생성 후 48시간 동안 유효하며 한 번 사용하면 만료된다.'},
 {id:'D6',section:'6',text:'새 프로젝트는 비공개이고 외부 공개에는 별도 승인이 필요하다.'},
];
const questions = [
 {id:'Q1',question:'Basic 구성원은 최대 몇 명인가?',answer:'5명',relevantIds:['D1'],answerable:true},
 {id:'Q2',question:'Team 구성원은 최대 몇 명인가?',answer:'25명',relevantIds:['D2'],answerable:true},
 {id:'Q3',question:'Basic 파일 한도는?',answer:'20 MiB',relevantIds:['D3'],answerable:true},
 {id:'Q4',question:'Team 파일 한도는?',answer:'100 MiB',relevantIds:['D3'],answerable:true},
 {id:'Q5',question:'CSV에 권한 없는 필드도 포함되나?',answer:'제외한다',relevantIds:['D4'],answerable:true},
 {id:'Q6',question:'초대 링크 유효 시간은?',answer:'48시간',relevantIds:['D5'],answerable:true},
 {id:'Q7',question:'초대 링크를 두 번 쓸 수 있나?',answer:'한 번 사용하면 만료된다',relevantIds:['D5'],answerable:true},
 {id:'Q8',question:'새 프로젝트는 외부 공개 상태인가?',answer:'비공개',relevantIds:['D6'],answerable:true},
 {id:'Q9',question:'Basic과 Team 구성원 한도를 비교해줘.',answer:'Basic 5명, Team 25명',relevantIds:['D1','D2'],answerable:true},
 {id:'Q10',question:'API를 사용한 가격은 얼마인가?',answer:null,relevantIds:[],answerable:false},
 {id:'Q11',question:'한국어 전화 상담은 몇 시까지 가능한가?',answer:null,relevantIds:[],answerable:false},
];
add('ER-058', `## EVAL-01 제공 자료
corpus.json의 독립된 원문 6개와 questions.json의 질문 11개를 사용합니다. 질문 9개는 답변 가능, 2개는 제공 근거로 답변 불가입니다. 이 자료의 정답은 가상 원문에 관한 것이며 실제 제품 사실이 아닙니다.

## EVAL-02 측정 범위
검색 결과 문서 ID를 relevantIds와 대조해 Recall@k와 MRR을 계산합니다. 답변은 정답 수치·단위·조건과 실제 인용 구간을 확인합니다. 답변 불가 질문은 임의 사실을 생성하지 않고 유보했는지 별도로 셉니다.

## EVAL-03 손으로 확인할 사례
Q1의 관련 문서는 D1입니다. 순위가 D2,D1,D3이면 Recall@2=1, MRR=1/2, 이진 관련성의 nDCG@2=1/log2(3)입니다. 이는 계산 정의 설명이며 실제 검색 엔진의 성능 기록이 아닙니다.

## EVAL-04 평가 누출 방지
검색 인덱스에는 corpus만 넣습니다. questions의 정답·관련 ID를 검색 원문에 함께 넣지 않습니다. 실제 결과를 따로 받아 지표를 계산하고 실행하지 않은 성능을 보고하지 않습니다.`, { 'corpus.json': json(evalCorpus), 'questions.json': json(questions), 'metric-example.json': json({questionId:'Q1',ranking:['D2','D1','D3'],k:2,relevant:['D1'],expected:{recall:1,mrr:0.5,ndcg:1/Math.log2(3)},kind:'calculation-example-not-engine-result'}) });

const insufficient = [
 {id:'AB-01',question:'환불 기간은?',sources:[{id:'A1',text:'배송은 3영업일 걸린다.'}],decision:'abstain',reason:'배송 기간은 환불 근거가 아님'},
 {id:'AB-02',question:'현재 Team 가격은?',sources:[{id:'A2',text:'이 문서는 기능만 설명하며 가격은 포함하지 않는다.'}],decision:'abstain',reason:'가격 정보 없음'},
 {id:'AB-03',question:'모든 지역에서 전화 상담을 하나?',sources:[{id:'A3',text:'지원 문의에는 요청 ID를 적는다.'}],decision:'abstain',reason:'문의 절차와 지역별 전화 지원은 다른 사실'},
 {id:'AB-04',question:'2026년 11월 적용 규칙은?',sources:[{id:'A4',text:'2026년 10월까지 적용되는 규칙은 2일 전 알림이다.'}],decision:'abstain',reason:'질문 시점에 적용되는 근거 없음'},
 {id:'AB-05',question:'Basic 인원 한도와 환불 기간은?',sources:[{id:'A5',text:'Basic은 최대 5명이다.'}],decision:'partial',reason:'인원은 답할 수 있으나 환불은 유보',answerablePart:'Basic 최대 5명'},
 {id:'AB-06',question:'운영 내부 일정은?',sources:[],decision:'abstain',reason:'허용 범위의 자료 없음; 권한 밖 조회 금지'},
 {id:'AB-07',question:'삭제 후 반드시 복구 가능한가?',sources:[{id:'A7',text:'삭제 자료는 30일 동안 휴지통에 보관한다.'}],decision:'abstain',reason:'보관 기간은 모든 상황의 복구 보증이 아님'},
 {id:'AB-08',question:'“48”은 구성원 수인가?',sources:[{id:'A8',text:'초대 링크는 48시간 유효하다.'}],decision:'abstain',reason:'숫자가 같아도 단위와 대상이 다름'},
];
add('ER-059', `## ABSTAIN-01 목적
질문과 비슷한 단어·숫자가 나타나도 필요한 사실이 없는 경우를 구분합니다. cases.json은 서로 다른 부족 사유를 가진 8개 원문·질문·유보 판정 사례입니다.

${insufficient.map((item)=>`## ${item.id}\n질문: ${item.question}\n\n제공 근거: ${item.sources.map((source)=>`${source.id}: ${source.text}`).join(' / ') || '없음'}\n\n판정: ${item.decision}. 이유: ${item.reason}.`).join('\n\n')}

## ABSTAIN-02 결과 작성
답변 가능한 부분만 근거와 함께 적고 부족한 사실을 분리합니다. 추가 검색이 허용되지 않았거나 권한 밖이면 유보로 종료합니다. 검색 결과 0건을 해당 사실이 존재하지 않는다는 증거로 바꾸지 않습니다.`, { 'cases.json': json(insufficient) });

const conflictingSources = [
 {id:'C1',subject:'export-notice',scope:'standard',status:'approved',effectiveFrom:'2026-10-01',effectiveTo:'2026-10-31',text:'표준 변경은 2일 전에 알린다.'},
 {id:'C2',subject:'export-notice',scope:'standard',status:'approved',effectiveFrom:'2026-11-01',effectiveTo:null,text:'표준 변경은 5일 전에 알린다.'},
 {id:'C3',subject:'file-limit',scope:'Basic',status:'approved',effectiveFrom:'2026-10-01',effectiveTo:null,text:'파일 하나의 한도는 20 MiB이다.'},
 {id:'C4',subject:'file-limit',scope:'Team',status:'approved',effectiveFrom:'2026-10-01',effectiveTo:null,text:'파일 하나의 한도는 100 MiB이다.'},
 {id:'C5',subject:'support-window',scope:'all',status:'approved',effectiveFrom:'2026-10-01',effectiveTo:null,text:'가상 지원 접수는 17시에 끝난다.'},
 {id:'C6',subject:'support-window',scope:'all',status:'approved',effectiveFrom:'2026-10-01',effectiveTo:null,text:'가상 지원 접수는 18시에 끝난다.'},
];
const conflictCases = [{id:'CF-01',question:'10월 22일 표준 변경 알림 기준은?',sourceIds:['C1','C2'],decision:'resolve-by-effective-date',selected:['C1'],explanation:'C2는 시행 전'}, {id:'CF-02',question:'파일 한도는?',sourceIds:['C3','C4'],decision:'ask-scope',selected:[],explanation:'Basic 또는 Team을 확인'}, {id:'CF-03',question:'지원 접수 마감은?',sourceIds:['C5','C6'],decision:'abstain-conflict',selected:[],explanation:'동일 범위·시점의 승인 자료 충돌'}, {id:'CF-04',question:'11월 3일 표준 변경 알림 기준은?',sourceIds:['C1','C2'],decision:'resolve-by-effective-date',selected:['C2'],explanation:'C1의 시행 기간 종료'}];
add('ER-060', `## CONFLICT-01 원본 보존
sources.json은 6개 가상 원문을 개별 ID로 보존합니다. 동일 주제라도 적용 시점·범위가 다를 수 있습니다. 서로 다른 수치를 발견했다고 원문을 하나로 합치지 않습니다.

${conflictingSources.map((source)=>`## ${source.id}\n주제 ${source.subject}; 범위 ${source.scope}; 시행 ${source.effectiveFrom}~${source.effectiveTo ?? '종료 미정'}; 상태 ${source.status}.\n\n${source.text}`).join('\n\n')}

## CONFLICT-02 판정 순서
질문의 시점·범위를 확인한 뒤 두 출처의 상태·시행일·주장을 비교합니다. 명시된 기준으로만 해소하고, 같은 조건에서 다른 값을 말하면 양쪽 출처와 충돌을 그대로 남깁니다.

## CONFLICT-03 사례
CF-01·CF-04는 시행일로 해소됩니다. CF-02는 플랜 확인이 필요합니다. CF-03은 같은 범위·기간의 승인 원문이 충돌하므로 한쪽 시간을 임의로 고르지 않고 담당자의 원본 확인을 요청합니다. 모든 사례는 cases.json에 고정되어 있습니다.`, { 'sources.json': json(conflictingSources), 'cases.json': json(conflictCases) });

// Fail before any authoring if these targets have already acquired operational content.
for (const id of ids) {
  const entry = catalog.entries.find((item) => item.id === id);
  if (!entry || entry.state !== 'planned' || entry.artifact) throw new Error(`${id} is not planned; refusing to overwrite existing document content.`);
  try { await access(path.join(root, `catalog/official/resources/${id}`)); throw new Error(`${id} exists; refusing to overwrite authoritative files.`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

const temporary = await mkdtemp(path.join(tmpdir(), 'studio-documents-authoring-'));
try {
  // SQLite source and dictionary are checked against a real local database, not a pretend connector response.
  const database = new DatabaseSync(path.join(temporary, 'sample.sqlite'));
  database.exec(schemaSql + seedSql); database.close();
  documents.get('ER-043')!.files.set('sample.sqlite', new Uint8Array(await readFile(path.join(temporary, 'sample.sqlite'))));

  // ReportLab/Pillow only author document bytes here; the output contains no generator or OCR provider.
  const python = process.env.STUDIO_CATALOG_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const pythonSource = String.raw`
import json, os, sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
w, h = A4
tables = [
  {'title':'TEAM DELIVERY REPORT','headers':['Team','Planned','Completed','Remaining'],'rows':[['Alpha','8','6','2'],['Beta','6','6','0'],['Gamma','10','8','2'],['Delta','4','3','1'],['Total','28','23','5']]},
  {'title':'SUPPORT REQUEST REPORT','headers':['Category','Received','Closed','Pending'],'rows':[['Login','12','10','2'],['Export','8','7','1'],['Search','10','9','1'],['Permissions','6','5','1'],['Total','36','31','5']]}
]
c = canvas.Canvas(os.path.join(out,'report.pdf'), pagesize=A4, invariant=1, pageCompression=0)
cells=[]
for page,t in enumerate(tables,1):
  c.setFillColorRGB(.12,.2,.34); c.setFont('Helvetica-Bold',22); c.drawString(48,h-82,t['title'])
  c.setFont('Helvetica',11); c.drawString(48,h-109,'Hanbit fictional operations | October 2026 | Source v1')
  c.setFillColorRGB(.36,.4,.47); c.setFont('Helvetica',10); c.drawString(48,h-140,'All records are fictional. Counts are operational practice data.')
  xs=[48,248,348,448,548]; top=h-205; rh=37
  allrows=[t['headers']]+t['rows']
  for ri,row in enumerate(allrows):
    y=top-(ri+1)*rh
    c.setFillColorRGB(*((.13,.25,.43) if ri==0 else ((.92,.95,.98) if ri%2==0 else (1,1,1))))
    c.rect(xs[0],y,xs[-1]-xs[0],rh,stroke=0,fill=1)
    c.setFillColorRGB(*((1,1,1) if ri==0 else (.12,.17,.24))); c.setFont('Helvetica-Bold' if ri in [0,len(allrows)-1] else 'Helvetica',11)
    for ci,value in enumerate(row):
      c.drawString(xs[ci]+10,y+13,value)
      cells.append({'page':page,'row':ri,'column':ci,'text':value,'bboxPoints':[xs[ci],y,xs[ci+1]-xs[ci],rh],'origin':'bottom-left'})
  c.setStrokeColorRGB(.76,.81,.87)
  for x in xs:c.line(x,top,x,top-len(allrows)*rh)
  for ri in range(len(allrows)+1):c.line(xs[0],top-ri*rh,xs[-1],top-ri*rh)
  c.setFillColorRGB(.25,.3,.38); c.setFont('Helvetica',10)
  c.drawString(48,top-len(allrows)*rh-32,'Check: each row total equals completed/closed plus remaining/pending.')
  c.drawString(48,top-len(allrows)*rh-52,'Page totals belong to different measures. Do not add the two totals together.')
  c.setFont('Helvetica',9); c.drawString(48,42,'Original fictional source - no customer or personal information.'); c.drawRightString(w-48,42,f'Page {page} of 2')
  c.showPage()
c.save()
with open(os.path.join(out,'table-cells.json'),'w',encoding='utf-8') as f:json.dump({'schemaVersion':'1.0.0','fictional':True,'pageSizePoints':[w,h],'cells':cells},f,ensure_ascii=False,indent=2)
with open(os.path.join(out,'expected-tables.csv'),'w',encoding='utf-8') as f:
  f.write('page,row,label,first_count,second_count,third_count\n')
  for page,t in enumerate(tables,1):
    for row,values in enumerate(t['rows'],1):f.write(','.join([str(page),str(row)]+values)+'\n')

# Raster-only forms preserve the exact authored words and blank fields for genuine OCR input.
font=ImageFont.load_default(size=30); titlefont=ImageFont.load_default(size=44); smallfont=ImageFont.load_default(size=22)
forms=[{'title':'EQUIPMENT REQUEST','fields':[('request_id','Request ID','REQ-DEMO-001'),('department','Department','Operations'),('item','Item','Laptop stand'),('quantity','Quantity','2'),('requested_at','Requested date','2026-10-03'),('needed_by','Needed by','')]},{'title':'EXPENSE SUMMARY','fields':[('expense_id','Expense ID','EXP-DEMO-002'),('category','Category','Training'),('description','Description','Workshop materials'),('amount','Amount','18000'),('currency','Currency','KRW'),('status','Status','Pending review')]}]
truth={'schemaVersion':'1.0.0','fictional':True,'scanKind':'synthetic-raster-document-not-physical-scan','imageSize':[1200,1600],'origin':'top-left','pages':[]}
scanpdf=canvas.Canvas(os.path.join(out,'scans.pdf'),pagesize=A4,invariant=1)
for page,form in enumerate(forms,1):
  image=Image.new('RGB',(1200,1600),(249,248,245)); draw=ImageDraw.Draw(image)
  draw.rectangle((38,38,1162,1562),outline=(130,130,130),width=2)
  draw.text((80,100),'HANBIT - FICTIONAL DOCUMENT',font=smallfont,fill=(75,75,75))
  draw.text((80,165),form['title'],font=titlefont,fill=(20,20,20))
  draw.text((80,235),'OCR practice source / Synthetic scan / No personal data',font=smallfont,fill=(75,75,75))
  fields=[]; transcript=[form['title']]
  for row,(key,label,value) in enumerate(form['fields']):
    y=350+row*145
    draw.text((80,y),label,font=font,fill=(35,35,35)); draw.rectangle((470,y-12,1110,y+65),outline=(155,155,155),width=2)
    if value:
      draw.text((490,y),value,font=font,fill=(20,20,20)); box=draw.textbbox((490,y),value,font=font)
    else:box=(490,y,1090,y+50)
    fields.append({'name':key,'value':value or None,'blank':not bool(value),'bboxPixels':[box[0],box[1],box[2]-box[0],box[3]-box[1]]})
    transcript.append(label+': '+(value if value else '[blank]'))
  draw.text((80,1405),'This form is a fictional raster reproduction, not a real submission.',font=smallfont,fill=(80,80,80))
  draw.text((80,1460),f'Page {page} / 2 - authored source v1',font=smallfont,fill=(80,80,80))
  filename=f'scan-{page:02}.jpg'; image.save(os.path.join(out,filename),'JPEG',quality=91)
  scanpdf.drawImage(ImageReader(image),0,(h-w*1600/1200)/2,width=w,height=w*1600/1200); scanpdf.showPage()
  truth['pages'].append({'page':page,'image':filename,'transcript':'\n'.join(transcript),'fields':fields})
scanpdf.save()
with open(os.path.join(out,'ocr-ground-truth.json'),'w',encoding='utf-8') as f:json.dump(truth,f,ensure_ascii=False,indent=2)
`;
  execFileSync(python, ['-c', pythonSource, temporary], { stdio: 'pipe' });
  for (const name of ['report.pdf','table-cells.json','expected-tables.csv']) documents.get('ER-051')!.files.set(name,new Uint8Array(await readFile(path.join(temporary,name))));
  documents.get('ER-051')!.entrypoint='report.pdf';
  for (const name of ['scans.pdf','scan-01.jpg','scan-02.jpg','ocr-ground-truth.json']) documents.get('ER-052')!.files.set(name,new Uint8Array(await readFile(path.join(temporary,name))));
  documents.get('ER-052')!.entrypoint='scans.pdf';
} finally {
  const allowed = path.resolve(tmpdir()); const target = path.resolve(temporary);
  if (!target.startsWith(`${allowed}${path.sep}studio-documents-authoring-`)) throw new Error('Unsafe document authoring cleanup path.');
  await rm(target,{recursive:true,force:true});
}

const license = new Uint8Array(await readFile(path.join(root,'catalog/official/resources/ER-011/LICENSE.md')));
const completed = new Map<string,NonNullable<OfficialExample['artifact']>>();
for (const id of ids) {
  const entry=catalog.entries.find((item)=>item.id===id)!; const document=documents.get(id)!;
  const readme=`# ${entry.name}\n\n${entry.definition.purpose}. 이 폴더는 실제 내용이 있는 가상 문서·데이터이며 빈 양식이 아닙니다.\n\n## 활용\n\n${entry.definition.inputOutput}. ${document.entrypoint}를 원본으로 사용하고 document.md에서 기준과 한계를 확인하세요. 문서 ID·절·행·페이지를 결과의 근거로 남깁니다.\n\n연결 설계: ${entry.definition.blocksAndConnections.replaceAll('`','')}. 필요한 실제 모델·검색·추출·그래프 기능과 접근 권한은 사용자가 준비해야 합니다. 가져오기만으로 실행되거나 권한이 늘어나지 않습니다.\n\n## 자료와 정답의 구분\n\n가상 원문과 설명용 정답을 실제 고객 정보 또는 실제 모델 실행 결과로 표현하지 마세요. 평가용 질문·정답은 검색 원문 인덱스와 분리합니다. PDF·OCR 위치는 파일에 적힌 좌표계와 단위를 확인합니다.\n\n## 결과 확인\n\n${entry.definition.acceptanceCriteria}. 원본과 결과를 직접 대조합니다. 파일 제작·무결성 검사는 실제 호스트 사용이나 검색·OCR 품질 검증을 대신하지 않습니다.\n\n## 이용 조건\n\nLICENSE.md에 이 새로 작성한 원본 자료의 사용·수정·재배포 조건을 제공합니다. 제3자 자료의 권리는 부여하지 않습니다. 모든 기관·제품·역할·수치·사건은 가상입니다.\n`;
  document.files.set('README.md',encode(readme)); document.files.set('LICENSE.md',license);
  const descriptor:ResourceDescriptor={schemaVersion:'1.0.0',id,revision:1,kind:'document',name:entry.name,entrypoint:document.entrypoint,license:{id:'LicenseRef-Studio-Examples-v1',path:'LICENSE.md'},dependencies:{},requiredConnections:[],files:[...document.files].map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:hash(bytes)})) as ResourceDescriptor['files']};
  document.files.set('resource.json',encode(json(descriptor)));
  const ref:ResourceRef={id,revision:1,kind:'document',sha256:hash(document.files.get('resource.json')!)};
  const packageFiles=Object.fromEntries([...document.files].map(([name,bytes])=>[`resources/${id}/${name}`,bytes]));
  verifyResources({[id]:ref},new Map(Object.entries(packageFiles)));
  for(const host of ['codex','claude-code','opencode'] as const)await buildMaterialsPackage({host,refs:{[id]:ref},resources:packageFiles,name:entry.name});
  const rootPath=`catalog/official/resources/${id}`;
  for(const[name,bytes]of document.files){const target=path.join(root,rootPath,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});}
  const files=[...document.files].map(([name,bytes])=>({path:name,sha256:hash(bytes),role:name==='resource.json'?'entrypoint':name==='README.md'?'readme':name==='LICENSE.md'?'license':'payload'})) as NonNullable<OfficialExample['artifact']>['files'];
  completed.set(id,{rootPath,entrypoint:'resource.json',sha256:artifactDigest(files),files});
}
// Merge only owned entries after rereading, preserving concurrently authored catalogue work elsewhere.
const latest=JSON.parse(await readFile(catalogPath,'utf8')) as OfficialCatalog;
for(const entry of latest.entries){const artifact=completed.get(entry.id);if(!artifact)continue;if(entry.state!=='planned'||entry.artifact)throw new Error(`${entry.id} changed during authoring.`);entry.artifact=artifact;entry.state='implemented';}
const report=await checkCatalog(latest,{root});if(!report.valid)throw new Error(JSON.stringify(report.issues));
await writeFile(catalogPath,json(latest));
process.stdout.write('Created 20 original document resources, a real SQLite database, table PDF and raster OCR sources. Descriptor checks and 60 host ZIP builds passed; actual use/publication remains unverified.\n');
