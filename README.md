# Exp_Platform by Joonoh

**연구실 공용 실험 스케쥴링 플랫폼**

한 연구실 안에서 여러 연구자가 동시에 서로 다른 실험을 돌릴 때,
참여자 모집·예약·알림·캘린더 관리를 한 곳에서 처리합니다.
구글 폼 + 구글 캘린더 + 엑셀을 오가며 일정 꼬이던 일을 줄이는 것이 목표입니다.

---

## 한눈에 보기

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 520" width="960" height="520" role="img" aria-label="Lab reservation platform architecture">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#6b7280"/>
    </marker>
    <style>
      .box { fill: #ffffff; stroke: #9ca3af; stroke-width: 1.5; rx: 10; ry: 10; }
      .accent { fill: #eff6ff; stroke: #60a5fa; }
      .hub { fill: #fef3c7; stroke: #f59e0b; }
      .out { fill: #ecfdf5; stroke: #34d399; }
      .title { font: 600 15px -apple-system, 'Segoe UI', sans-serif; fill: #111827; }
      .sub { font: 13px -apple-system, 'Segoe UI', sans-serif; fill: #374151; }
      .note { font: italic 12px -apple-system, 'Segoe UI', sans-serif; fill: #6b7280; }
      .edge { stroke: #6b7280; stroke-width: 1.6; fill: none; }
    </style>
  </defs>

  <text x="480" y="34" text-anchor="middle" class="title" style="font-size:17px;">연구실 공용 실험 스케쥴링 플랫폼</text>

  <!-- Admin -->
  <rect class="box accent" x="40" y="80" width="200" height="90"/>
  <text x="140" y="112" text-anchor="middle" class="title">연구자 (admin)</text>
  <text x="140" y="136" text-anchor="middle" class="sub">실험 생성 · 슬롯 설정</text>
  <text x="140" y="156" text-anchor="middle" class="sub">예약 관리</text>

  <!-- Participant -->
  <rect class="box accent" x="40" y="340" width="200" height="90"/>
  <text x="140" y="372" text-anchor="middle" class="title">참여자 (browser)</text>
  <text x="140" y="396" text-anchor="middle" class="sub">공개 예약 링크</text>
  <text x="140" y="416" text-anchor="middle" class="sub">시간대 선택</text>

  <!-- Vercel / Next.js -->
  <rect class="box hub" x="380" y="210" width="200" height="100"/>
  <text x="480" y="244" text-anchor="middle" class="title">Vercel</text>
  <text x="480" y="266" text-anchor="middle" class="sub">Next.js 16 앱</text>
  <text x="480" y="288" text-anchor="middle" class="sub">예약 · 검증 · 오케스트레이션</text>

  <!-- Supabase -->
  <rect class="box out" x="720" y="90" width="200" height="80"/>
  <text x="820" y="122" text-anchor="middle" class="title">Supabase</text>
  <text x="820" y="146" text-anchor="middle" class="sub">Postgres · Auth · RLS</text>

  <!-- Google Calendar -->
  <rect class="box out" x="720" y="220" width="200" height="80"/>
  <text x="820" y="252" text-anchor="middle" class="title">Google Calendar</text>
  <text x="820" y="276" text-anchor="middle" class="sub">일정 자동 생성</text>

  <!-- Gmail -->
  <rect class="box out" x="720" y="350" width="200" height="80"/>
  <text x="820" y="382" text-anchor="middle" class="title">Gmail (SMTP)</text>
  <text x="820" y="406" text-anchor="middle" class="sub">확정 · 변경 알림</text>

  <!-- Edges from actors to hub -->
  <path class="edge" d="M240,125 C310,125 320,230 380,240" marker-end="url(#arr)"/>
  <path class="edge" d="M240,385 C310,385 320,290 380,280" marker-end="url(#arr)"/>

  <!-- Edges hub to services -->
  <path class="edge" d="M580,235 C640,230 660,140 720,130" marker-end="url(#arr)"/>
  <path class="edge" d="M580,260 L720,260" marker-end="url(#arr)"/>
  <path class="edge" d="M580,285 C640,290 660,380 720,390" marker-end="url(#arr)"/>

  <!-- Bottom flow caption -->
  <text x="480" y="480" text-anchor="middle" class="note">연구자가 실험 생성 → 참여자가 예약 → DB 저장 + 캘린더 등록 + 메일 알림</text>
</svg>

---

## 뭐가 되나요

- 연구자가 실험을 만들고 요일/시간/장소/회차/모집 마감을 지정합니다.
- 참여자는 공개 링크로 접속해 when2meet 스타일의 주간 그리드에서 시간대를 고릅니다.
- 동시에 두 명이 같은 슬롯을 누르면 DB 레벨에서 한 쪽만 통과합니다 (Postgres advisory lock).
- 확정되면 Google Calendar에 일정이 올라가고, 참여자에게 Gmail로 확정 메일이 나갑니다.
- 관리자는 예약 변경/취소를 할 수 있고, 캘린더 이벤트와 메일도 같이 갱신됩니다.
- 모든 슬롯이 차면 실험이 자동으로 모집 완료 상태가 됩니다.

## Google Form + Calendar 대비 좋은 점

- 두 명이 같은 시간을 잡는 사고가 구조적으로 막힙니다.
- 지나간 시간을 고르는 것을 DB가 거절합니다.
- 기존 캘린더 일정과 겹치는 시간은 FreeBusy API로 자동 제외됩니다.
- 다회차 실험 (N회차)의 회차 번호가 날짜순으로 자동 부여됩니다.
- 참여자 이름/연락처는 캘린더 제목이 아니라 내부 설명 필드에만 저장됩니다.
- 연구자 권한은 Supabase RLS로 분리됩니다. 각자 자기 실험만 건드립니다.
- 한 달에 0원으로 돌릴 수 있습니다 (Supabase Free + Vercel Free + Gmail 앱 비밀번호).

---

## 연구자가 쓰는 화면

### 실험 만들기 (`/experiments/new`)
- 제목, 설명, 기간, 하루 운영시간
- 요일 체크박스 (월~일)
- 카테고리: 오프라인 행동실험 / MRI / 뇌자극 / 안구추적 / 온라인
- 장소는 관리자가 `/locations`에서 미리 만들어둔 목록에서 선택
- 단일 세션 / 다회차 (N회차) 선택
- Sbj 시작 번호, 프로젝트 약칭 (캘린더 제목 포맷에 들어감)
- 모집 마감일 + 자동 잠금
- IRB용 예방 수칙 체크리스트
- 만들기 전 미리보기로 실제 슬롯을 확인

### 실험 상세 (`/experiments/:id`)
- 수정, 복사, 예약 링크 복사, 특정 시간대 수동 차단, 완전 삭제

### 예약 관리 (`/experiments/:id/bookings`)
- 예약 목록 (Sbj 번호, 회차, 시간, 참가자)
- 예약 변경: 새 슬롯 선택 시 캘린더 이벤트 이동 + 알림 자동 재발송
- 예약 취소

### 사용자/장소 관리 (관리자 전용)
- 연구원 승인, 역할 변경, 활성화
- 실험실 이름, 주소, 네이버 지도 링크 관리

---

## 참여자가 쓰는 화면

공개 링크 (`/book/:experimentId`) 3단계:
1. 이름 · 전화 · 이메일 · 성별 · 생년월일
2. 주간 시간표에서 시간대 고르기 (다회차는 `N/M 선택됨` 카운터)
3. 참여비·일정 확인 후 확정

확정 페이지에서 장소, 네이버 지도, 담당자 연락처를 볼 수 있습니다.

---

## 알림 예시

**예약 확정 메일**
```
Subject: [LAB] 실험 예약 확정 - 시간추정실험 1

홍길동님, 아래 실험 예약이 확정되었습니다.

실험명:  시간추정실험 1
참여비:  30,000원

예약 시간:
 • 2026년 4월 25일 13:00 - 14:00

문의: contact@example.edu
```

**예약 변경 메일**
```
Subject: [LAB] 실험 예약 변경 - 시간추정실험 1

홍길동님, 실험 예약 시간이 변경되었습니다.

이전 일정:  (취소선) 4월 25일 13:00-14:00
변경된 일정: 4월 28일 15:00-16:00
```

---

## 선택: Notion 연동

실험 날짜 · 실험자 · 파라미터 · 데이터 경로 같은 메타데이터를 Notion DB와 연동해
랩 노트처럼 같이 관리하는 것도 가능합니다 (선택/확장 옵션).

---

## 기술 스택

- **Next.js 16** (App Router) + React 19
- **Supabase** (Postgres + Auth + RLS)
- **Vercel** (호스팅)
- **Google Calendar API** (서비스 계정)
- **Gmail SMTP** (앱 비밀번호)

전부 무료 tier로 운영 가능합니다.

---

## 설치

```bash
git clone https://github.com/CSNL-vnilab/Exp_Platform_by_Joonoh.git
cd Exp_Platform_by_Joonoh
npm install
cp .env.example .env.local   # 값 채우기

supabase login
supabase link --project-ref <your-ref>
supabase db push             # 마이그레이션 적용

npm run bootstrap-admin      # 관리자 계정 생성
npm run dev                  # http://localhost:3000
```

필요한 키 (핵심 네 개):
1. Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
2. Google Calendar: 서비스 계정 JSON → `npm run install-service-account <json> <calendar-id>`
3. Gmail: `GMAIL_USER` + `GMAIL_APP_PASSWORD`
4. 내부: `CRON_SECRET` (`openssl rand -hex 32`)

## Vercel 배포

```bash
npx vercel link
npm run push-vercel-env      # .env.local → Vercel
npx vercel deploy --prod
```

## 테스트

```bash
npm run e2e-booking          # 단일 세션 풀 싸이클
npm run e2e-time-est         # 다회차 + Sbj 할당
npm run e2e-multi-sbj10      # 여러 참여자 연속 예약
```

---

## 크레딧

Built by **Joonoh** · [github.com/CSNL-vnilab/Exp_Platform_by_Joonoh](https://github.com/CSNL-vnilab/Exp_Platform_by_Joonoh)

MIT License — 자유롭게 포크/개조하시되 페이지 하단의 크레딧은 남겨주세요.
