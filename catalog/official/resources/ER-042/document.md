# API 계약 읽기 안내서

문서 ID: ER-042 / 버전 1.0 / 기준일 2026-10-01

이 문서와 데이터의 기관 “한빛 업무연구소”, 제품 “라온 협업보드”, 역할·업무·기록은 모두 가상입니다. 실제 고객·개인·제3자 문서를 사용하지 않았습니다. 예시를 실제 서비스 정책이나 사건으로 오인하지 마세요.

## API-01 읽을 명세
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
“한 번에 100개를 조회할 수 있는가?”에는 paths./reports.get.parameters의 limit.maximum=50을 근거로 아니라고 설명합니다. “보고서 생성이 가능한가?”에는 제공 명세에 POST가 없다고 답하되 실제 서비스 전체가 생성을 지원하지 않는다고 일반화하지 않습니다.
