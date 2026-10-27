# 개체 식별 사전†

문서 ID: ER-055 / 버전 1.0 / 기준일 2026-10-01

이 문서와 데이터의 기관 “한빛 업무연구소”, 제품 “라온 협업보드”, 역할·업무·기록은 모두 가상입니다. 실제 고객·개인·제3자 문서를 사용하지 않았습니다. 예시를 실제 서비스 정책이나 사건으로 오인하지 마세요.

## ENTITY-01 식별 원칙
entities.json의 ID가 안정된 식별자이며 표시 이름만으로 병합하지 않습니다. 유형과 namespace를 먼저 좁히고 별칭을 대조합니다. 모든 개체는 가상입니다.

| ID | 유형 | 이름 | 별칭 | 이름 공간 |
|---|---|---|---|---|
| ORG-HANBIT | organization | 한빛 업무연구소 | Hanbit Lab | org |
| SVC-BOARD | service | 라온 협업보드 | Raon Board, 라온 | service |
| SVC-API | service | Atlas API | Atlas | service |
| PRJ-ATLAS | project | Atlas 문서 정리 | Atlas | project |
| DATA-CARDS | dataset | 업무 카드 저장소 | cards, 카드 데이터 | dataset |
| DATA-REPORTS | dataset | 보고서 저장소 | reports, 보고서 데이터 | dataset |
| SVC-BACKUP | service | 보관 서비스 | Archive Service | service |
| ROLE-OPS | role | 운영 역할 | R-OPS, Operations role | role |
| ROLE-QA | role | 검토 역할 | R-QA, Review role | role |
| DOC-POLICY | document | 접근 정책 v1 | Access policy | document |

## ENTITY-02 동명이인·동명 대상
Atlas는 SVC-API와 PRJ-ATLAS의 공통 별칭입니다. “서비스 Atlas”는 SVC-API로, “Atlas 프로젝트”는 PRJ-ATLAS로 해소할 수 있습니다. “Atlas”만 주어지면 두 후보를 유지하고 자동 병합하지 않습니다.

## ENTITY-03 신규 이름
등록되지 않은 대상은 existing ID에 억지로 대응시키지 않습니다. 신규 후보로 분리하고 출처·유형·namespace를 검토한 후 별도 ID를 부여합니다. 이 사전을 읽었다는 것만으로 실제 그래프 색인이 구축되지는 않습니다.
