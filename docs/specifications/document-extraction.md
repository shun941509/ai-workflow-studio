# 운영 문서 추출 — UTF-8 원문

`document_extract`의 현재 운영 지원은 `mode:text`와 별도 worker 없는 UTF-8 원문 읽기다. PDF·Word·표·OCR·언어별 추출은 아직 지원하지 않는다. 스키마가 해당 미래 모드를 인식해도 편집기/Runner 준비 검사에서 활성화하지 않는다.

## 입력과 결과

입력 `file`은 앞선 `file_input` 또는 `file_output`이 만든 현재 실행의 `FileRef` 하나다. Runner는 실제 등록 기록·run 소유권·파일 종류·불변 해시를 모두 확인한다. `relativePath`나 모델이 만든 참조만으로 접근권한을 주지 않는다.

지원 MIME/확장자는 text/plain→.txt, text/markdown→.md/.markdown, application/json→.json이며 모두 비어 있지 않은 최대 2 MiB다. UTF-8 오류·바이너리 제어 문자·잘못된 JSON·중복 JSON 키는 오류로 보고한다. JSON 검증 시 시작 BOM만 일시적으로 제외하지만 추출 결과에는 원문 BOM·공백·CRLF·한글·이모지를 그대로 보존한다.

```json
{
  "data": {
    "text": "원문 그대로",
    "tables": [],
    "locations": [{ "file": "검증된 FileRef", "extractor": { "id": "builtin-utf8-verbatim", "version": 1 }, "textSha256": "실제 UTF-8 원문 SHA256", "location": { "encoding": "utf8", "start": 0, "end": 16 } }],
    "uncertainties": [],
    "extraction": "verbatim_utf8"
  },
  "text": "원문 그대로",
  "sources": ["동일한 원문 위치 레코드"]
}
```

위의 FileRef/해시/크기는 구조 설명용이다. 실행에서는 실제 파일 참조·해시·바이트 길이만 기록하며 새 파일·표·OCR 결과를 만들어 낸 것처럼 표시하지 않는다. `tables:[]`, `uncertainties:[]`는 원문 디코딩 경로를 뜻하며 내용의 사실성이나 전문적인 문서 이해 검증을 뜻하지 않는다.

## 실행과 검증

- 실제 파일 읽기는 `artifacts/document-extract.ts`, 공통 디코더는 `artifacts/text-document.ts`다. 키워드 색인도 같은 디코더를 사용한다.
- 모드 검사는 `workflow-core/operational-modes.ts` 하나를 편집기·ZIP 요청·Runner가 공유한다.
- 필요 capability는 node.document_extract@1, document_extract.text@1, document_extract.builtin_utf8@1이다.
- `tests/contracts/document-extract.test.ts` 13개가 실제 파일·변조·다른 run·UTF-8·BOM·크기·MIME·미지원 모드를 검사한다.
- `tests/integration/runner-document.test.ts` 4개가 3종 ZIP→파일 업로드→추출→최종 출력과 PDF 거절을 검사한다. 모델/외부 서비스 호출은 없다.
- 편집기에서 파일 입력→원문 읽기→결과를 연결하고 실제 운영 ZIP을 내려받는 브라우저 검사를 수행한다.

PDF·OCR을 추가할 때 이 결과 계약에 페이지·표 셀·좌표·불확실성을 확장하고 검증된 실행 격리를 먼저 연결한다. 운영 ZIP에 개발용 변환기나 가짜 추출 결과를 넣지 않는다.
