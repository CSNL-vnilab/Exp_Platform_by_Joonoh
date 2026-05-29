# Cron Runbook — 인간 운영자를 위한 한 페이지

> 본 문서는 lab-reservation 의 모든 cron / scheduled job 을 **한 표** 로
> 정리합니다. 새 cron 추가, 실패 대응, 알림 설정, GitHub-Vercel link
> 점검 등 운영 중 자주 묻는 내용을 모았습니다.

---

## 1. Cron 토폴로지

이 프로젝트는 **두 곳** 에서 cron 을 띄웁니다:

| 위치 | 이유 | 현재 갯수 |
|---|---|---|
| `vercel.json` 의 `crons:` | 가장 짧은 주기 (15 분 / 일 1회) — Vercel 의 native cron 이 가장 안정 | 2 개 (Hobby tier 한도) |
| `.github/workflows/*-cron.yml` | 30 분 ~ 주 1회 — Vercel 한도 초과분 + 알림/수동 트리거 편의 | 6 개 |

**왜 둘로 나누었나** — Vercel Hobby 플랜이 프로젝트당 cron 2 개로 제한되어
있어, 가장 시간 민감한 두 개 (reminders, auto-complete) 만 Vercel 에 두고
나머지는 GitHub Actions 로 분산. GitHub Actions 의 단점 (5–10 분 지터,
runner 큐 대기) 은 분 단위 정확도가 안 중요한 작업들에 적합.

---

## 2. 활성 Cron 표

| Workflow | 주기 | 호출 path | 무엇을 하는가 | 실패 시 영향 |
|---|---|---|---|---|
| `vercel.json` reminders | `*/15 * * * *` | `/api/notifications/reminders` | 실험 전날/당일 리마인더 이메일 + SMS 발송 | 참여자가 일정 잊고 안 옴 |
| `vercel.json` auto-complete | `15 17 * * *` (UTC) | `/api/cron/auto-complete-bookings` | 종료된 booking 을 `completed` 로 자동 전환 + 정산 안내 메일 sweep | 정산 입력 안내 메일 누락, 청구 지연 |
| `outbox-retry-cron.yml` | `*/30 * * * *` | `/api/cron/outbox-retry` | GCal/Notion/SMS/Email 발송 실패 row 들 자동 재시도 (D6 unified) | 일시 장애 후 자동 복구 안 됨 |
| `promotion-notifications-cron.yml` | `*/30 * * * *` | `/api/cron/promotion-notifications` | 참여자 등급 변동 (Royal promotion) 이메일 발송 | 등급 안내 메일 지연 |
| `notion-health-cron.yml` | `0 16 * * *` (UTC) | `/api/cron/notion-health` | Notion DB schema drift 점검 → `notion_health_state` 갱신 | Notion 미러 깨진 줄 모름 |
| `metadata-reminders-cron.yml` | `0 0 * * 1` (월 00:00 UTC = 일 09:00 KST) | `/api/cron/metadata-reminders` | 연구자에게 code_repo_url / data_path / pre_exp_checklist 미입력 리마인더 | 메타데이터 누락 누적 |
| `db-quality-cron.yml` | (확인) | `/api/cron/db-quality-check` | DB integrity / orphan / 의심 row 점검 | 데이터 무결성 점진 악화 |
| `prod-smoke.yml` | `5 */6 * * *` | (read-only) | 7개 cron route 모두 secret 없이 호출 → 401 확인 (auth 회귀 탐지) | secret 누수 / endpoint 변경 silent 통과 |
| `timeexp-data-integrity.yml` | `17 * * * *` | (Node script, HTTP 아님) | TimeExpOnline1_demo Supabase 무결성 점검 | TimeExp 데이터 잠재 손상 |
| `ci.yml` | push / PR | (Typecheck + migration-status) | 미적용 migration 있으면 `exit 1` → 다음 deploy 차단 (의도된 가드) | (의도된 동작) |

비활성 / 폐기됨: `notion-retry-cron.yml` (2026-04-24 outbox-retry 로 통합).

---

## 3. Cron 점검 — 빠른 명령

### 최근 실행 상태 (한 줄)

```bash
# 모든 workflow 의 최근 3 runs
for w in reminders auto-complete outbox-retry promotion-notifications \
         notion-health metadata-reminders db-quality prod-smoke; do
  echo "=== ${w}-cron.yml ==="
  gh run list --workflow="${w}-cron.yml" --limit 3 \
    --json conclusion,createdAt,event \
    -t '{{range .}}{{.conclusion}} {{.createdAt}} {{.event}}{{"\n"}}{{end}}'
done
```

### 수동 트리거

```bash
gh workflow run outbox-retry-cron.yml   # 그 workflow 의 다음 cron 실행 즉시 fire
```

또는 GitHub Web → Actions → 해당 workflow → "Run workflow" 버튼.

### Route 직접 호출 (secret 필요)

```bash
curl -X POST "https://lab-reservation-seven.vercel.app/api/cron/auto-complete-bookings" \
  -H "x-cron-secret: $CRON_SECRET"
```

`CRON_SECRET` 는 `vercel env pull` 또는 Vercel Dashboard → Settings → Environment Variables 에서 확인.

---

## 4. 실패 시 대응

### A) 한 workflow 가 한 번 fail

1. `gh run list --workflow=<file> --limit 5` 로 패턴 확인 (한 번? 연속?)
2. `gh run view <run-id> --log-failed` 로 로그
3. 일과적 (5xx / network) 이면 무시 — 다음 주기 (15 분 ~ 30 분 후) 자동 재시도
4. 구조적 (4xx / auth / 코드 변경) 이면 코드 또는 secret 점검

### B) 여러 workflow 동시 fail

거의 항상 두 가지 중 하나:

- **`CRON_SECRET` 변경 후 GitHub secret 미동기** → `gh secret set CRON_SECRET ...` 재설정
- **Vercel 배포 실패 / production alias 깨짐** → Vercel Dashboard → Deployments → 마지막 success 로 promote

### C) Vercel-GitHub link 가 끊김 (push 해도 빌드 안 됨)

```bash
PROJECT_ID=$(jq -r .projectId .vercel/project.json)
TEAM_ID=$(jq -r .orgId .vercel/project.json)
curl -s "https://api.vercel.com/v9/projects/$PROJECT_ID?teamId=$TEAM_ID" \
  -H "Authorization: Bearer $VERCEL_TOKEN" | jq .link
# null  → 끊김. Vercel Dashboard → Project → Settings → Git → Connect 재연결.
# {...} → 정상.
```

### D) Migration 미적용 — CI 가 매번 fail

이건 **의도된 동작**. `node scripts/migration-status.mjs` 가 미적용 migration
을 감지하면 `exit 1`. 다음 두 단계로 해소:

```bash
# 적용 순서대로 (sorted by filename)
node scripts/apply-migration-mgmt.mjs supabase/migrations/00058_*.sql
node scripts/apply-migration-mgmt.mjs supabase/migrations/00059_*.sql
# … 마지막까지

# 적용 완료 후 docs/ops-playbook.md 의 "Last applied" 마커 업데이트
# (line 200 부근, "Last applied to prod: ...")
```

---

## 5. 알림 (현재 미설정 — TODO)

**현재** 8 개 cron 모두 **알림 경로가 없습니다**. silent failure 시 다음
manual sweep 까지 발견 안 됨.

### 권장 — Slack incoming webhook 한 줄

각 workflow 의 마지막 step 으로 추가 :

```yaml
- name: Notify Slack on failure
  if: failure()
  run: |
    curl -X POST -H 'Content-type: application/json' \
      --data "{\"text\":\"❌ ${{ github.workflow }} failed — ${{ github.run_url }}\"}" \
      ${{ secrets.SLACK_WEBHOOK_URL }}
```

`SLACK_WEBHOOK_URL` 은 `gh secret set` 으로 한 번만 등록.

### 더 간단한 대안

- GitHub 의 본인 계정 Settings → Notifications → "Send notifications for
  failed workflows only" 체크. push 작성자 한 명만 받음.
- 또는 매주 월요일 아침 `gh run list --status failure --created '>= last week'`
  를 한 줄 cron 으로 ops 채널에 게시.

---

## 6. 새 cron 추가하기 (인간 운영자용 절차)

1. **Route 만들기** — `src/app/api/cron/<name>/route.ts`
   - 시작에 `x-cron-secret` header 검증 + ratelimit
   - 응답 JSON 안에 `{ processed: N, errors: M }` 같은 메트릭 포함
2. **GitHub Action workflow 만들기** — `.github/workflows/<name>-cron.yml`
   - `schedule: cron: '<expression>'` (UTC 기준, KST = UTC+9 주의)
   - secrets 사용: `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`
   - `workflow_dispatch:` 추가하면 수동 트리거 가능
3. **본 표 추가** — 위 §2 표에 한 줄 추가
4. **prod-smoke 워크플로우에 라인 추가** — 새 route 도 401 확인
5. **commit 한 번에**

기존 workflow 들 (`outbox-retry-cron.yml` 등) 복사해서 시작하는 게 가장 빠름.

---

## 7. KST/UTC 환산 빠른 표

GitHub Actions cron 은 **UTC 기준**.

| 의도 (KST) | 작성 (UTC) | 비고 |
|---|---|---|
| 매일 02:15 KST | `15 17 * * *` | 전날 17:15 UTC |
| 매일 01:00 KST | `0 16 * * *` | 전날 16:00 UTC |
| 일요일 09:00 KST | `0 0 * * 1` | (월요일 00:00 UTC) — 요일은 UTC 기준 |
| 매 15분 | `*/15 * * * *` | TZ 무관 |
| 매 30분 | `*/30 * * * *` | TZ 무관 |
| 6시간마다 :05 | `5 */6 * * *` | offset 으로 다른 cron 과 겹치지 않게 |

---

## 8. 폐기된 cron (역사)

- **`notion-retry-cron.yml`** — 2026-04-24 `outbox-retry-cron.yml` 로 통합.
  코드 복구가 필요하면 `git log --diff-filter=D --follow -- .github/workflows/notion-retry-cron.yml`.
- **`vercel.json` 의 cron 4 개 이상** — 2026-03 무렵 Hobby plan 한도 (2) 에
  맞춰 GitHub Actions 로 마이그레이션. `vercel.json` 의 `crons:` 는 그 후
  reminders + auto-complete 두 개만.

---

## 9. 자주 묻는 질문

**Q. 한 workflow 가 5 번 연속 fail 했는데 무시해도 되나요?**
A. 위 §4 A 흐름대로 진단. outbox-retry / reminders 가 fail 하면 곧장
이메일/SMS 지연 누적 — 30 분 안에 처리 권장. metadata-reminders 가
fail 하면 한 주 영향이라 다음 화요일 전에만 처리.

**Q. CRON_SECRET 을 회전(rotate) 하려면?**
A. 1) `openssl rand -hex 32` 로 새 값 발급. 2) `vercel env rm CRON_SECRET production`
+ `vercel env add CRON_SECRET production` 로 갱신. 3) `gh secret set CRON_SECRET`
도 같은 값으로. 4) Vercel redeploy. 5) `prod-smoke` 다음 실행에서 모두 401
확인 (구 secret 도 거부 → 회전 완료).

**Q. Cron 이 5–10 분씩 늦게 도는 것이 정상인가?**
A. GitHub Actions cron 은 runner 큐 따라 **최대 15 분** 지터 발생 가능
(공식 docs 명시). 분 단위 정확도가 필요한 작업은 `vercel.json` 의 crons
슬롯에 넣으세요.

---

## 관련 문서

- [`docs/ops-playbook.md`](./ops-playbook.md) — 일상 ops + migration 적용 흐름
- [`DEPLOY.md`](../DEPLOY.md) — 신규 인스턴스 띄우기
- [`AGENTS.md`](../AGENTS.md) — multi-session 협업 룰
- `.github/workflows/*.yml` — 각 workflow 본문
