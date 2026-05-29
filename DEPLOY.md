# Deploy / 운영 체크리스트 (Vercel + Supabase Cloud)

본 프로젝트의 production 호스팅은 **Vercel** (`lab-reservation-seven.vercel.app`),
DB 는 **Supabase Cloud**, cron 은 **GitHub Actions + Vercel Cron**.

> 이 문서는 신규 인스턴스를 처음 띄우거나, 기존 production 운영 흐름을
> 빠르게 파악할 때 보는 한 장 문서입니다. 일상 운영 (migration 적용, cron
> 점검, 장애 대응) 은 [`docs/ops-playbook.md`](./docs/ops-playbook.md) 와
> [`docs/cron-runbook.md`](./docs/cron-runbook.md) 가 더 자세합니다.

---

## 신규 인스턴스 띄우기 (총 ~1h)

### 1) Supabase Cloud 프로젝트 (15분)

```bash
# supabase.com → New project → 리전 Seoul (ap-northeast-2)
# 생성 후 대시보드 → Project settings → API:
#   Project URL  → NEXT_PUBLIC_SUPABASE_URL
#   anon key     → NEXT_PUBLIC_SUPABASE_ANON_KEY
#   service_role → SUPABASE_SERVICE_ROLE_KEY (비공개)
```

마이그레이션 push:

```bash
npm install -g supabase     # 또는: brew install supabase/tap/supabase
supabase login
supabase link --project-ref <project-ref>
supabase db push            # 또는: node scripts/apply-migration-mgmt.mjs <file>
```

초기 관리자 계정:

```bash
npm run bootstrap-admin     # 기본: csnl/slab1234 (변경 권장)
```

### 2) Vercel 프로젝트 (10분)

```bash
npm install -g vercel       # 또는: brew install vercel-cli
vercel login                # 브라우저 인증

# 로컬 repo 를 Vercel project 와 연결
vercel link                 # team / project 선택
# → .vercel/project.json 생성 (commit 안 함, gitignored)
```

Vercel Dashboard → Project → Settings → Git → GitHub repo 연결 (Vercel
GitHub App). 이후 `main` 으로 push 하면 자동 배포.

### 3) 환경 변수 주입 (15분)

`vercel env` 로 모든 환경에 한 번에 설정 (Production / Preview / Development):

```bash
# 필수 — 빠뜨리면 빌드 자체 실패
vercel env add NEXT_PUBLIC_SUPABASE_URL production preview development
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production preview development
vercel env add SUPABASE_SERVICE_ROLE_KEY production preview
vercel env add NEXT_PUBLIC_APP_URL production preview   # 예: https://lab-reservation-seven.vercel.app

# Cron 보호 (GitHub Actions / Vercel Cron 이 호출 시 사용)
vercel env add CRON_SECRET production                    # openssl rand -hex 32

# Gmail / SMTP (이메일 발송)
vercel env add GMAIL_USER production preview
vercel env add GMAIL_APP_PASSWORD production preview     # Gmail 16자 앱 비밀번호

# Google Calendar (SLab 이벤트 sync)
vercel env add GOOGLE_SERVICE_ACCOUNT_EMAIL production preview
vercel env add GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY production preview
vercel env add GOOGLE_CALENDAR_ID production preview

# Notion (실험 mirror — 선택, 안 쓰면 생략)
vercel env add NOTION_API_KEY production
vercel env add NOTION_DATABASE_ID production              # URL 이 아닌 32자 ID 만

# SMS via Solapi (선택)
vercel env add SOLAPI_API_KEY production
vercel env add SOLAPI_API_SECRET production
vercel env add SOLAPI_SENDER_PHONE production

# Token 서명 (P0 stateless tokens — 미설정 시 SUPABASE_SERVICE_ROLE_KEY 으로 fallback)
vercel env add PAYMENT_TOKEN_SECRET production           # openssl rand -hex 32
vercel env add RUN_TOKEN_SECRET production               # 같이 발급
vercel env add BOOKING_EDIT_TOKEN_SECRET production      # 같이 발급
vercel env add BOOKING_EDIT_SESSION_SECRET production    # 같이 발급
vercel env add REGISTRATION_SECRET production            # 같이 발급 (AES blob 용)
```

> **⚠️ Token-secret rotation 주의** (refactor-roadmap.md A3 / hidden-couplings.md #23)
>
> 위 5 개 secret 을 모두 명시 설정하지 않으면 `src/lib/auth/secret-source.ts`
> 가 마지막 수단으로 `SUPABASE_SERVICE_ROLE_KEY` 를 derive 한다 — 즉
> Supabase service-role 을 회전시키는 순간 그 token system 의 모든 발급분
> (booking-edit URL 60 일 TTL 포함) 이 silently 무효화된다.
>
> Production 에서는 다음을 모두 별도 비밀로 설정해 둘 것:
>
> | 환경변수 | 용도 | TTL |
> |---|---|---|
> | `PAYMENT_TOKEN_SECRET` | `/payment-info/[token]` HMAC | 60 일 |
> | `RUN_TOKEN_SECRET` | `/run/[token]` HMAC | 14 일 |
> | `BOOKING_EDIT_TOKEN_SECRET` | `/booking-edit/[token]` HMAC | 60 일 |
> | `BOOKING_EDIT_SESSION_SECRET` | name+phone verify cookie HMAC | 24 시간 |
> | `REGISTRATION_SECRET` | pending password AES-GCM key | (storage 동안) |
>
> 첫 배포 후 production 로그에 `[secret-source]` 경고가 보이면 그 token
> system 은 service-role fallback 으로 동작 중. 회전 footgun 이 켜진 상태.
> 누락된 env 만 추가 설정 후 재배포 → 경고 사라지면 안전.

GitHub Actions secrets 도 같은 값으로 설정 (cron 들이 직접 호출):

```bash
gh secret set CRON_SECRET --body "$(vercel env pull --environment=production --yes /dev/stdout | grep CRON_SECRET | cut -d= -f2- | tr -d \\")"
gh secret set NEXT_PUBLIC_APP_URL --body "https://lab-reservation-seven.vercel.app"
gh secret set SUPABASE_URL --body "<from above>"
gh secret set SUPABASE_SERVICE_ROLE_KEY --body "<from above>"
gh secret set TIMEEXP_EXPERIMENT_ID --body "<uuid>"     # timeexp-data-integrity 만 필요
```

### 4) 빌드 + 첫 배포 (5분)

```bash
# 보통은 git push main 만으로 충분 — Vercel GitHub App 이 webhook 으로 자동 deploy
git push origin main

# 또는 명시적으로:
vercel --prod --yes
```

배포 확인:

```bash
curl -sI https://lab-reservation-seven.vercel.app/ | head -5
# HTTP/2 307 (auth redirect — 정상)
```

### 5) 커스텀 도메인 (선택)

Vercel Dashboard → Project → Settings → Domains → Add Domain. CNAME 또는
A record 안내대로 DNS 설정 → 5–30 분 전파.

### 6) 배포 후 검증 (10분)

```bash
# Cron 라우트 보안 점검 (모두 401 이어야 — secret 없이는 거부)
for p in /api/notifications/reminders \
         /api/cron/auto-complete-bookings \
         /api/cron/outbox-retry \
         /api/cron/notion-health \
         /api/cron/promotion-notifications \
         /api/cron/metadata-reminders \
         /api/cron/db-quality-check; do
  curl -sS -o /dev/null -w "%{http_code} $p\n" -X POST \
    "https://lab-reservation-seven.vercel.app$p"
done
# 7줄 모두 401 → 정상.  prod-smoke 워크플로우가 6 시간마다 같은 점검 자동 수행.

# 인증된 트리거 (한 cron 정상 동작 확인)
curl -sS -o /dev/null -w "%{http_code}\n" -X POST \
  "https://lab-reservation-seven.vercel.app/api/cron/auto-complete-bookings" \
  -H "x-cron-secret: $CRON_SECRET"
# 200 → OK.

# E2E booking (실제 DB / GCal / SMTP 통과)
NEXT_PUBLIC_APP_URL=https://lab-reservation-seven.vercel.app npm run e2e-booking
```

---

## 일상 운영 (이미 띄워둔 인스턴스)

| 작업 | 도구 / 문서 |
|---|---|
| 새 migration 적용 | `node scripts/apply-migration-mgmt.mjs supabase/migrations/000XX_xxx.sql` → ops-playbook §"Deploy workflow" |
| 다음 배포 전 가드 (CI) | `node scripts/migration-status.mjs` — 미적용 migration 있으면 exit 1 |
| Cron 상태 확인 | [`docs/cron-runbook.md`](./docs/cron-runbook.md) — 8개 cron 표 + 실패 대응 |
| Cron 수동 트리거 | GitHub Actions → 해당 workflow → "Run workflow" (수동 입력 지원) |
| Vercel-GitHub link 점검 | `curl -s "https://api.vercel.com/v9/projects/{id}?teamId={team}" \| jq .link` — `null` 이면 재연결 |
| Production runtime 로그 | Vercel Dashboard → Project → Logs (또는 `vercel logs <url>`) |
| 배포 rollback | Vercel Dashboard → Deployments → 이전 deployment → "Promote to Production" |

---

## 폐기됨 (참고용)

- ~~`@opennextjs/cloudflare` adapter + `wrangler` deploy~~ — 2026-04 production
  이 Vercel 로 완전 이전 후 dormant. 관련 파일 (`open-next.config.ts`,
  `wrangler.jsonc`, `proxy.ts`) 은 working tree 에서 deletion 처리됨.
- `vercel.json` 의 cron 슬롯 (Hobby tier 2 개 한도) → 이미 GitHub Actions
  로 7 개 cron 모두 마이그레이션. `vercel.json` 의 `crons:` 항목은 그대로
  유지 (reminders + auto-complete 두 개만; 나머지 5 개는 `.github/workflows/*-cron.yml`).
