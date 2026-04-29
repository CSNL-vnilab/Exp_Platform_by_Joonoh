# Handoff: 참여자 측 정산정보 입력 UI 보완

## 작업 목표

실험을 마친 참여자가 본인 결제정보(이름·연락처·소속·이메일·예금주·은행명·계좌번호·전자서명)를 입력하는 UI를 완성한다. 입력값은 기존의 엑셀 자동 생성 (`src/lib/payments/excel.ts`) 양식과 일대일로 매핑되어야 하며, lab chore GitHub repo의 일회성경비지급자 양식과도 정확히 호환되어야 한다.

## 충돌 회피 (필수)

- **`AGENTS.md` `multi-session-rules` block**을 먼저 읽고 따른다. 6개 룰 (pre-push fetch, 60s 대기, DB-write 명시, e2e 동시 실행 점검, GH Actions 단일 cron source, Vercel-GitHub link 복구).
- 현재 working tree에 다른 세션의 in-flight 작업이 존재할 수 있다 (`offline-code-analyzer` feature 등). `git status`로 modified/untracked 확인 후 **본 작업과 무관한 파일은 절대 staged하지 말 것**. `git add` 시 명시적 파일 경로만 사용.
- 본 작업의 변경 영역은 다음으로 한정:
  - `src/app/(public)/payment-info/[token]/**`
  - `src/app/api/payment-info/[token]/**`
  - `src/lib/payments/**`
  - 필요 시 `supabase/migrations/000XX_*.sql` 신규 (00049 이후 번호 사용)

## 기존 자원 — 절대 새로 만들지 말고 확장

| 자원 | 위치 | 역할 |
|---|---|---|
| DB schema | `supabase/migrations/00024_participant_payment_info.sql` | RRN(암호화) / 은행 / 계좌 / 서명 path / institution / amount / status |
| 토큰 발급/검증 | `src/lib/payments/token.ts` | HMAC 서명 토큰. 참여자 링크 = `/payment-info/{token}` |
| RRN 암·복호화 | `src/lib/crypto/payment-info.ts` (key version 지원) + `src/lib/payments/rrn.ts` (validation) | AES-256-GCM. PAYMENT_INFO_KEY 환경변수 |
| 참여자 폼 (UI) | `src/app/(public)/payment-info/[token]/PaymentInfoForm.tsx` | **이 파일이 핵심 보완 대상** |
| 페이지 wrapper | `src/app/(public)/payment-info/[token]/page.tsx` | 토큰 검증 + 서버 데이터 prefetch |
| 제출 API | `src/app/api/payment-info/[token]/submit/route.ts` | RRN 암호화·서명 PNG 업로드·계좌 저장 |
| 엑셀 생성 | `src/lib/payments/excel.ts` | `buildIndividualFormWorkbook` / `buildUploadFormWorkbook` — 입력 필드와 시트 셀이 1:1 매핑돼 있다 |
| Sanitize | `src/lib/payments/sanitize.ts` | CSV/Excel injection 가드 |
| 청구 번들 | `src/lib/payments/claim-bundle.ts` | 청구 ZIP 생성 |
| Storage | Supabase bucket `participant-signatures` (서명 PNG), bankbook 같은 별도 bucket | 이름 변경 X |

## 1차 진단 (먼저 할 것)

1. `PaymentInfoForm.tsx`를 읽고 현재 입력 필드 목록 추출.
2. 사용자 명시 필드 (이름·연락처·소속·이메일·예금주·은행명·계좌번호·전자서명) vs 현재 폼 필드 vs `00024` schema 컬럼 vs `excel.ts`의 셀 매핑 vs lab chore repo 엑셀 원본 — **4-way diff**를 표 한 줄씩 만든다.
3. 빠진 필드 / 매핑 안 맞는 필드 / UX가 불완전한 필드를 priority-ranked 목록으로.

## 보완 작업 (위 진단 결과 기반)

- 빠진 입력은 `PaymentInfoForm.tsx`에 추가 + submit API zod schema 확장 + DB 컬럼이 없으면 신규 마이그레이션 (`00050_*.sql` 부터 번호 결정).
- 전자서명: 이미 PNG 업로드 path가 있으면 canvas 컴포넌트만 보완. PNG 업로드는 `participant-signatures` bucket을 이미 사용 중인지 확인.
- 엑셀 매핑이 깨지지 않게 `excel.ts`의 `ExportParticipant` 타입과 폼 필드를 항상 동기화. 엑셀 셀 위치는 lab chore repo 양식의 좌표를 변경하지 않는다.
- 참여자가 한 번 제출하면 토큰을 즉시 무효화 (이미 `submit/route.ts`에서 `token_revoked_at` 처리하는지 검증).

## lab chore repo 활용

- 별도 GitHub repo (소속 lab의 chore/template 저장소) 의 일회성경비지급자_업로드양식 + 실험참여자비 양식 엑셀 원본을 reference로 사용한다. 좌표·시트명·헤더 텍스트가 `src/lib/payments/excel.ts` 와 정확히 매칭되어야 행정에서 받아들여진다.
- 사용자에게 repo URL 또는 양식 파일 경로를 물어본다 (env 또는 README에 명시 안 됐으면).

## 검증

- 참여자 흐름 e2e: 토큰 링크 접속 → 모든 필드 입력 → 서명 → 제출 → DB row 확인 → 엑셀 생성 후 양식 좌표 일치 확인.
- 다른 세션의 e2e 스크립트와 시간 겹치지 않게: `ps -axo pid,etime,command | grep "scripts/.*\.mjs"` 로 사전 확인.
- typecheck (`npx tsc --noEmit`) 통과.

## 작업 시작 단계 (이 prompt 받은 세션이 첫 turn에 할 일)

```
1. cat AGENTS.md  # 다중 세션 룰 숙지
2. git status     # 다른 세션의 in-flight 변경 파악, 절대 건드리지 않음
3. git fetch && git log HEAD..origin/main  # 원격 정렬
4. cat src/app/(public)/payment-info/[token]/PaymentInfoForm.tsx
5. cat supabase/migrations/00024_participant_payment_info.sql
6. cat src/lib/payments/excel.ts | head -200
7. → 위에서 만든 4-way diff 테이블을 사용자에게 보여주고 추가 정보 (lab chore repo URL) 요청
```

## 산출물

- `PaymentInfoForm.tsx` 보완 (필요 필드 추가 + 전자서명 UX)
- `submit/route.ts` zod schema + DB write 확장
- 필요 시 `supabase/migrations/000XX_*.sql` (DB write 명시 commit 메시지)
- 관련 `excel.ts` 수정 (셀 매핑 sync — 좌표 보존)
- 한 번의 e2e 검증
- commit 메시지에 영향받는 도메인 (`payment-info`) 명시
