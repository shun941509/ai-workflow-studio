# 제품 전체 출시 검사

`check:catalog`는 240개 설계 항목·자료 무결성 검사다. `check:catalog-release`는 검증·게시된 프로젝트120/자료120 및 실제 호스트 사용 증거를 요구한다. `check:release`는 여기에 아래13개 제품 증거를 모두 요구하며 자료 수량만으로 성공하지 않는다.

1. 31개 블록·공개 모드·취소·복구
2. RAG 검색·재정렬·GraphRAG·인용·현재 ACL·삭제
3. 실제 Worker 시작과 파일·네트워크·자식·자원·개인 레지스트리 격리
4. 실제 계정·DB·Storage·충돌·보존/삭제
5. 개발 도구 없는 Windows 설치·경로·재시작·업데이트/복구
6. Codex 실제 버전·시작·결과·재접속
7. Claude Code 같은 경로
8. OpenCode 같은 경로
9. 실제 모델·구조화 출력·사용량·인증/한도 오류·불명 호출 처리
10. 3종 운영 ZIP·경로/링크/압축 폭탄·해시·서명·비밀/개발 파일 제외
11. 검수/게시·신고/철회·DB와 Storage 복원·운영 큐
12. 설치물/패키지 서명·키 교체/철회·SBOM/취약점·실제 번들 구성요소의 원본 라이선스/고지 완전성(`license-notices-complete`)
13. 키보드 편집·오류 안내·저장 복구·실제 자료 소비

## 증거 계약

`tooling/release/check-gates.ts`의 RELEASE_CHECKS는 필수 관측 이름을 고정한다. 각 증거에는 releaseId, source/runner/web/catalog의 원본 SHA-256, 관측·만료 UTC, 실제 환경 버전, 모든 필수 검사의 actual/passed 결과, 해시가 고정된 상세 보고서, Ed25519 서명이 필요하다. 관측 유효기간은 최대30일이며 수정한 산출물에는 새 증거가 필요하다.

서명 입력은 UTF8 `AI-WORKFLOW-STUDIO/RELEASE-EVIDENCE/1\n` + 서명 필드를 뺀 RFC8785 canonical JSON이다. 검증키는 증거 밖의 운영자 신뢰 목록이며 키별로 허용 gate를 제한한다. catalogue 검증키는 `gates`에 `catalog`가 있어야 한다. 테스트 생성 키는 테스트 밖에 저장하거나 운영 신뢰 목록으로 올리지 않는다.

증거 번들 형식은 `{releaseId, capabilities:string[], records:ReleaseEvidence[]}`이고 신뢰 목록은 `{keyId:{publicKey:PEM,gates:[...]}}`이다. 실제 배포 후보의 source/runner/web archive를 전달하며 검사기는 직접 바이트 해시를 계산한다. CLI가 검사하는 것은 지정한 후보 묶음이며 현재 checkout에 관한 증거로 자동 전환하지 않는다. source archive가 어떤 checkout에서 만들어졌는지와 capabilities가 실제 runtime과 일치하는지는 신뢰한 검증자의 보고서·서명 책임이며 문자열 선언만으로 실증을 만들어 주지 않는다.

```sh
pnpm check:release --evidence <bundle.json> --trusted-keys <operator-trust.json> --source-archive <source.zip> --runner-archive <runner.zip> --web-archive <web.zip> --report-root <reports-directory>
```

인수가 없거나 하나라도 증거가 부족하면 releaseReady=false와 누락 목록, 종료 코드1을 반환한다. 검사는 실행·서명·게시·증거 생성을 하지 않는다. 현재 저장소의 실제 출시 검사는 정상적으로 차단된다. 내부 테스트에서 모든 gate를 채운 서명 예시는 검증기 알고리즘 시험일 뿐, 실제 출시 증거로 집계하지 않는다.
