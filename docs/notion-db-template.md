# Notion DB Template — 실험 세션 트래커

이 플랫폼과 Notion DB를 연동하면 예약이 확정될 때마다 Notion 페이지가 자동으로 생성됩니다. 연구자는 해당 페이지에 **코드 경로, 데이터 경로, 파라미터, 노트**를 채워넣어 랩 노트처럼 사용할 수 있습니다.

## 1. Notion 데이터베이스 만들기

Notion에서 새 데이터베이스(Table view)를 만들고 아래 속성을 **그대로** 추가하세요. (속성 이름이 한 글자라도 다르면 연동이 실패합니다.)

| 속성 이름 | 타입 | 자동 채움? | 설명 |
|---|---|---|---|
| 실험명 | Title | ✅ 예약 시 | 실험 제목 |
| 프로젝트 | Text | ✅ 예약 시 | `project_name` (예: TimeEst) |
| 실험날짜 | Date | ✅ 예약 시 | KST 기준 날짜 |
| 시간 | Text | ✅ 예약 시 | `HH:MM - HH:MM` KST |
| 피험자 ID | Text | ✅ 예약 시 | `Sbj{번호}` (예: Sbj10) |
| 회차 | Number | ✅ 예약 시 | 다회차 실험의 N회차 |
| 참여자 | Text | ✅ 예약 시 | 참여자 이름 (PII). 내부 공유용에만 사용하세요. |
| **공개 ID** | **Text** | ✅ 예약 시 (가능한 경우) / ✅ 관찰 기록 시 | Lab-scoped 가명 식별자 (예: `CSNL-A4F2B1`). 외부 공유·논문/리포트 참조는 이 컬럼을 사용하세요. `participant_lab_identity.public_code`와 1:1 매핑. 식별자 미생성 상태면 공백. |
| 상태 | Select | ✅ 예약 시 | `확정` / `취소` / `완료` 등 |
| **Pre-Survey 완료** | **Checkbox** | ✅ 관찰 기록 시 | Pre-experiment survey 배포 완료 여부. PUT `/api/bookings/:id/observation` 호출 시 체크. |
| **Pre-Survey 정보** | **Text** | ✅ 관찰 기록 시 | 참여자가 pre-survey에 응답한 핵심 정보(자유 기술). 체크박스가 켜져 있으면 값 필수. |
| **Post-Survey 완료** | **Checkbox** | ✅ 관찰 기록 시 | Post-experiment survey 완료 여부. 이 값이 `true`이고 `slot_end`가 지났다면 DB 트리거가 booking을 `completed`로 전환합니다. |
| **Post-Survey 정보** | **Text** | ✅ 관찰 기록 시 | 참여자가 post-survey에 응답한 핵심 정보. 체크박스가 켜져 있으면 값 필수. |
| **특이사항** | **Text** | ✅ 관찰 기록 시 | 세션 중 관찰한 특이사항(장비 이슈, 참여자 컨디션, 프로토콜 편차 등). |
| **Code Directory** | **Text** | ✅ draft→active 시 (실험 행) / ✏️ 수동 (예약 행) | 분석 코드 경로 (GitHub URL 또는 서버 path). 실험 생성 시 연구자가 반드시 입력해야 하는 필수 필드이며, `experiments.code_repo_url`과 1:1 매핑됩니다. **반드시 Text 타입으로 만드세요** — URL 타입으로 만들면 서버 절대 경로 저장 시 400이 납니다. |
| **Data Directory** | **Text** | ✅ draft→active 시 (실험 행) / ✏️ 수동 (예약 행) | 원본 데이터 저장 위치. 실험 생성 시 필수 입력이며 `experiments.data_path`에 저장됩니다. **반드시 Text 타입**으로 만드세요. |
| **Parameter** | Text | ✅ draft→active 시 (실험 행) / ✏️ 수동 (예약 행) | 실험 파라미터 스키마. 실험 레벨 행에는 `key: type` 요약이 자동 기재되고, 세션 행은 연구자가 실제 값으로 덮어씁니다. |
| **Notes** | Text | ✅ draft→active 시 (실험 행) / ✏️ 수동 (예약 행) | 실험 레벨 행에는 사전 체크리스트가 자동 기재됩니다. 세션 레벨 행은 관찰 메모용으로 비어서 생성됩니다. |

> **팁**: Select 필드 `상태`에 미리 `확정` / `취소` / `완료` / `no_show` 옵션을 만들어 두면 연동이 더 깔끔합니다.

> **PII 주의**: `참여자` 컬럼에는 기존 동작을 유지해 참여자의 실명이 그대로 기록됩니다(연구자 친화성). 외부 공유용 뷰(예: 공동 연구자/리뷰어 공유)에서는 반드시 `참여자` 컬럼을 숨기고 `공개 ID` 컬럼을 기본 표시로 구성하세요. Notion 페이지 id, `booking_integrations.last_error`, 서버 로그 등 부가 저장소에는 실명/전화/이메일을 싣지 않습니다.

### 실험 레벨 vs 예약 레벨 행

migration 00022부터 동일한 DB 안에 두 종류의 행이 생깁니다.

1. **실험 마스터 행** — 실험이 `draft`에서 `active`로 전환되는 순간 자동 생성됩니다.
   - `피험자 ID` = `"실험 마스터"`, `회차` = `0` 으로 기록됩니다.
   - `Code Directory`, `Data Directory`, `Parameter`, `Notes`(체크리스트 요약) 4컬럼이 `experiments` 테이블의 연구 메타데이터에서 자동으로 채워집니다.
   - 실험 레벨 행은 Notion 페이지 id가 `experiments.notion_experiment_page_id` 에 저장되어 재발행을 방지합니다.
2. **예약 행** — 참여자가 슬롯을 예약할 때마다 생성됩니다(기존 동작). 연구자는 이 행의 `Code/Data/Parameter/Notes` 컬럼을 세션 실제 값으로 덮어쓸 수 있지만, 비어 있는 경우 실험 마스터 행을 참조하면 됩니다.

## 2. Notion Integration 생성

1. https://www.notion.so/my-integrations 접속 → **New integration**
2. 이름 입력, Workspace 선택, Type: **Internal**
3. 생성 후 **Internal Integration Secret** 복사 → 이것이 `NOTION_API_KEY`
4. 방금 만든 DB 페이지 열고 우측 상단 `...` → **Connections** → 해당 integration 선택해서 연결

## 3. Database ID 찾기

Notion DB 페이지 URL이 `https://www.notion.so/myworkspace/abc123def456...?v=...` 형태면,
`abc123def456...` 부분(32자 hex)이 `NOTION_DATABASE_ID` 입니다. `?v=` 이후는 뷰 ID라 빼셔도 됩니다.

## 4. 환경 변수

```bash
# .env.local / Vercel env
NOTION_API_KEY=secret_********
NOTION_DATABASE_ID=abc123def456...
```

> `NOTION_API_KEY`가 비어있으면 Notion 연동은 자동으로 **skip** 됩니다. (다른 기능은 정상 작동)

## 5. 예약 확정 후 흐름

1. 참여자가 예약 → Postgres에 `bookings` 기록
2. 비동기로 Notion에 새 페이지 생성 (자동 채움 필드 모두 채워짐)
3. 연구자가 실험 끝난 후 Notion에서 **Code / Data / Parameter / Notes** 채움
4. 분석 단계에서 Notion DB 자체를 pandas로 pull해 세션 메타 테이블로 사용

## 6. 분석 예시 (Python)

```python
from notion_client import Client
import pandas as pd

notion = Client(auth="secret_********")
db_id = "abc123def456..."

pages = notion.databases.query(database_id=db_id)["results"]
rows = [{
    "subject": p["properties"]["피험자 ID"]["rich_text"][0]["plain_text"],
    "session": p["properties"]["회차"]["number"],
    "date": p["properties"]["실험날짜"]["date"]["start"],
    "code_dir": p["properties"]["Code Directory"]["url"],
    "data_dir": p["properties"]["Data Directory"]["url"],
} for p in pages]

df = pd.DataFrame(rows)
```

## 7. 문제 해결

- **"property X is not a property that exists"** — DB에 해당 속성 이름이 없거나 타입이 다릅니다. 이 문서의 표와 정확히 일치하도록 수정하세요.
- **"Could not find database"** — Integration이 DB에 연결되지 않았습니다. Step 2의 Connections를 다시 확인하세요.
- **페이지가 생성되지 않음** — `/experiments/{id}/bookings` 의 예약 행에 "Notion 재시도" 버튼(추가 예정)이 있거나, Supabase `booking_integrations` 테이블에서 failed 상태와 `last_error`를 확인할 수 있습니다.

## 8. 관찰 기록 동기화

세션 단위 관찰 기록(**Pre-Survey 완료 / Pre-Survey 정보 / Post-Survey 완료 / Post-Survey 정보 / 특이사항 / 공개 ID**)은 예약 확정 시 생성된 **같은 Notion 행에 PATCH** 로 자동 반영됩니다. 즉 세션 하나당 Notion 페이지 하나가 유지되며, 예약 → 수행 → 관찰 기록 → 정산까지 동일한 행에서 추적할 수 있습니다.

### 흐름 요약

1. 예약 확정 → `createBookingPage` 가 Notion 행을 생성 (`booking.notion_page_id` 저장).
2. 세션 시작 후 연구자가 `/api/bookings/:id/observation` (PUT) 로 Pre/Post survey 완료 여부와 자유 기술 정보, 특이사항을 기록.
3. 서버가 `submit_booking_observation()` RPC 로 `booking_observations` 행을 upsert — `post_survey_done=true` 이고 `slot_end` 가 지났다면 booking 을 `completed` 로 자동 전환(00025 트리거 → 참여자 class 재계산).
4. 같은 요청 안에서 `syncObservationToNotion()` 이 호출되어 1번에서 만든 페이지를 PATCH. 결과는 `booking_observations.notion_page_id / notion_synced_at` 에 기록됩니다.

### 실패 시 동작 (`booking_integrations.notion_survey`)

- **status='skipped'** — `NOTION_API_KEY` / `NOTION_DATABASE_ID` 가 설정되지 않음. 관찰 데이터는 Postgres 에는 저장되어 있음.
- **status='failed'** — Notion API 호출이 거부되었거나 컬럼 이름이 일치하지 않음. `last_error` 필드에 원인 메시지(최대 500자, PII 없음)가 저장됨. 재시도 워커가 이 행을 대상으로 `syncObservationToNotion(booking_id)` 를 다시 호출할 수 있음.
- **status='completed'** — `external_id` 에 Notion 페이지 id 기록. 재실행해도 같은 페이지를 PATCH 하므로 idempotent.

### 제약

- 관찰 기록은 기본적으로 `slot_start + 10분` 이후에만 기록 가능 (실수 방지). 관리자/연구자가 선소급 입력이 필요하면 `?backfill=true` 쿼리 파라미터로 우회.
- Notion 측 컬럼 이름은 **정확히 한글**이어야 합니다 (`Pre-Survey 완료`, `Post-Survey 정보`, `특이사항`, `공개 ID` …). 한 글자라도 다르면 PATCH 가 400 으로 떨어지고 `last_error` 에 Notion 에러가 그대로 보관됩니다.

---

이 스키마는 "최소 필수 필드"입니다. 연구실별로 MRI run number, EEG trigger log, 장비 ID 같은 항목을 추가해도 연동에는 영향 없습니다 (추가 속성은 그냥 비어있는 상태로 생성됨).
