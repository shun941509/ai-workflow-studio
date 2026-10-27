# Windows 격리 helper — 실제 검증과 남은 경계

상태: **부분 구현·부분 검증**. LPAC/Job Object의 네이티브 경계 시험은 통과했다. **Node 24 zero-capability Worker는 시작 실패하며 운영 지원 대상이 아니다.** 이 helper는 Runner capability나 ZIP 배포 목록에 연결하지 않는다. 진단 프로필 성공으로 P3-01 완료를 표시하지 않는다.

## 구성과 실행

프로젝트의 주 언어는 TypeScript다. Windows 보안 호출만 `native/windows-sandbox/SandboxHost.cs`의 C# P/Invoke helper가 담당한다. 테스트 전용 C probe는 Windows API 호출의 실제 결과를 확인하고, 별도 JS fixture는 고정 Node 24.22.1의 호환성을 검사한다.

`tooling/verify-windows-sandbox.mjs`는 Windows에서 helper 두 종류와 C probe를 빌드한다. 필요한 도구는 .NET Framework C# compiler, 로컬 MSVC 14.40.33807, Windows SDK 10.0.22000.0, `.tools/node/node-v24.22.1-win-x64/node.exe`다. 다른 기계에서 같은 도구가 없으면 명시적으로 실패하며 통과로 처리하지 않는다.

```powershell
& '.tools/node/node-v24.22.1-win-x64/node.exe' tooling/verify-windows-sandbox.mjs
& '.tools/node/node-v24.22.1-win-x64/node.exe' tooling/verify-windows-sandbox.mjs --require-node
& '.tools/node/node-v24.22.1-win-x64/node.exe' node_modules/vitest/vitest.mjs run tests/security/windows-sandbox.test.ts
```

첫 명령은 네이티브 시험이 통과하면 종료0이고, JSON의 overall status는 Node 상태를 반영해 partial이다. `--require-node`는 zero-capability Node가 실패하면 종료1이다. 테스트 1개 통과를 Node Worker 운영 지원으로 해석하지 않는다. 최신 원시 증거는 `.tools/windows-sandbox/latest-verification.json`에 보존하고, 매번 소스 SHA-256·시각·OS·Node 버전을 기록한다.

## 실제 적용한 경계

- 작업마다 고유 `StudioIsolationTest.<UUID>` AppContainer profile을 만들고 finally에서 삭제한다. 기존 profile은 재사용하지 않는다.
- SECURITY_CAPABILITIES와 ALL_APPLICATION_PACKAGES opt-out으로 LPAC를 만든다. 기본 바이너리는 capability 0개다. 네트워크·COM·일반 파일 capability를 추가하지 않는다.
- helper 옆 `.tools/windows-sandbox/run-<UUID>`의 새 staging만 ACL을 바꾼다. 상위 폴더·개인 파일·기존 window station/desktop·전역 레지스트리는 수정하지 않는다.
- `bin`과 `input`은 package SID에 읽기/실행, `output`만 Modify를 준다. outside canary에는 SID 권한을 주지 않는다. output에 Low Integrity label을 부여한다.
- 새로운 private desktop에만 최소 SID 권한을 주고 Job UI 제한을 설정한다. 사용자 데스크톱으로 전환하지 않는다. 기존 window station ACL을 넓히지 않는다.
- 프로세스를 suspended 상태로 생성하고 Job에 넣고 AppContainer 토큰을 확인한 다음 resume한다. 활성 프로세스1, 자식 생성 제한, 메모리·CPU 시간·kill-on-close를 설정한다. breakaway를 허용하지 않는다.
- wall-time 초과는 helper 소유의 유일한 Job handle을 닫는다. 실제 자식이 종료되는지 확인한다. 종료코드0이어도 timeout 상태를 우선하여 성공으로 해석하지 않는다.
- 셸을 쓰지 않고 고정 executable·고정 파일 경로·숫자 한도를 전달한다. API 키·사용자 환경은 넘기지 않는다. 새 stdout/stderr 파일 handle 두 개만 명시적 handle list로 상속한다.
- 실행 전 모든 경로 component와 staging의 reparse point/junction/hard link를 거부한다. 종료 후 output도 다시 검사한다. 검사 한도는 깊이32, 10000개 entry, 총512MiB다. 이는 실행 중 디스크 쓰기 quota를 대체하지 않는다.

## Windows 10.0.26200의 관찰 결과

| 항목 | 기본 zero-capability LPAC | 판정 |
| --- | --- | --- |
| 입력 읽기 / output 쓰기 | 실제 파일 내용 확인 성공 | confirmed |
| 입력 수정 / outside 새 파일 쓰기 | ERROR_ACCESS_DENIED(5) | confirmed |
| outside canary 읽기 | ERROR_ACCESS_DENIED(5) | confirmed |
| ALL_APPLICATION_PACKAGES만 허용한 canary 읽기 | ERROR_ACCESS_DENIED(5) | LPAC opt-out 동작 confirmed |
| 자식 CreateProcess | ERROR_CHILD_PROCESS_BLOCKED(367) | confirmed |
| 500ms wall-time | Job handle 닫기 후 작업 종료, 후속 쓰기 없음 | kill-on-close confirmed |
| CPU 200ms quota | STATUS_QUOTA_EXCEEDED(0xC0000044), wall timeout 아님 | confirmed; OS sampling 때문에 실제 벽시계는 수초일 수 있음 |
| Job 128MiB | 120MiB 추가 할당 후 ERROR_COMMITMENT_LIMIT(1455), peak<128MiB | confirmed |
| 입력 junction / hard link | 프로필·프로세스 생성 전에 거부 | confirmed |
| loopback socket | Winsock 초기화 10107 | 네트워크 연결 정책 자체의 성공 증거로 세지 않음 |
| Node 24.22.1 | WSAStartup10107 후 시작 실패 | failed, 운영 지원 불가 |
| 정상/오류 처리 profile 삭제 | DeleteAppContainerProfile 성공 | confirmed; 강제 host crash의 후속 청소는 별도 미구현 |

loopback은 부모가 먼저 연결에 성공한 로컬 listener를 대상으로 한다. 타임아웃·ECONNREFUSED를 네트워크 차단의 증거로 인정하지 않는다.

## registryRead 진단과 개인정보 경계

`STUDIO_SANDBOX_DIAGNOSTICS`를 지정한 별도 `SandboxHost.Diagnostics.exe`에만 registryRead derivation을 컴파일한다. 일반 `SandboxHost.exe`는 진단 인수를 시작 시 거부하며 이 capability의 derivation 코드를 포함하지 않는다. 두 파일 모두 현재 배포하지 않는다.

이 진단 프로필에서도 network capability는 0개다. Winsock 초기화가 성공하고 살아 있는 loopback listener 연결은 **WSAEACCES(10013)**로 거부됐다. 파일·자식 경계는 유지됐다. Node는 DETACHED_PROCESS와 preserve-symlinks/main 옵션을 사용하면 JS probe까지 실행할 수 있었다. 이 옵션은 staging의 링크 사전 차단 후, Node가 `C:\`와 모든 부모 경로의 realpath를 불필요하게 조회하지 않도록 쓰며 상위 폴더 ACL을 변경하지 않는다.

그러나 registryRead는 이번 기계에서 사용자 레지스트리 경계도 넓혔다. probe는 다음 키를 KEY_READ로 여는 성공/실패만 확인했으며 값 조회·열거·내용 기록은 하지 않았다.

| 키 handle 검사 | 기본 LPAC | registryRead 진단 |
| --- | --- | --- |
| HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion | 거부5 | 성공0 |
| HKCU\Software | 거부5 | 성공0 |
| HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer | 거부5 | 성공0 |

이 세 표본은 모든 hive·WOW64 view·private store·인증정보 접근 범위의 증명이 아니다. **사용자 hive까지 열리는 진단 프로필은 운영 프로필로 허용하지 않는다.** 네트워크 진단 통과와 Node 진단 실행은 zero-capability Node 준비 상태를 바꾸지 않는다.

## 실패 진단에서 제외한 우회

처음에는 LOCALAPPDATA를 빠뜨려 CreateProcess가 203으로 실패했다. 비밀 없는 OS 경로를 명시하고 Windows가 AppContainer 전용 profile로 연결하도록 처리했다. 사용자 profile/TEMP용 경로는 출력 영역으로 제한한다. AppContainer 자체의 private profile 저장소는 OS가 생성·관리하므로 output 이외에는 세계 어느 경로에도 쓰지 못한다고 주장하지 않는다.

Console subsystem과 CREATE_NO_WINDOW 조합은 0xC0000142로 실패했다. Microsoft 참고 도구의 전역 LowBoxConsoleEnabled 변경은 적용하지 않았다. 네이티브 probe는 Windows subsystem, Node는 DETACHED_PROCESS로 원인을 분리했다. 이름 있는 새 window station 생성은 권한5, OS 기본 이름은 충돌183이었으며 기존 station을 재사용하거나 ACL을 변경하지 않았다. 최종 helper는 새 private desktop만 사용한다.

## 운영 연결 전 남은 작업

1. **Node Worker 차단 해소**: 사용자 registry 읽기 권한을 추가하지 않는 실행 엔진/런타임 설계가 필요하다. 현재 Node를 capability로 광고하거나 스크립트 Skill/program을 활성화하지 않는다.
2. 실제 패키지 해시·고정 Worker profile·실행 정책을 helper 입력에 연결하고, 신뢰된 staging 생성·code 검증·권한 결정을 Runner가 수행해야 한다. 현재 helper는 내부 검증 전용이다.
3. 입력/출력 artifact 목록, 결과 수집의 TOCTOU 경계, 지속적인 디스크/output quota, host crash의 orphan profile 정리, 감사 이벤트·취소·서명된 배포물은 미구현이다.
4. 기본 OS 파일·장치·레지스트리 전체, IPv6/외부 네트워크·DNS·named pipe·COM·다른 프로세스/토큰·UI 경계의 적대적 시험과 다른 Windows 버전 회귀가 더 필요하다. 특정 canary의 거부를 전체 OS 공격면 검증으로 확장하지 않는다.
5. AppContainer private profile 저장소는 입력/출력 폴더와 다른 OS 관리 영역이다. profile 생명주기·잔여 저장소·설치/업데이트·서명 검증을 정식 제품 규격으로 마무리해야 한다.

## 참고한 1차 자료

LPAC 생성과 capability 동작은 [Microsoft AppContainer 실행 문서](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)를 기준으로 했다. [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)은 파일·네트워크·프로세스 등의 경계를 설명한다. 참고 구현은 [Microsoft SandboxSecurityTools의 LaunchAppContainer](https://github.com/microsoft/SandboxSecurityTools/blob/main/LaunchAppContainer/LaunchAppContainer/LaunchAppContainer.cpp)이며, 그 도구의 전역 레지스트리 변경은 사용하지 않았다.

프로세스 속성은 [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), Job 제한은 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), 새 desktop의 권한은 [CreateDesktopW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createdesktopw)와 [Desktop access rights](https://learn.microsoft.com/en-us/windows/win32/winstation/desktop-security-and-access-rights)를 확인했다. 문서의 일반 보장과 이 저장소에서 실제로 실행한 표본 시험을 위 표에서 구분했다.
