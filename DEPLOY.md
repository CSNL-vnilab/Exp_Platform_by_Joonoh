# 외부 배포 체크리스트 (Cloudflare Workers + Supabase Cloud)

모든 명령은 repo root에서 실행. 총 예상 시간 **55분~1시간 30분** (네트워크 · 검수 제외).

## 1. Supabase Cloud 프로젝트 (15분)

```bash
# supabase.com → New project → 리전 Seoul (ap-northeast-2) 권장
# 생성 후 대시보드에서 복사:
#   Project URL  → NEXT_PUBLIC_SUPABASE_URL
#   anon key     → NEXT_PUBLIC_SUPABASE_ANON_KEY
#   service_role → SUPABASE_SERVICE_ROLE_KEY (비공개)
```

로컬에서 원격 DB로 마이그레이션 푸시:

```bash
npm install -g supabase  # 또는 brew install supabase/tap/supabase
supabase login
supabase link --project-ref <project-ref>
supabase db push
```

초기 관리자 계정 생성 (로컬과 동일):
```bash
npm run bootstrap-admin       # csnl/slab1234 또는 커스텀
```

## 2. Cloudflare 계정 + Wrangler 로그인 (5분)

```bash
npx wrangler login            # 브라우저 열림 → 권한 승인
```

## 3. 환경변수 주입 (10분)

평문 ID는 `wrangler.jsonc`의 `vars`, 비밀값은 `wrangler secret put`:

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler secret put GMAIL_APP_PASSWORD
npx wrangler secret put CRON_SECRET
npx wrangler secret put NOTION_API_KEY
npx wrangler secret put SOLAPI_API_SECRET
```

`wrangler.jsonc`의 `vars`에 공개 값:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_APP_URL`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_CALENDAR_ID`
- `GMAIL_USER`
- `SOLAPI_API_KEY`, `SOLAPI_SENDER_PHONE`
- `NOTION_DATABASE_ID`

## 4. 빌드 + 배포 (5분)

```bash
npm run build:cloudflare      # @opennextjs/cloudflare 어댑터로 변환
npm run deploy                # wrangler deploy
# → https://lab-reservation.<account>.workers.dev 반환
```

## 5. 커스텀 도메인 (선택, 15~30분)

Cloudflare Dashboard → Workers & Pages → lab-reservation → Settings → Triggers →
Add Custom Domain → 도메인 입력. DNS 전파 5~30분.

## 6. 배포 후 검증 (10분)

```bash
NEXT_PUBLIC_APP_URL=https://<deployed-url> npm run e2e-booking
```

실제 DB, 실제 GCal, 실제 SMTP 전부 통과해야 완료.

---

## 지금 수정 필요한 env 값

현재 로컬 `.env.local` 기준:

| 변수 | 상태 | 필요 조치 |
|---|---|---|
| `GMAIL_APP_PASSWORD` | ❌ `viznidaccnl` (11자) | Gmail 계정 → 보안 → 앱 비밀번호 → 16자 재발급 |
| `NOTION_DATABASE_ID` | ❌ 전체 URL 붙음 | `3482a38e4f5f800298e7d7a07294ccd0` 형태 32자 ID만 |
| `CRON_SECRET` | ❌ 비어있음 | `openssl rand -hex 32`로 생성 |
| `SOLAPI_*` | ❌ 비어있음 | SMS 쓰려면 solapi.com에서 발급, 안 쓰면 그대로 |

두 값만 고치면 이메일·Notion 연동까지 녹색 신호등.
