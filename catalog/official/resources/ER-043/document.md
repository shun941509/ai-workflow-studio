# 읽기 전용 데이터 사전

문서 ID: ER-043 / 버전 1.0 / 기준일 2026-10-01

이 문서와 데이터의 기관 “한빛 업무연구소”, 제품 “라온 협업보드”, 역할·업무·기록은 모두 가상입니다. 실제 고객·개인·제3자 문서를 사용하지 않았습니다. 예시를 실제 서비스 정책이나 사건으로 오인하지 마세요.

## DB-01 데이터 범위
sample.sqlite는 projects 3행, roles 4행, tasks 8행, reports 4행을 담은 실제 SQLite 파일입니다. 각 행은 가상 업무이며 사람 이름·연락처가 없습니다. schema.sql과 seed.sql은 이 파일의 구조와 원본 데이터입니다.

## DB-02 관계
tasks.project_id와 reports.project_id는 projects.project_id를 참조합니다. tasks.owner_role_id는 roles.role_id를 참조하며 NULL은 담당 미정입니다. 프로젝트와 작업을 조인하면 프로젝트가 작업 수만큼 반복되므로 프로젝트 수를 단순 COUNT(*)로 계산하지 않습니다.

## DB-03 시간과 상태
due_date는 날짜만 있는 YYYY-MM-DD 텍스트이며 시간대 변환 대상이 아닙니다. reports.created_at은 UTC 시각입니다. tasks의 done과 reports의 approved는 서로 다른 상태 체계입니다. 모든 필드 정의는 dictionary.json에 있습니다.

## DB-04 읽기 조건
제공 DB는 읽기 전용 연결 모드와 제한된 파일 권한으로 여세요. PRAGMA query_only는 보조 설정이며 운영 DB의 권한 통제를 대신하지 않습니다. 예제의 생성 SQL을 운영 데이터베이스에서 실행하지 마세요.

## DB-05 대조 가능한 사실
P-ALPHA 작업은 3건이고 완료는 1건입니다. P-BETA 작업은 3건이고 완료는 2건입니다. 담당 미정 작업은 T-003·T-008입니다. 승인된 보고서는 RPT-001·RPT-003입니다. 이 값은 실제 제공 DB로 읽기 조회해 대조할 수 있습니다.
