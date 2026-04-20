# Exp_Platform by Joonoh

**An open booking platform for research labs** — replaces the patchwork of
Google Forms + Google Calendar + spreadsheets most experiments rely on.

Every page carries a watermark linking back to this repo; fork it for your
lab, keep the credit line.

---

## 왜 Google Forms/Calendar 보다 안전하고 편리한가

| | Google Forms + Calendar | **Exp_Platform** |
|---|---|---|
| **동시 예약 충돌** | ✗ 두 명이 같은 슬롯을 동시에 채울 수 있음 | ✓ Postgres advisory lock + `book_slot` RPC로 원자적 검증 |
| **과거 시간 예약 차단** | ✗ 수동 확인 | ✓ DB 레벨 `PAST_SLOT` 거절 |
| **캘린더 기존 일정과 겹침 방지** | ✗ 사람이 일일이 확인 | ✓ Google Calendar FreeBusy API 자동 반영 (5분 TTL 캐시) |
| **다회차 실험 일정 배정** | ✗ 폼/캘린더로는 불가능에 가까움 | ✓ when2meet 스타일 주간 시간표, 회차는 날짜순 자동 번호 |
| **PII 최소 노출** | 참가자 정보 폼·캘린더 평문 저장 | ✓ 캘린더 제목은 `[INIT] Proj/Sbj N/Day M`, 이름/연락처는 내부 설명 필드만 |
| **권한 체계** | 시트/폴더 공유 권한 (거친 제어) | ✓ Supabase RLS — 연구원=소유 실험만, 관리자=전체 |
| **동시성 안전 알림** | ✗ 수동 메일/문자 | ✓ outbox 패턴 (GCal + Notion + Gmail + SMS 상태 추적) |
| **모집 마감/자동 잠금** | ✗ | ✓ 모든 슬롯 소진 시 자동 `completed` 전환 |
| **수동 블록** | ✗ | ✓ 연구원이 특정 시간대 수동 차단 |
| **예약 변경 (관리자)** | ✗ | ✓ 새 슬롯 선택 → 기존 캘린더 이벤트 삭제 + 재생성 + 알림 |
| **데이터 소유권** | Google 계정에 귀속 | ✓ 본인의 Supabase DB (마이그레이션으로 복제 가능) |
| **비용** | 무료 | ✓ **Supabase Free + Vercel Free + Gmail App Password — 월 0원** |

---

## 어떻게 작동하는가

```
        ┌─────────────────────────────────────────────────────────────┐
        │                     참여자 (공개 URL)                        │
        │                                                              │
        │   /book/[experimentId]                                       │
        │        │                                                     │
        │        ▼                                                     │
        │   GET /api/experiments/:id/slots/range                       │
        │        │                                                     │
        │        ▼                                                     │
        │   WeekTimetable  (when2meet 스타일 그리드)                    │
        └─────────────┬───────────────────────────────────────────────┘
                      │ POST /api/bookings
                      ▼
        ┌─────────────────────────────────────────────────────────────┐
        │   book_slot RPC  (Postgres)                                  │
        │   ├─ 과거 슬롯 거절 (PAST_SLOT)                              │
        │   ├─ 요일/기간/중복/용량 검증                                 │
        │   ├─ advisory lock (동시성)                                   │
        │   ├─ Sbj 번호 할당 (선착순, subject_start_number부터)          │
        │   └─ confirmed 상태 insert                                    │
        └─────────────┬───────────────────────────────────────────────┘
                      │ await runPostBookingPipeline()
                      ▼
      ┌───────────┬──────────┬───────────┬──────────┐
      │  GCal     │  Notion  │   Gmail   │  SOLAPI  │
      │  이벤트   │  페이지   │  확정 메일 │  알림톡   │
      │  생성     │  생성     │            │           │
      └─────┬─────┴────┬─────┴─────┬──────┴────┬─────┘
            ▼          ▼           ▼            ▼
       ┌────────────────────────────────────────────┐
       │  booking_integrations (outbox)              │
       │  status = pending | completed | failed      │
       │  재시도 가능, 감사 로그                       │
       └────────────────────────────────────────────┘
                      │
                      ▼
        ┌─────────────────────────────────────────────────────────────┐
        │   확정 페이지 (/book/:id/confirm)                             │
        │   ├─ 장소 + 네이버 지도 임베드                                 │
        │   ├─ 담당자: 이름 (010-xxxx) + 이메일                          │
        │   └─ 회차별 예약 시간 요약                                     │
        └─────────────────────────────────────────────────────────────┘
```

---

## 실험자 UI

### 실험 생성 폼 (`/experiments/new`)

- 제목 · 설명 · 기간 · 일일 운영시간
- **요일 체크박스** (월~일)
- **연구 카테고리 복수선택**: 오프라인 행동실험 / MRI / 뇌자극 / 안구추적 / 온라인 행동 실험
- **장소** — 관리자가 `/locations`에서 관리하는 목록에서 선택
- 세션 유형: 단일 / 다중(N회차)
- **Sbj 시작 번호** (예: 10부터)
- **프로젝트 약칭** (캘린더 제목에 사용)
- **모집 마감일** + **자동 잠금**
- **예방 수칙 체크리스트** (IRB용 사전 확인)
- **미리보기**: 실제 캘린더 조회 후 참여자가 볼 슬롯 즉시 확인

### 실험 상세 (`/experiments/:id`)
- 수정 · 실험 복사 · 예약 링크 복사 · **수동 블록 관리** · **완전 삭제**

### 예약 관리 (`/experiments/:id/bookings`)
- 예약 목록 (Sbj/회차/시간/참가자)
- 각 행에 **[예약 변경]** [예약 취소] 버튼
- 예약 변경: 관리자 전용, 새 슬롯 선택 → GCal 이벤트 자동 이동 + 알림 발송

### 사용자 관리 (`/users`, 관리자 전용)
- 연구원 ID 발급 · 역할 변경 · 활성/비활성
- 연구원 본인 가입 시 승인 대기 큐

### 장소 관리 (`/locations`, 관리자 전용)
- 실험실 이름 · 주소 (여러 줄) · 네이버 지도 링크
- 연구원 폼의 장소 드롭다운이 여기를 참조

---

## 실험 DB 스키마 (Notion 확장 가능)

핵심 테이블:
- `experiments` — 실험 파라미터 전체
- `bookings` — 참여자 예약 (Sbj 번호, 회차, GCal/Notion 외부 ID 포함)
- `participants` — 참여자 마스터 (전화+이메일 유니크)
- `experiment_locations` — 관리자 관리 장소
- `experiment_manual_blocks` — 연구원 수동 차단
- `booking_integrations` — 외부 연동 상태 (outbox)
- `profiles` — 로그인 + 연락처
- `registration_requests` — 승인 대기 연구원

Notion 연동(`NOTION_*` env 설정 시 자동):
- 예약 확정 → Notion DB 페이지 생성 (참가자/일시/상태/회차)
- 향후 확장: 실험 진행 상태, 연구 메모, 파일 저장 경로, 간트 차트 Timeline view

---

## 참여자 UI

공개 예약 링크 (`/book/:experimentId`) → 3단계 마법사:
1. **참여자 정보** — 이름/전화/이메일/성별/생년월일(YYMMDD 6자리)
2. **시간대 선택** — when2meet 스타일 주간 시간표. 다회차는 `N/M 선택됨` 카운터. 회차 번호는 **날짜순 자동 배정**.
3. **예약 확인** — 참여비·일정 요약 후 확정

확정 후 안내 페이지:
- 장소 + 네이버 지도 버튼
- 📞 문의: 담당자 이름 (010-xxxx) · 이메일

---

## 알림 예시

### 예약 확정 이메일 (`GMAIL_USER`에서 발송)
```
Subject: [LAB] 실험 예약 확정 - 시간추정실험 1

홍길동님, 아래 실험 예약이 확정되었습니다.

실험명:  시간추정실험 1
참여비:  30,000원

예약 시간:
 • 2026년 4월 25일 13:00 - 14:00

문의: contact@example.edu
```

### 예약 변경 이메일
```
Subject: [LAB] 실험 예약 변경 - 시간추정실험 1

홍길동님, 실험 예약 시간이 변경되었습니다.

이전 일정:  (취소선) 4월 25일 13:00-14:00
변경된 일정: 4월 28일 15:00-16:00

문의: contact@example.edu
```

### SMS (SOLAPI 설정 시)
```
[LAB] 예약확정
홍길동님, "시간추정실험 1" 실험이 예약되었습니다.
일시: 2026년 4월 25일 13:00
문의: contact@example.edu
```

---

## 구축에 필요한 것

**모두 무료 tier로 운영 가능:**

| 서비스 | 용도 | 비용 |
|---|---|---|
| [Supabase](https://supabase.com) | DB + Auth + Realtime | Free (500MB + 50k MAU) |
| [Vercel](https://vercel.com) | 호스팅 | Free (100GB bandwidth) |
| [Google Cloud Console](https://console.cloud.google.com) | Calendar API (서비스 계정) | Free |
| [Gmail App Password](https://myaccount.google.com/apppasswords) | 이메일 발송 | Free |
| (선택) [Notion](https://notion.so) | 실험 프로젝트 트래킹 | Free |
| (선택) [SOLAPI](https://solapi.com) | 한국 SMS | 1건 11원 수준 |
| (선택) [Ollama](https://ollama.ai) + Gemma/Qwen | 로컬 코드 리뷰 에이전트 | Free |

### 로컬 서버 사양 (개발 중)
- **최소**: macOS/Linux, Node 22+, Docker (로컬 Supabase용)
- **권장**: 8GB RAM (로컬 Ollama 리뷰 루프 사용 시 16GB+ 권장)
- **프로덕션**: Vercel serverless이라 별도 서버 불필요

### 필요한 토큰
`.env.example` 참조. 핵심 네 개:
1. **Supabase**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
2. **Google Calendar**: service account JSON (Keys 탭에서 발급) — `npm run install-service-account <json> <calendar-id>`로 자동 주입
3. **Gmail**: `GMAIL_USER` + `GMAIL_APP_PASSWORD` (16자 앱 비밀번호)
4. **내부**: `CRON_SECRET` — `openssl rand -hex 32`

### 다른 AI/알림 모델로 교체 가능
- SMS: SOLAPI 대신 Twilio/NCP SENS → `src/lib/solapi/client.ts` 교체
- 이메일: Gmail 대신 Resend/Postmark → `src/lib/google/gmail.ts` 교체
- 캘린더: Google Calendar 대신 Outlook/CalDAV → `src/lib/google/calendar.ts` 교체
- 리뷰 에이전트: gemma4 대신 qwen3/llama3 등 → `src/lib/ollama/models.ts` 조정

---

## 설치

```bash
git clone https://github.com/CSNL-vnilab/Exp_Platform_by_Joonoh.git
cd Exp_Platform_by_Joonoh
npm install
cp .env.example .env.local  # 채우기

# Supabase Cloud 프로젝트 생성 후
supabase login
supabase link --project-ref <your-ref>
supabase db push              # 19개 마이그레이션 자동 적용

npm run bootstrap-admin       # 관리자 계정 생성 (csnl/slab1234 기본)
npm run dev                   # http://localhost:3000
```

Vercel 배포:
```bash
npx vercel link
npm run push-vercel-env       # .env.local → Vercel env
npx vercel deploy --prod
```

---

## 테스트

```bash
npm run e2e-booking         # 단일 세션 풀 싸이클
npm run e2e-time-est        # 다회차 + Sbj 할당 + 캘린더 제목 포맷
npm run e2e-multi-sbj10     # 여러 참여자 연속 예약
npm run reviewer-team       # 로컬 Ollama 3개 모델 병렬 코드 리뷰
```

---

## 크레딧

Built by **Joonoh** · [github.com/CSNL-vnilab/Exp_Platform_by_Joonoh](https://github.com/CSNL-vnilab/Exp_Platform_by_Joonoh)

MIT License — 자유롭게 포크/개조하시되 모든 페이지 하단의 크레딧 워터마크는 유지해주세요.
