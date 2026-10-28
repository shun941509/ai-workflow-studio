# Wasmtime의 Windows LPAC 실증

2026-10-28, Windows 10.0.26200 x64: **엔진 시작과 제한된 WASI 파일·메모리·실행량 시험 통과, 운영 Worker는 미지원**. Node/Python의 시작 실패를 숨기거나 registryRead 권한을 추가하지 않고 별도의 엔진을 조사했다. `program`/실행 Skill capability와 사용자 ZIP에는 아직 연결하지 않는다.

## 고정 런타임

- Wasmtime 50.0.0 x86_64-windows ZIP, [공식 릴리스](https://github.com/bytecodealliance/wasmtime/releases/tag/v50.0.0).
- [공식 GitHub release API](https://api.github.com/repos/bytecodealliance/wasmtime/releases/tags/v50.0.0)의 해당 ZIP digest: `cea9ccc700aaccb2b5507e96ac990ba60104bd7ab39284fb2e67cb64d58efcc4`.
- 실행 파일 SHA256 `351594645924ea67ed5c1e04ae2d9d87cd1b90efcc475ba914b421069526a1f1`, LICENSE SHA256 `268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5`.
- `tooling/prepare-windows-wasmtime.mjs`가 압축 해제 전 digest를 확인한다. 공식 원본 4파일을 `.tools/wasmtime`에 보존하고 재사용 때 파일 목록·해시·링크를 재검사한다. 설치 프로그램·전역 PATH·레지스트리를 변경하지 않는다.
- 캐시 ZIP도 다운로드와 같은 32MiB 한도를 적용한다. 추출 파일은 원본 아카이브의 정확한 크기를 먼저 확인한다. ordinary/nlink/ancestor 검사 뒤 열린 FileHandle을 64KiB 단위로 읽으며, 읽는 중 성장·크기/시간/파일 정체성 변경을 거절한다. 검증 전 무제한 `readFile`을 하지 않는다.

## 고정 실행 프로필

기존 LPAC helper의 새 `wasmtime` 프로필을 사용한다. capability는 0개이며 진단 capability 입력도 거절한다. suspended 시작→Job 배치→토큰 확인→resume, 새 private desktop, 명시적 두 출력 handle, 새 staging ACL과 profile 정리를 유지한다.

실제 CLI의 `run --help`, `-W help`, `-S help`, `-C help`를 확인하여 설정했다. 컴파일 cache와 병렬 컴파일을 끄고, fuel 1천만·linear memory 16MiB·instance/memory/table 수를 제한했다. 환경과 stdin 상속, network 상속·DNS·TCP·UDP·HTTP·NN·keyvalue·config·threads를 끈다. 입력과 출력 두 디렉터리만 preopen한다. precompiled native 입력 허용 옵션과 unsafe intrinsics는 제공하지 않는다. [CLI 설명](https://docs.wasmtime.dev/cli-options.html), [Wasm/WASI 보안 경계](https://docs.wasmtime.dev/security.html).

입력은 WASI 경로와 별개로 OS ACL도 읽기 전용이다. 이 실험은 WAT 텍스트를 사용하며 사용자에게 컴파일 도구 설치를 요구하거나 일반 Python/JavaScript 실행을 지원한다고 표시하지 않는다.

## 실제 결과

|시험|관찰|범위|
|---|---|---|
|엔진 시작|exit 0, capability 0, LPAC true|이 OS·고정 엔진 조합|
|입력 읽기|13바이트 `sandbox input` 일치|허용된 staging 파일|
|출력 쓰기|14바이트 `sandbox output` 일치|허용된 staging 파일|
|입력 변경·삭제|WASI errno 2(접근 거부), 원본 유지|OS 읽기 ACL|
|상대 경로 이탈·절대 경로·AAP canary 경로|errno 63, outside 원본 유지|preopen 경로 경계; native AAP 직접 접근 시험과 구분|
|guest 환경|변수 수0·바이트0|부모 환경 상속 없음|
|16MiB 초과 memory.grow|반환 -1|Wasm linear memory; 전체 프로세스 RSS와 구분|
|무한 루프|fuel trap, exit3, wall timeout 아님|Wasm 명령 실행량 제한|
|등록되지 않은 spawn import|인스턴스 생성 실패|임의 native import 없음|
|미상 socket descriptor|BADF|실제 연결 차단 증거는 아님|
|junction·hardlink|시작 전 거절|staging 검사|
|registryRead 지정|시작 전 거절|진단 우회 없음|
|stdio 프로필 입력·출력|실제 JSON 12바이트 일치, fd3 preopen 없음|WASI 경로 접근 없이 stdin/stdout만|
|stdout 연속 출력|실행 중 상한 초과 감지→Job 종료, 저장1MiB|bounded pipe로 디스크 기록 전 제한|
|stderr 연속 출력|실행 중 상한 초과 감지→Job 종료, 저장64KiB|stdout과 독립 제한|
|stdin 1MiB 초과|프로세스 시작 전 거절|입력 바이트 한도|
|WASI clock 대기|started 출력 뒤 1초 wall deadline→Job 종료|fuel이 세지 않는 blocking hostcall도 중단|
|부모 결과 핸들 잠금|실행 중 같은 사용자에 의한 output rename·stdout 덮어쓰기 거부, 비교용 일반 파일 쓰기 성공|열려 있는 부모 핸들의 효과이며 전체 TOCTOU 무결성 증거는 아님|

원시 증거는 `.tools/windows-wasmtime-sandbox/latest-verification.json`에 남긴다. 실제 루트·엔진/소스 해시·시각·출력·종료 상태를 기록한다. profile 삭제는 관찰한 실행에서 성공했다.

별도 `wasmtime-stdio` 프로필은 디렉터리 preopen과 component model을 끈다. 상속 handle은 읽기 전용 stdin과 stdout/stderr 익명 pipe뿐이다. 부모는 pipe를 메모리의 고정 한도까지 수집하고 초과하면 읽기를 멈춰 backpressure를 걸며 Job을 닫는다. 자식 종료 이후에만 한도 내 바이트를 기록한다. 초과 시 종료코드가 0이어도 `outputLimitExceeded=true`가 우선하며 성공 결과로 소비할 수 없다. 이 프로필의 guest stdio 제한은 임의 native 프로세스 전체의 디스크 quota를 보증하지 않는다. 기존 디렉터리 실험 프로필의 출력 quota도 해결한 것으로 세지 않는다.

부모는 실행 전 output 디렉터리의 no-delete handle과 stdout/stderr의 CreateNew 쓰기 handle을 확보한다. 결과 수집은 이 핸들에만 쓰며 자식 종료 뒤 경로를 다시 열지 않는다. 결과 파일 핸들은 자식의 상속 목록에 포함하지 않는다.

## 검증 보고서와 보존

검증 시작 시 `latest-verification.json`을 새 `in_progress` 기록으로 교체한다. 런타임 확인과 컴파일도 같은 try/finally 안에 있으므로 초기 실패는 새 `failed` 기록이 된다. 최종 보고서는 검증 UUID를 포함한 별도 JSON에도 보존하여 다음 실행이 지난 증거를 없애지 않는다. 컴파일러는 서로 일치하는 SystemRoot/windir, 절대 경로·실제 경로·ordinary ancestor 및 OS 도구 존재를 검사한 Windows 디렉터리 아래에서 찾는다.

전체 실증이 `partial`로 완료되고 모든 실행의 `profileDeleted=true` 또는 명시적인 시작 전 거부를 확인한 뒤에만 해당 실행의 중복 `bin`을 정리한다. 정리는 `.tools/windows-wasmtime-sandbox/run-[a-f0-9]{32}/bin`으로 한정하며 정확한 원본 4파일·크기·해시·링크 부재와 실행 중 Wasmtime 프로세스 부재를 확인한다. 개별 파일 unlink와 비재귀 rmdir만 사용한다. 입력·출력·보고서·중앙 고정 런타임은 보존하고, 실증 실패 시 정리를 시작하지 않는다. 정리 중 오류가 생기면 남은 파일을 보존하며 그 검증을 성공으로 기록하지 않는다.

2026-10-28 경계 시험은 실제 512MiB sparse 캐시, 읽는 중 성장, 정확한 멤버 크기, hardlink/junction, 초기 런타임/컴파일 실패 보고서 교체, 최종 보고서 보존, 정리 대상 경로 및 Windows root 거부를 검증했다. 실제 native·Python·Wasmtime 3개 회귀도 통과했다. 이번 작업에서 생성한 과거 검증 복제 48개도 같은 검사로 정리했다(원본 4파일 합계 1,992,103,536바이트). 일반 사용자 파일이나 실행 루트 전체는 삭제하지 않았다.

2026-10-28 09:30 KST 최종 확인: 경계 시험 12개 및 실제 Windows 격리 회귀 3개 통과(격리 회귀 48.33초). Windows 속성 검사는 한글을 포함한 다중 경로를 JSON stdin으로 받아 reparse attribute를 확인한다. `stdioWallTime`에서 부모 출력 폴더 rename은 EPERM, stdout 쓰기는 EBUSY로 거절되었고 비교용 일반 파일 쓰기는 성공했다. 중간 정리 검사 실패 1회의 보고서와 14개 bin은 실패 증거로 보존했다. 이후 성공한 실행의 14개 bin만 해당 검증 종료 시 정리했다.

2026-10-28 08:57 KST: Wasmtime 신규 시험과 기존 Node/native·Python 시험 3개 모두 통과(34.58초). Node/Python의 실제 시작 실패 상태를 유지하는 회귀와 Wasmtime의 실제 성공 관찰을 구분한다.

```powershell
& '.tools/node/node-v24.22.1-win-x64/node.exe' tooling/prepare-windows-wasmtime.mjs
& '.tools/node/node-v24.22.1-win-x64/node.exe' tooling/verify-windows-wasmtime-sandbox.mjs
node tooling/run-pnpm.mjs exec vitest run tests/security/windows-wasmtime-sandbox.test.ts
```

## 운영 연결 전에 필요한 작업

1. `program.codeRef`의 고정 자료 해시, 실제 WASM 형식·import allowlist, Worker profile 버전과 binary digest, 결과 JSON 계약을 Runner 계획에 연결한다.
2. 운영 프로필을 bounded stdio로 고정하고 파일 결과는 검증된 JSON/바이트 계약을 통해 Runner가 생성하도록 연결해야 한다. 디렉터리 preopen 모드는 추가적인 지속 디스크 quota 없이는 운영으로 확장하지 않는다.
3. 실제 취소·호스트 crash·고아 profile 복구·artifact 수집·결과 불명/중복 실행 처리를 영속 상태에 연결한다.
4. Wasmtime guest 및 native host의 네트워크·장치·레지스트리·named pipe 등 적대적 검증과 다른 지원 Windows 버전을 추가한다. 현재 networkBoundaryStatus는 unverified다.
5. 고지/SBOM·서명된 설치/업데이트·깨끗한 PC·실제 기능 예제를 검증한다. 이 실험만으로 전체 31블록 완료 또는 P3-07 완료를 표시하지 않는다.
