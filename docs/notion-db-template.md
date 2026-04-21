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
| 참여자 | Text | ✅ 예약 시 | 참여자 이름 |
| 상태 | Select | ✅ 예약 시 | `확정` / `취소` / `완료` 등 |
| **Code Directory** | URL 또는 Text | ✏️ 수동 | 분석 코드 경로 (GitHub URL 또는 서버 path) |
| **Data Directory** | URL 또는 Text | ✏️ 수동 | 원본 데이터 저장 위치 |
| **Parameter** | Text | ✏️ 수동 | 실험 파라미터 (조건, 버전 등) |
| **Notes** | Text | ✏️ 수동 | 세션 관찰 메모, 특이사항 |

> **팁**: Select 필드 `상태`에 미리 `확정` / `취소` / `완료` / `no_show` 옵션을 만들어 두면 연동이 더 깔끔합니다.

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

---

이 스키마는 "최소 필수 필드"입니다. 연구실별로 MRI run number, EEG trigger log, 장비 ID 같은 항목을 추가해도 연동에는 영향 없습니다 (추가 속성은 그냥 비어있는 상태로 생성됨).
