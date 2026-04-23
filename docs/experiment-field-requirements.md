# Experiment field requirements

Authoritative classification of every researcher-facing experiment field.
Maps one-to-one to `experimentSchema` in `src/lib/utils/validation.ts`.
Consumed by:

- `src/components/experiment-form-completeness.tsx` (sticky sidebar on /experiments/new + /experiments/[id] edit)
- Section "활성화 전 필수 입력 항목이 남아 있습니다" banner in `experiment-detail.tsx`
- Reviewer contract — if a researcher complains a field silently "did nothing," check this table first.

Legend:
- **🔴 필수** — schema-required. Form rejects submit.
- **🟡 필수 (활성화)** — save allowed in draft, but DB trigger (migration 00022) refuses `status='active'` transition without it.
- **🟢 권장** — not enforced, but downstream systems (Notion, calendar, email, IRB) degrade if absent.
- **⚪ 선택** — cosmetic or power-user; safe default exists.

## Core scheduling

| Field | 등급 | 기본값 | 설명 |
|---|---|---|---|
| title | 🔴 필수 | — | 실험 제목 (Notion, 이메일, 캘린더 노출) |
| start_date / end_date | 🔴 필수 | — | 슬롯 생성 범위 |
| daily_start_time / daily_end_time | 🔴 필수 | 09:00 / 18:00 | 일일 운영 시간 |
| session_duration_minutes | 🔴 필수 | 60 | 세션 길이 (10분 이상) |
| weekdays | 🔴 필수 | 일~토 전체 | 슬롯이 생성될 요일 집합 (min 1) |
| break_between_slots_minutes | ⚪ 선택 | 0 | 연속 세션 사이 버퍼 |
| max_participants_per_slot | ⚪ 선택 | 1 | 한 슬롯 동시 참여 가능 인원 |
| session_type | ⚪ 선택 | single | single / multi |
| required_sessions | 🟡 multi일 때 | 1 | 다회차 실험의 회차 수 |

## 모집 / 공개

| Field | 등급 | 기본값 | 설명 |
|---|---|---|---|
| description | 🟢 권장 | — | 참여자에게 공개되는 실험 요약 |
| participation_fee | 🟢 권장 | 0 | 0이면 "참여비 없음"으로 표기. Stream 2 정산 플로우의 입력값. |
| project_name | 🟢 권장 | — | 캘린더 이벤트 제목 prefix (예: TimeEst/Sbj1/Day1) |
| categories | ⚪ 선택 | [] | 대시보드 필터링용 |
| location_id | 🟢 권장 | null | 오프라인 실험의 주소·지도 링크 출처. 온라인 실험은 필요 없음. |
| google_calendar_id | 🟢 권장 | null | 없으면 GCal 동기화 skip. 연구자 팀 달력에 일정이 안 뜸. |
| irb_document_url | 🟢 권장 | — | 참여자 이메일/예약 확인에 링크 부착. IRB 심사 조건이면 필수화 가능. |
| precautions | 🟢 권장 | [] | 예약 전 참여자가 확인해야 하는 질문들. 없으면 참여자에게 주의사항이 전달되지 않음. |
| registration_deadline | ⚪ 선택 | null | 모집 마감 시각 |
| auto_lock | ⚪ 선택 | true | 정원 소진 시 자동 완료 전환 |
| subject_start_number | ⚪ 선택 | 1 | 첫 참여자 Sbj 번호 |

## 리마인더

| Field | 등급 | 기본값 | 설명 |
|---|---|---|---|
| reminder_day_before_enabled / _time | 🟢 권장 | true · 18:00 | 전날 저녁 알림 |
| reminder_day_of_enabled / _time | 🟢 권장 | true · 09:00 | 당일 아침 알림 |

둘 다 off로 두면 참여자는 예약 확정 이메일만 받게 되어 no-show 위험이 올라갑니다.

## 연구 메타데이터 (migration 00022)

| Field | 등급 | 기본값 | 설명 |
|---|---|---|---|
| code_repo_url | 🟡 필수 (활성화) | — | GitHub URL 또는 서버 절대 경로. DB 트리거가 활성화를 차단합니다. |
| data_path | 🟡 필수 (활성화) | — | 원본 데이터 저장 경로. DB 트리거가 활성화를 차단합니다. |
| parameter_schema | 🟢 권장 | [] | 실험 파라미터 선언. 비어 있으면 Notion 실험 마스터 행에 "(없음)"으로 기록됨. |
| pre_experiment_checklist | 🟢 권장 | [] | 사전 점검. 필수 항목이 하나라도 미완이면 공개 예약이 차단됩니다. 완전히 비우면 게이트가 즉시 통과됩니다. |

## 온라인 실험 (experiment_mode !== "offline")

| Field | 등급 | 조건 | 설명 |
|---|---|---|---|
| experiment_mode | ⚪ 선택 | 기본 offline | offline / online / hybrid |
| online_runtime_config.entry_url | 🟡 필수 (모드가 온라인/하이브리드) | — | 참여자가 `/run/[bookingId]` 셸에서 로드할 JS URL |
| online_runtime_config.entry_url_sri | 🟢 권장 | — | SRI 해시. CDN 공급 payload 무결성 보장. |
| preflight.* | 🟢 권장 | — | 참여자 환경 사전 점검 (해상도, 키보드, 오디오) |
| counterbalance_spec | 🟢 권장 | — | 조건 할당 스펙 (latin_square / block_rotation / random) |
| attention_checks | 🟢 권장 | — | 블록 사이에 삽입되는 주의 체크 |
| completion_token_format | ⚪ 선택 | uuid | 참여자에게 보여주는 완료 코드 포맷 |
| data_consent_required | ⚪ 선택 | false | on이면 참여 전 명시적 데이터 동의 필요 |

## 검증 규칙 요약

`experimentSchema.superRefine`이 강제하는 규칙 (소스: `src/lib/utils/validation.ts`):

1. `code_repo_url` / `data_path` — URL(`^https?://`) 또는 절대 경로(`^[/~]`)만 허용.
2. `parameter_schema[*].key` — 영문/숫자/언더스코어, 첫 글자 영문/언더스코어, 키 중복 금지.
3. `parameter_schema[*]` — enum 타입이면 options ≥1 + 중복 불가.
4. `pre_experiment_checklist[*].item` — 공백 제거 후 1자 이상, 500자 이하.
5. 온라인/하이브리드 모드면 `online_runtime_config.entry_url` 필수.

## UI 규약

- 🔴 필수: 라벨 뒤에 빨간 별표 `*`
- 🟡 필수 (활성화): 라벨 뒤에 `* (활성화 전 필수)` 황색 뱃지
- 🟢 권장: 라벨 뒤에 `(권장)` 청색 뱃지
- ⚪ 선택: 라벨 뒤에 `(선택)` 회색 suffix

실제 구현은 `src/components/ui/field-label.tsx` 참조.
