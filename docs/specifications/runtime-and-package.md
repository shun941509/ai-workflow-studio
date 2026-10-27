# Runner·RAG·운영 ZIP 계약

## 실행

패키지 검사 → workflow 구조/의미 검사 → capability/모델/연결 확인 → 권한/예산 → 불변 resolvedPlan 저장 → 실행. plan에는 원문 해시, 고정 자료/도구/모델/색인, 유효 정책, planRevision/planHash가 필요하며 키는 제외한다.

runId → nodeInstanceId → attemptId를 구분한다. 외부 논리 변경의 operationId는 재시도에도 유지한다. 호출 의도와 인수 해시를 먼저 저장한다. 응답 유실은 미실행을 뜻하지 않으며 결과 불명은 attention_required다. 무조건 재전송하지 않는다.

노드 상태: pending,ready,running,waiting_input,waiting_review,waiting_approval,retry_wait,reconciling,succeeded,failed,skipped,blocked,cancelled. 실행 상태: created,running,waiting,cancelling,attention_required,succeeded,failed,blocked,cancelled. 일부 병렬 작업만 대기하면 전체는 running이다. 최종 출력이 있어도 활성 작업/미확인 변경이 남으면 성공이 아니다. 상태와 이벤트는 같은 트랜잭션, 이벤트는 증가 순번이다.

execution={timeoutMs,retry:{maxAttempts,backoffMs,retryOn},onError:fail|route}; waitTtlMs는 대기용. 기본 60초, 1회 시도, 대기 TTL24시간. 초기 프로젝트 제한: 동시4, 인스턴스1000, 모델100회, 총200000토큰, 활성30분, 자식 깊이8. 자식이 예산/권한을 확대할 수 없다. 호출 전 원자적 예약, 확인된 사용량으로 정산. 불명 호출 예약을 즉시 환급하지 않는다.

승인은 planHash+operationId+실제 대상/인수 해시+승인자+범위+만료에 묶는다. review는 업무 검토이며 보안 승인과 다르다. AI용 승인 생성 도구를 제공하지 않는다. 취소는 신규 실행을 막고 자식에 전파하지만 이미 완료한 변경은 남는다. 보상은 확인된 EffectRef에 대한 별도 승인 작업이다. 재계획은 새 불변 planRevision이며 이전 승인을 새 작업에 재사용하지 않는다.

Studio MCP: inspect_package,validate,start,status,events,cancel,results (studio. 접두사). start는 requestId와 요청 해시로 멱등 처리하고 runId를 바로 반환한다. 같은 ID/다른 본문은 충돌. Bridge 종료가 Runner 종료/취소가 아니다. 로컬 API는 루프백·인증·Origin/Host 검사. Worker는 실제 OS 파일/네트워크/프로세스 경계를 검증한다. 단순 child process를 sandbox로 주장하지 않는다.

## RAG

DocumentRef(문서/revision/원본hash/출처), ChunkRef(문서/청크/내용hash/위치), IndexRef(indexId/generationId/formatVersion/manifestHash)를 고정한다. 검색 후보는 ID,청크/그래프근거,rank,text,sourceRefs,단계별 scores를 가진다. BM25/유사도/RRF/reranker 점수를 같은 척도로 더하지 않는다.

Hybrid: 현재 ACL → keyword/vector → 후보ID 정규화/중복제거 → RRF(sum 1/(k+rank), rank는1부터) → candidateLimit → rerank → topK → 문맥예산. 동점은 후보ID. reranker가 없는 ID를 반환하면 거부. 실패 정책은 명시하고 기본 fail.

Agentic RAG는 허용 색인과 등록 도구만 사용하며 maxRounds/maxQueries/maxChunks/contextTokens/maxSteps를 제한한다. 추가 질문 후 예산 초기화 금지. 답변 상태 answered/insufficient_evidence/conflicting_evidence/needs_clarification. 검색 실패와 정상 빈 결과 구분.

GraphRAG는 근거 있는 개체/관계/별칭/커뮤니티/요약을 만들고 local/global 검색을 제공한다. 모델/임베딩/요약은 Runner 중계. ACL별 생성 범위와 현재 검색 권한 모두 검사. 불변 색인 세대는 완성 후 활성화. 삭제/권한철회는 tombstone으로 즉시 조회 차단하고 파생 결과/캐시 무효화. 이미 다운로드한 자료를 원격 삭제한다고 주장하지 않는다.

## 자료 구성 목록과 다운로드

ResourceRef.sha256는 resources/<alias>/resource.json의 원본 바이트 SHA-256이다. resource.json은 resource-descriptor.schema.json에 따라 id/revision/kind/name/entrypoint/license/dependencies/requiredConnections/files를 기록한다. files는 descriptor 자신을 제외한 자료 파일의 상대 경로·크기·원본 해시를 고정한다. 의존 별칭은 최상위 resources에 고정 참조가 일치해야 하고 순환은 거절한다. 본문·이용 조건·목록 밖 파일·바뀐 템플릿을 검사한다.

Skill의 진입점은 루트 SKILL.md이며, scripts/references/assets 상대 위치를 보존한다. 자료 ZIP은 workflow.json이나 실행 진입점을 만들지 않는다. native Skill 사본도 고정한 원본과 대조한다. 연결 정의 자료를 가져오는 것만으로 MCP 서버를 시작하지 않는다.

워크플로 ZIP의 호스트 연결 파일은 검증된 Studio Bridge 템플릿과 일치해야 한다. 허용되지 않은 호스트 설정을 추가하거나 명령을 교체한 패키지는 가져오기를 거절한다. 이 검사는 Studio 패키지에 대한 검사이며, 호스트의 별도 도구 행동 전체를 통제한다는 의미가 아니다.

## ZIP

packageKind=workflow|materials, purpose=production, targetHost=codex|claude-code|opencode. workflow 패키지는 workflow.json/editor.json/manifest.json/runtime.lock.json/README.ko.md/resources 및 호스트 파일이다. 공식/공개 배포는 manifest.sig를 포함한다. 개인 미서명 패키지는 출처 미확인으로 구분한다.

manifest는 규격/배포ID/버전/종류/목적/호스트/entrypoint/capabilities/compatibility/requestedPermissions/requiredConnections/resources/indexes/files/createdAt. files는 원본 바이트 크기와 SHA256이며 manifest.json과 manifest.sig 자신은 제외한다. 모든 다른 파일은 목록에 있어야 한다. 필요한 capability는 내용에서 계산·대조한다. compatibility의 지원 범위와 실제 검증 버전을 구분한다.

runtime.lock에는 실제 구성요소/Worker/의존성/도구스키마/색인형식/모델 검증 정보와 호스트 버전을 기록한다. 확인하지 않은 버전이나 모델 고정성을 만들어 쓰지 않는다. 개발 런타임을 사용자가 설치하지 않도록 Runner 설치물에 포함한다.

현재 개인 패키지는 runtime-lock.schema.json의 kind=requirements 계약을 사용한다. 워크플로 JCS hash·고정 Runner/Node 요구 버전·계산된 capability·모델 요구 선언·대상 호스트를 검사하며 실제 호스트/모델 검증은 unverified로 고정한다. 가져올 때 이 전체 값이 현재 workflow에서 계산한 값과 일치해야 한다. 이는 요구 목록이며 실제 설치 binary/tool/index 해시까지 갖춘 공식 배포 lock을 대신하지 않는다. 해당 완전한 resolved lock 형식과 공식 서명은 남은 출시 작업이다.

자료 ZIP의 native Skill 폴더는 자료 별칭이 아닌 검증한 SKILL.md frontmatter name과 일치한다. name/description 및 제한된 설명 메타데이터를 읽고 이름 충돌·중복 YAML 키·alias·권한 사전 승인 필드를 거부한다. 이는 [Agent Skills 규격](https://agentskills.io/specification)에 맞춘 portable 이름 처리와 이 제품의 보수적 메타데이터 정책이다. 외부 호스트의 실행 권한을 Studio Runner가 대신 통제하지는 않는다.

서명은 Ed25519, 입력은 UTF8 "AI-WORKFLOW-STUDIO/PACKAGE/1\n" + RFC8785 JCS(manifest). 개별 파일 해시는 재직렬화하지 않은 바이트다. 신뢰키는 ZIP 밖에 있다. 서명이 안전성·승인을 뜻하지 않는다.

경로는 NFC 상대 / 경로. 절대/드라이브/UNC/../역슬래시/NUL/제어문자/ADS/Windows예약이름/끝점·공백/대소문자·정규화충돌/링크/암호화ZIP 거부. 실제 해제 중 바이트 수를 센다. 초기 한도 10000파일, 단일128MiB, 합512MiB, 비율100, manifest4MiB. 새 staging 검사 후 확정하며 기존 파일을 덮어쓰지 않는다.

Windows 8.3 형태의 짧은 이름 별칭도 거부하고 Unicode 대문자/소문자 형태를 보수적으로 묶어 충돌 검사한다. [Microsoft 파일 이름 문서](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)에 설명된 짧은 별칭과 대소문자 처리 때문에 같은 파일로 해석될 수 있는 항목을 함께 배포하지 않는다.

호스트 파일: Codex AGENTS.md/.agents/skills/.codex/config.toml; Claude Code CLAUDE.md/.claude/skills/.mcp.json; OpenCode AGENTS.md/.opencode/skills/opencode.json. 설치된 studio-bridge를 사용하고 작성자 절대 경로·npx latest·권한 우회 플래그를 넣지 않는다. Bridge 초기화는 협상만 하고 명시 start 전 외부 작업/모델/예약을 실행하지 않는다.

색인은 rebuild(배포 원문/설정으로 수신 환경 생성) 또는 bundled(권리·원문근거·형식 검증된 고정 색인). 개인 ACL·토큰·승인·실행 이력은 배포하지 않는다. SKILL.md/scripts/references/assets는 운영 내용이며 내부 fixture/verification.spec.json/dev 서버는 제외한다.
