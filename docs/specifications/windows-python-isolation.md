# Python 임베디드 런타임의 Windows LPAC 실증

상태: **실행 호환성 실패, 운영 Worker 미지원**. Windows 10.0.26200에서 공식 CPython 3.14.10 amd64 임베디드 실행 파일은 zero-capability LPAC의 본문 실행 전에 `STATUS_ACCESS_DENIED(0xC0000022)`로 종료했다. Python에서 입력/출력·자식 생성·자원 한도를 검사하는 probe에 도달하지 못했으므로 이 항목은 검증 완료로 세지 않는다. 기존 Node 24.22.1의 zero-capability Winsock 시작 실패도 그대로 남는다.

## 고정 배포물

| 항목 | 값 |
|---|---|
| 버전/플랫폼 | CPython 3.14.10, Windows amd64 embeddable |
| 출처 | [Python 공식 3.14.10 릴리스](https://www.python.org/downloads/release/python-31410/) |
| 파일 | `python-3.14.10-embed-amd64.zip` |
| 공식 SHA-256 | `90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159` |
| 압축 해제 파일 수 | 37 |
| LICENSE.txt SHA-256 | `935cf13e19f8c31b497d20b05d73623431a226b230c3599bc30fa3348979bc68` |
| 이용조건 | PSF License Version 2 및 배포물에 포함된 구성요소 이용조건; LICENSE.txt 원본 전체 보존 |

[공식 임베디드 배포 설명](https://docs.python.org/3.14/using/windows.html#the-embeddable-package)에 따라 기본 `python314._pth`를 그대로 사용한다. [Python 라이선스 문서](https://docs.python.org/3.14/license.html)는 포함된 다른 구성요소의 이용조건도 구분한다. 이 실험은 바이너리·라이선스 파일을 수정하거나 외부 배포하지 않는다.

`tooling/prepare-windows-python.mjs`는 공식 URL에서 고정 ZIP을 받아 **압축 해제 전에 공식 SHA-256을 비교**한다. `.tools/python/` 아래에만 저장하고 재사용 시 전체 파일 목록과 원본 바이트 해시를 비교한다. 링크 경로·하드링크 파일·다른 파일 목록·변경된 파일은 거절한다. pip/설치 프로그램/PATH/파일 연결/전역 레지스트리를 사용하지 않는다. 준비는 명시적 별도 명령이며 검증기는 자동 다운로드를 하지 않는다.

## 실행과 증거

```powershell
& '.tools/node/node-v24.22.1-win-x64/node.exe' tooling/prepare-windows-python.mjs
& '.tools/node/node-v24.22.1-win-x64/node.exe' tooling/verify-windows-python-sandbox.mjs
& '.tools/node/node-v24.22.1-win-x64/node.exe' node_modules/vitest/vitest.mjs run tests/security/windows-python-sandbox.test.ts
```

두 번째 명령은 현재 **종료 코드 1**이며 `.tools/windows-python-sandbox/latest-verification.json`에 실패 증거를 남긴다. 세 번째 명령은 실패가 지원 완료로 승격되지 않음을 검증하는 회귀 시험이다. 회귀 시험 통과와 Python 실행 성공은 다른 상태이다. CI는 첫 준비 명령과 Windows .NET Framework C# compiler가 필요하고, 로더 실패 진단에는 MSVC 14.40.33807·Windows SDK 10.0.22000.0이 필요하다. 준비 누락·컴파일 오류는 성공/skip으로 처리하지 않는다.

`native/windows-sandbox/SandboxHost.cs`에 고정 `python-embed` 프로필을 추가했다. 이 프로필은 진단 바이너리라도 registryRead 옵션을 거절한다. 고정 명령은 staged `python.exe -I -S -B <worker.py> <request.json>`이다. 사용자 Python 환경·site hook·bytecode 쓰기를 허용하지 않는다. 기존 LPAC, 새 private desktop, Job, 명시적 handle 상속, fresh staging ACL 규칙을 유지한다. 기존 node/native-probe 프로필은 그대로 지원하며 필요한 staging 파일을 각 프로필별로 검사한다.

모든 실험용 파일은 `.tools/windows-python-sandbox/run-<UUID>` 안에 만들고 helper만 해당 폴더 ACL을 변경한다. 라이선스를 포함한 원본 배포물 37개 파일을 매번 새 `bin`으로 복사한다. 각 실행의 임시 AppContainer profile은 finally에서 삭제하고 증거 폴더는 보존한다. 전역 ACL, 사용자 레지스트리, 기존 프로필, 기존 데스크톱 권한을 변경하지 않는다.

## 실제 관찰

| 항목 | 관찰 | 의미 |
|---|---|---|
| 일반 환경 Python 시작 | 3.14.10 버전 출력 성공 | 배포물의 기본 실행 가능성 확인 |
| LPAC Python 시작 | `0xC0000022`, stdout/stderr 비어 있음, worker report 없음 | Python 코드 실행 실패 |
| LPAC·Job 설정 | AppContainer true, LPAC opt-out true, capability 0, network capability 0 | helper가 요청한 제한 적용 |
| profile 정리 | profileDeleted true | 관찰 실행들의 정상 정리 |
| native loader probe | 시작/보고 성공 | Python을 실행하지 않는 별도 진단 |
| python314.dll 읽기 | Win32 0 | staged DLL을 일반 파일로 읽을 수 있음 |
| python314.dll 이미지 매핑 | DONT_RESOLVE_DLL_REFERENCES로 0 | 의존성 해결·진입점 실행 없는 매핑 성공 |
| vcruntime140 및 OS 의존성 | 개별 load 성공 | 조사한 DLL은 개별 로딩 가능 |
| python314.dll 일반 load | Win32 5 | 의존성 해결/초기화가 필요한 로딩 단계는 실패 |
| 의존 DLL 선로딩 유지 | Python DLL 실패 유지 | 선로딩만으로 해결되지 않음 |
| Python 파일/자식/CPU/메모리/네트워크 probe | 미도달 | 지원 증거 없음 |

추가 진단은 `tests/security/windows-python-loader.probe.c`의 CRT 없는 네이티브 probe이다. 특정 OS DLL과 staged Python DLL만 로딩하고 API 반환 코드만 기록한다. Python DLL의 정확한 실패 내부 원인은 아직 확정하지 않았다. 파일 읽기 성공을 실행 성공으로 해석하지 않는다.

## 다음 단계와 경계

1. 권한을 넓히지 않는 원인 진단이 더 필요하다. registryRead나 외부 파일 ACL을 추가해 이 실행을 성공 처리하지 않는다.
2. Python이 시작된 후에야 준비된 실제 파일 canary, 자식 생성, wall/CPU/memory, junction/hardlink, 살아 있는 로컬 listener 시험을 수행할 수 있다. socket 초기화 실패와 실제 연결의 접근 거부를 구분한다.
3. 이 표본 시험이 성공해도 Runner의 패키지 해시 검증·신뢰된 staging·작업 취소·artifact 수집·지속 output quota·고아 profile 복구·서명/배포·전체 OS 공격면 검증은 별도 작업이다.
4. 현재 UI/ZIP/capability 목록에 Python Worker나 일반 코드 실행 지원을 추가하지 않는다. 실험용 probe와 준비 도구는 운영 ZIP에 포함하지 않는다.
