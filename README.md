# AI Workflow Studio

비전문가가 AI 작업 순서를 블록으로 만들고 Codex·Claude Code·OpenCode용 운영 ZIP으로 활용하는 프로젝트입니다.

## 설계 문서

- [제품·메뉴·운영용 범위](docs/specifications/product-scope.md)
- [공통 데이터와 패키지 경계](docs/specifications/architecture.md)
- [Runner·RAG·ZIP 계약](docs/specifications/runtime-and-package.md)
- [P2-01~11 상세 개발 명세](docs/implementation/P2-detailed-spec.md)
- [P3·P4·240개 예제·출시 계획](docs/implementation/P3-P4-catalog-plan.md)
- [진행 상태와 검증 증거](docs/implementation/status.md)
- [Supabase·OpenAI 연결 준비](docs/implementation/connection-setup.md)
- [관리 파일·출력 규격](docs/specifications/artifact-storage.md)
- [Windows 격리 실증과 남은 제한](docs/specifications/windows-isolation.md)
- [제품 전체 출시 검사](docs/implementation/release-gates.md)

## 저장소 개발

개발 기준은 Node 24.22.1 LTS, pnpm 12.15.0입니다. 사용자에게 제공할 ZIP에는 개발 환경이나 아래 명령을 포함하지 않습니다.

```sh
pnpm install --frozen-lockfile
pnpm generate:spec
pnpm generate:package
pnpm check:generated
pnpm check:boundaries
pnpm check:catalog
pnpm typecheck
pnpm test
pnpm build
```

현재 Windows 환경에서 전역 pnpm 래퍼가 실패하면 `node tooling/run-pnpm.mjs <명령>`으로 설치된 네이티브 pnpm과 프로젝트 내부 Node를 사용합니다. 사용자 전역 설정은 바꾸지 않습니다.

예제 PDF의 내부 검증에는 CPython 3.12.14와 `tooling/catalog/requirements-verification.txt`의 고정 의존성이 필요합니다. CI는 이를 별도로 설치합니다. 로컬에서는 준비된 Python을 PATH에 두거나 해당 명령의 `STUDIO_CATALOG_PYTHON`에 경로를 지정합니다. 이 검증 환경은 사용자 운영 ZIP에 들어가지 않습니다.

실제 Supabase·모델·호스트 연결이 없는 검증을 실제 운영 통합 성공으로 표시하지 않습니다. 모든 코드에는 역할과 중요한 불변조건을 설명하는 주석을 작성합니다.

Runner 내부 배포 후보는 `pnpm build:runner`로 만들고 `pnpm verify:runner <생성 폴더>`로 별도 프로세스 경로를 검사합니다. 이는 공식 서명 설치물이나 세 AI 도구의 실제 사용 인증을 대신하지 않습니다. `pnpm check:release`는 13개 제품 증거와 검증·게시한120+120예제를 모두 요구하며, 준비되지 않은 현재 단계에서는 실패가 정상입니다.
