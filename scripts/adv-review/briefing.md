# 프로젝트 브리핑 — Exp_Platform (lab-reservation)

> 이 문서는 심사위원 qwen에게 매 슬라이스마다 함께 전달된다.
> 앱의 목적·현황·범위를 이해하지 못한 채 코드만 보면 핵심을 놓치기 때문이다.

## 1. 무엇을 만드는가

**연구실 공용 실험 스케쥴링 플랫폼.** 한 연구실에서 여러 연구자가 동시에 서로 다른 실험을 돌릴 때, 참여자 모집·예약·알림·캘린더·데이터 수집을 한 플랫폼에서 처리한다.

- **연구자 (호스트)**: 로그인해서 실험을 만들고, 주간 슬롯·정원·참여 조건을 설정하고, 예약·데이터를 관리한다.
- **참여자 (게스트)**: 공개 링크로 들어와 로그인 없이 주간 그리드에서 원하는 시간을 선택하고 개인 정보를 입력한 뒤 확정 이메일을 받는다.
- **관리자**: 연구자 계정 승인·권한 관리, 전체 스케줄 뷰, 결제 정산.

## 2. 목표와 원칙

1. **무료 티어로 운영 가능** (Supabase Free + Vercel Free + Gmail SMTP + Solapi 소량).
2. **중복 예약은 구조적으로 차단** — 어플리케이션 검증이 아니라 DB 제약·advisory lock·EXCLUDE 제약으로.
3. **PII는 캘린더 제목이 아닌 내부 설명 필드에만** — 공유 캘린더에서 타 연구자에게 노출되지 않도록.
4. **RLS로 연구자별 데이터 격리** — 자기 실험·자기 참여자만 보인다.
5. **외부 연동(Google Calendar, Notion, SMTP, SMS)은 베스트 에포트** — 실패해도 예약 자체는 저장되고, outbox/재시도 큐가 따라붙는다.
6. **한국어 사용자 대상** — KST 기준 슬롯, 한국 휴대폰/주민번호/이메일 형식.

## 3. 기술 스택

- **프론트엔드**: Next.js 16 (App Router, Server Components 위주), React 19, Tailwind, react-hook-form.
- **백엔드**: Next.js Route Handlers (`src/app/api/**`), Supabase Postgres + RLS, service-role 키로 서버 측 검증.
- **미들웨어**: `middleware.ts` — Supabase 세션 리프레시 + 관리자 가드.
- **외부 연동**: Google Calendar (서비스계정), Gmail SMTP, Solapi SMS, Notion (선택).
- **CRON**: Vercel Cron → `/api/cron/*` (알림, outbox 재시도, Notion 헬스체크, 자동 완료 전환).
- **배포**: Vercel (production), Cloudflare Workers 빌드 파이프라인도 존재 (실험적).
- **로컬 AI**: Ollama — OCR·임베딩·리뷰 보조 (`src/lib/ollama/`).

## 4. 지금까지 구축된 것 (완료)

### 예약 시스템 (핵심 도메인)
- 주간 그리드 슬롯 선택기 + 미리보기
- DB advisory lock 기반 중복 예약 차단 (`book_slot` RPC, 마이그레이션 00045에 EXCLUDE 제약 추가)
- 다회차 실험 회차 번호 자동 부여 (날짜 순)
- 수동 블록 (연구자가 특정 시간대를 불가로 지정)
- 정원 도달 시 실험 상태 '완료'로 자동 전환
- 예약 변경·취소 시 Google Calendar 이벤트 동기화
- `bookingGroupId`로 같은 참여자의 여러 예약 묶기
- 참여자 동일성 검사 (`participant-identity.service.ts`)

### DB 관리
- 49개 마이그레이션 (`supabase/migrations/00001~00046`).
- RLS: `00005_create_rls_policies.sql` + `00010_update_rls_for_roles.sql`.
- Outbox 테이블: 알림·Notion 동기화 실패 재시도 (00037 generalize_outbox_retry, 00046 pending_work_outbox_coverage).
- 최근 변경: 회원가입 시 `contact_email`·`phone` NOT NULL (00017), Notion 멤버 프로젝트 링크(00043), 슬롯 EXCLUDE 제약(00045).
- `db-audit.mjs` 스크립트: 프로덕션 DB 일관성 점검.

### 인증·권한
- Supabase Auth (이메일+비밀번호).
- middleware.ts에서 세션 리프레시 + 관리자 경로 보호.
- 회원가입은 `registration_requests` 테이블에 쌓이고 관리자가 승인.
- RLS로 연구자별 격리 + service-role로 cron/admin 작업.

### 외부 연동
- Google Calendar: 서비스계정, FreeBusy API로 충돌 회피.
- Gmail SMTP: 예약 확정·리마인더·취소 메일 (HTML 템플릿).
- Solapi SMS: 리마인더 보조 (이메일 실패 시나 설정된 경우).
- Notion (선택): 실험·예약 메타데이터 동기화 (`notion-retry` outbox).

### UI/UX
- 관리자 영역 `/app/(admin)` — 대시보드, 실험 목록, 참여자, 일정, 위치, 사용자 관리.
- 공개 영역 `/app/(public)` — 실험별 예약 링크.
- 실시간 업데이트: Supabase Realtime 구독 (booking-flow 컴포넌트).
- 모달·토스트·사이드바 등 공용 UI (`src/components/ui`).
- 관리자 대시보드의 `pending-work-card` — 밀린 작업 알림.

### 결제·정산
- 참여자 주민번호·계좌번호 암호화 저장 (`src/lib/crypto/`).
- 실험별 지급 토큰 발급·만료 (`src/lib/payments/token.ts`).
- 정산 파일 엑셀 export.

### 운영
- E2E 시나리오 스크립트 11개 (`scripts/e2e-*`).
- `db-audit.mjs`로 스키마/데이터 일관성 검증.
- GitHub Actions: outbox 재시도 워크플로우.
- 보안 리뷰 27건 중 CRITICAL/HIGH 모두 수정 완료 (task-state 기준).

## 5. 아직 미완·의도된 누락

- 로깅·관측: Sentry 등 외부 에러 트래커 미연동.
- 테스트: 단위 테스트 드물고 E2E만 존재.
- 성능: 트래픽 많지 않아 캐시 최소화.
- 접근성: 키보드 네비·스크린리더 검증 안 됨.
- i18n: 한국어 하드코딩 (의도적, 초기 고객이 한국 연구실).
- 일부 `ai/*` 라우트는 로컬 Ollama 의존 — 프로덕션 배포 시 외부화 필요.

## 6. 심사 요청 사항

위 맥락을 전제로, **전 과정(아키텍처·DB·예약·UI/UX·운영)에 걸쳐 적대적으로** 검토해 달라.
WIP라는 이유로 넘어가지 말고, "이 설계대로 가면 나중에 비싸게 물릴 부분"을 집어 달라.
