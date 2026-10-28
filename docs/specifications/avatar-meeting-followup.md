# R-06 회의 후속 업무 보충 예제

대상은 `catalog/supplemental/avatar-meeting-followup`이다. 공식 프로젝트 120개·자료 120개 목록과 집계를 변경하지 않는다. 한 회의의 TXT/Markdown **본문**을 받아 명시적 후속 업무 초안을 만들며, 계정 연결·모델 품질·실제 호스트 사용은 별도 검증 대상이다.

## 실제 구성

| 업무 요소 | 고정한 내용 |
| --- | --- |
| Card | 회의 업무 파트너 |
| Role | 원문에 근거해 결정과 제안을 구분하는 후속 정리 담당 |
| Task | 사용자 원문 대조 수락 후에만 관리 파일로 전달하는 초안 작성 |
| WorkAssets | 원작 판단 지침 `judgment`, 출력 규약 `template`, 지침 Skill `procedure` |
| Harness | 입력 → Agent 1회 → 규칙 → 루트 사용자 검토 → 수락 조건 → 관리 파일 → 결과 |
| AgentCapabilities | `task`, `maxSteps=1`, 도구 목록 없음, 실제 JSON 응답 모델 요구 |

각 자료는 별도 `resource.json`, 원본 파일, MIT 이용 조건을 갖는다. 지침은 명시적 instructions, 문서는 낮은 신뢰 reference, Skill은 명시적 skill 첨부다. Task의 template 용도는 문서의 업무상 용도이고 현재 Runner의 reference 첨부 역할을 바꾸지 않는다. `selectedContext`의 세 별칭과 실제 첨부를 맞춘다. 실행 manifest를 만든 것으로 주장하지 않는다.

루트 그래프의 실제 ID는 다음과 같다.

```text
source → draft → checks → review_packet → review
review.accepted → accepted_packet → release_gate.true → deliver_file → result → finish
review.rejected → result
release_gate.false → result
```

`release_gate`는 앞선 규칙 통과, review decision=accepted, evidenceVerified=true, unknownsPreserved=true를 모두 요구한다. `file_output`은 Runner 관리 outputs에 JSON만 만든다. 반려 경로와 조건 실패 경로에는 파일 블록이 실행되지 않는다. 결과 merge는 원래 초안·검사·검토를 보존하고 생성된 파일만 선택적으로 포함한다.

## 완료 기준과 정직한 제한

세 완료 기준은 `checks` 평가 통과, `review` 사용자 수락, 필수 확인 값과 실제 관리 FileRef를 포함한 최종 결과 구조다. 어느 하나라도 없으면 업무 미충족이다. 실행이 성공했다고 후속 작업 자체가 수행됐다고 표시하지 않는다. 미실행 검토나 파일 생성 실패도 성공으로 바꾸지 않는다.

현재 결정 규칙 언어에는 문자열 부분 일치·전체 항목 인용 검사가 없다. 따라서 자동 규칙이 원문 인용의 진실성을 증명했다고 주장하지 않는다. Agent resultSchema는 각 action의 비어 있지 않은 evidenceQuote와 담당자·기한·누락 필드를 강제하며, 실제 원문 대응·의미·누락 판단은 사용자가 전 항목을 확인한다. 담당자·기한 null/unknown/missing의 의미 일치도 검토 항목이다. 사용자가 확인 값을 거짓으로 제출한 사실을 이 예제가 자동 판별하지는 못한다.

근거 부족의 정상 모델 응답은 `status=insufficient_evidence`, `actions=[]`와 구체적인 limits다. 이후 사용자가 수락하더라도 `checks.passed=false`이므로 파일을 만들지 않는다. 원문에 없는 후속 작업·담당자·기한을 만들어 채우거나 외부 시스템에서 확인한 것으로 표현하면 검토에서 반려한다.

## 검증 계획과 현재 상태

생성기 `tooling/catalog/materialize-avatar-meeting-followup.ts`는 쓰기 전 Schema/core·가상 입력·자료 descriptor를 검사하고 Codex·Claude Code·OpenCode ZIP을 실제 생성·재검사한다. 기존 폴더의 내용이 다르면 덮어쓰지 않고, 동일 바이트만 복구할 수 있다. 실행 결과·provider 대역·검증 fixture는 운영 자료 폴더에 넣지 않는다.

현재 confirmed: 신규 14개 원본 파일 생성, 선언·그래프·자료 원본 해시, 가상 입력 스키마, 3종 워크플로 ZIP과 별도 3종 자료 ZIP 무결성 검사, 생성기와 전용 시험의 strict 타입 검사. `tests/catalog/avatar-meeting-followup.test.ts`로 다음 전용 회귀를 실행했다.

- 실제 기본 Runner의 모델 미연결 준비 차단 및 모델 호출 0회 확인.
- tests 안의 명시적 provider 대역으로만 Agent 호출 1회, 도구 0개, 원문과 세 첨부의 중복 없는 전달 확인. 원작 지침·Skill 본문은 instructions, template은 낮은 신뢰 참고 데이터로 유지된다. 토큰 확인 요청과 생성 요청 내용도 같다.
- 실제 SQLite/관리 파일 처리와 review 대기로 수락/반려/근거 부족/확인 값 false 경로 확인.
- 수락 경로의 정확한 파일 본문, 재시작 후 원본 유지, 중복 검토가 모델·파일을 다시 실행하지 않는지 확인. 같은 응답 ID로 다른 내용을 제출하면 거절한다.
- 규칙 실패와 사람 수락을 구분하고 최종 outcome이 incomplete인지 확인. insufficient 상태를 수락해도 파일이 없다.
- 입력·응답 형식 오류와 취소를 성공으로 바꾸지 않으며, 취소된 검토를 재시작 후 수락할 수 없음을 확인.
- 운영 자료 경로·원본 바이트에 테스트 대역·개발 설치·테스트 키가 없음을 검사하고, 실제 모델 출력은 동봉하지 않음.

워크플로 ZIP에는 Studio Bridge용 Skill과 canonical `resources/procedure/SKILL.md`가 들어간다. Task Skill을 호스트 native 경로에 별도로 넣어 Runner 검토·파일 경로를 우회하지 않는다. 독립 자료 ZIP에는 호스트별 native Skill 사본을 만들고 원본과 같은 바이트임을 검사한다. 자료 ZIP 자체는 실행 워크플로나 이 예제의 업무 완료 보장을 제공하지 않는다.

2026-10-28 전용 기록: 18개 시험 통과(최종 9.84초), 같은 시험 및 생성기 진입점의 strict TypeScript 검사 통과. 최종 결과를 얻기 위해 실제 계정·키·외부 모델 호출을 수행하지 않았다. 원작 가상 입력을 사용하는 모델 대역은 tests 안에만 있으며 운영 payload·정식 품질 검증 증거에 포함하지 않는다.

아직 unverified: 실제 모델 답변 품질, 실제 Codex·Claude Code·OpenCode 사용, 외부 계정 연결·검수·게시. R-07 실행 문맥 manifest와 실제 소비 연결 전에는 Avatar 수직 기능 상태를 partial로 유지한다. 내부 provider 대역 시험의 성공은 실제 모델 품질을 확인한 증거가 아니다.
