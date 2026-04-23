# 2026 Calendar backfill notes

Run date: 2026-04-23 KST.  Last strict review: 2026-04-23 (4 CRITICAL / 5 HIGH resolved — see below).

Target: SLab Google Calendar (`dvjmpc33e56l0euaq4c0dekvu4@group.calendar.google.com`)
Window: 2026-01-01 ~ 2026-12-31 (245 events fetched).

## Final state after the consistency loop

- **Notion Projects & Chores** — 14 canonical pages now exist (13 from the first pass + `LabTour 실습 준비` added after the strict review). Case/space variants merged (Pilot/pilot, Self Pilot/self pilot/Self-Pilot → 2 canonical pages). 1 non-project name (`meeting: SK`) deliberately skipped.
- **Projects page metadata** — 13 pages populated with 담당자 (unioned from linked SLab 실험자 relations), 기간 (min..max 실험날짜 range), 상태 (Done if past, In Progress if ongoing), 분류 (Research — only for the 2 pages with a linked Supabase experiment; others left blank for researcher classification), and 참여자 수 (distinct 참여자 count). 우선순위 is never auto-filled (researcher judgment call). 코드 디렉토리 (new rich_text column) filled when the linked experiment has `code_repo_url`; left blank otherwise — see the reminder flow below.
- **Supabase linkage** — all 2 existing experiments linked. 3/4 profiles linked via email-local-part → initial.
- **Notion SLab booking rows** — 235 rows backfilled (of 235 parsed; the 10 unparsed are listed below). All rows now have both 실험자 Relation and 프로젝트 (관련) Relation populated where possible.
- **Duplicate protection** — all 25 Supabase bookings in 2026 with a `google_event_id` already share the SAME `notion_page_id` as the backfill progress file. No duplicate rows.

## Researcher reminder system

User directive 2026-04-23: "디렉토리, survey등 기록되지 않은 정보가 있으면 그에 대한 리마인드 노트가 각 연구자에게 할당되어야함."

Implementation: `scripts/create-researcher-reminders.mjs` scans every Supabase experiments row for missing fields and creates a `분류=Lab Chore` entry in Projects & Chores assigned to the owning researcher via `담당자` Relation.

Detected gaps per experiment:
1. `code_repo_url` empty → reminder "[리마인더] {title} — 코드 디렉토리 / Repo URL 기록 필요"
2. `data_path` empty → reminder "[리마인더] {title} — 데이터 디렉토리 기록 필요"
3. `pre_experiment_checklist` empty → reminder "[리마인더] {title} — 실험 전 체크리스트 기록 필요"
4. Any completed booking with `pre_survey_done=true` but `pre_survey_info=''` (historical data quality check) → reminder

Idempotent: dedup'd by title before creating. Safe to re-run after researchers close tasks.

Current dry-run (2026-04-23):

| Researcher | Reminder count |
|---|---|
| 박준오 | 6 |

The plan is persisted at `.test-artifacts/researcher-reminders-plan.json`. Execute with `node scripts/create-researcher-reminders.mjs --confirm`.

## CRITICAL fixes applied (from 2026-04-23 strict review)

| # | Defect                                                                | Fix                                                                                     | File(s)                                                                                                      |
|---|-----------------------------------------------------------------------|-----------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
|C1 | Bracketless parser minted phantom initials (`GPU`, `NEW`, `TAC`)      | Bracketless token is only accepted if it matches a Members-DB row. Rejects are unparsed | `scripts/calendar-consistency-check.mjs`, `scripts/lib/calendar-parse.mjs`                                   |
|C2 | `Self-Pilot` FUZZY-merged to `Pilot`                                  | Strict canonical-equality match only. FUZZY status removed                              | `scripts/calendar-consistency-check.mjs`                                                                     |
|C3 | `pilot` / `self pilot` AMBIGUOUS skipped by Projects backfill         | Projects-by-canon index; AMBIGUOUS-in-Notion surfaces to researcher, not silently       | `scripts/calendar-consistency-check.mjs`, `scripts/backfill-notion-projects.mjs`                             |
|C4 | Dual-initial `[JYK BHL]` dropped second researcher                    | Parser returns `initials[]`; backfill writes all as Relation array                      | `scripts/lib/calendar-parse.mjs`, `scripts/backfill-notion-bookings.mjs`, `scripts/repair-backfilled-slab-rows.mjs` |
|H1 | Duplicate-row risk with runtime pipeline                              | Cross-check `bookings.google_event_id → bookings.notion_page_id` before creating. Back-write on create | `scripts/backfill-notion-bookings.mjs`                                                                       |
|H2 | Deleted calendar events leave stale progress entries                  | Orphan detector logs to `progress.orphan_progress[]` each run                           | `scripts/backfill-notion-bookings.mjs`                                                                       |
|H3 | 22 MJC rows landed with blank 실험자 Relation                         | Logged as `researcher_decisions` and in the repair report                               | `scripts/repair-backfilled-slab-rows.mjs`                                                                    |
|H4 | Supabase project match used substring (`'pilot'` in `'Pilot with Interns'`) | Canon-equality match                                                                    | `scripts/calendar-consistency-check.mjs`                                                                     |
|M1 | Parser drift between two scripts                                      | Consolidated to `scripts/lib/calendar-parse.mjs`                                        | new                                                                                                          |

## Decisions made autonomously

### Case/space normalization
17 raw project names observed in calendar titles → canonicalized by `trim().toLowerCase().replace(/[\s\-_]+/g, "-")`. Variants collapse:

| Canonical | Variants covered |
|---|---|
| `Pilot` | Pilot, pilot |
| `Self Pilot` | Self Pilot, self pilot, Self-Pilot |

### Blacklist
Non-project markers skipped entirely: `meeting: SK`, `Meeting: SK`.

### Bracketless title fallback
Events without `[INIT]` brackets are only accepted if the leading ALL-CAPS 2-4 token IS already in the Members DB. `GPU 회의`, `NEW EVENT`, `TAC meeting: SK` — all rejected as unparsed (would otherwise mint phantom members).

### Dual-initial brackets
`[BHL SYJ] pilot` / `[JYK BHL] LabTour 실습 준비` — both initials are preserved and written to `실험자` Relation as an array.

### Backfilled row 상태
All backfilled rows set `상태 = 완료` since they're past events.

## Researcher decisions still outstanding

### 1. Unknown initial: `MJC` (22 events)

`[MJC]` appears on 22 January events (all "Exp9"). No matching Members-DB row. The 22 Notion rows currently have empty `실험자` Relation; their `상태`, `프로젝트 (관련)`, date, time and 참여자 rich_text are all populated.

**Decision needed:** Add MJC to Members DB (then re-run `scripts/repair-backfilled-slab-rows.mjs --confirm` to link the 22 rows) — OR map to an existing initial — OR leave un-linked as historical.

### 2. Unparsed events (10)

| Date       | Summary                                                        | Why unparsed                                   |
|------------|----------------------------------------------------------------|-----------------------------------------------|
| 2026-01-12 | `Test`                                                          | No initial / format                           |
| 2026-01-20 | `GPU 회의`                                                      | Bracketless, GPU not in Members DB (C1)       |
| 2026-02-09 | `TAC meeting: SK`                                               | Bracketless, TAC not in Members DB (C1)       |
| 2026-03-12 | `Day 5 Sbj 5`                                                   | Truncated — no initial / no project           |
| 2026-03-31 | `New Event`                                                     | Placeholder                                    |
| 2026-04-02 | `tES 점검`                                                     | No initial / format                           |
| 2026-04-03 | `OpenLab`                                                       | No initial / format                           |
| 2026-04-03 | `Meeting: SK`                                                   | Blacklisted                                    |
| 2026-04-12 | `SYJ-BHL 실험 (Saemi Jung)`                                    | Dual-initial via dash (unsupported format)    |
| 2026-04-19 | `[실험] E2E 테스트 실험 … - 테스트 참가자`                     | System-generated E2E test                     |

**Decision needed:** edit titles in Google Calendar to the bracketed format and re-run the pipeline, or leave as-is.

### 3. Participant name duplicates

Same person entered in both Korean and English romanization:

| Korean | Romanized |
|---|---|
| 왕주미 | jumi wang |
| 김다영 | dayoung Kim |
| 이보현 | bohyun lee |
| 이효연 | Hyoyeon Lee |

Separate Notion rows exist for each form. Merge manually in Notion if desired.

### 4. Profile `csnl@vnilab.local` (admin)

No initial match. No action unless admin should appear as researcher on legacy events.

### 5. Missing 담당자 relation on new Projects pages

14 new Projects & Chores pages have only 항목명 populated — no 담당자 relation.  Proposed follow-up: `scripts/backfill-projects-owner.mjs` derives 담당자 from the dominant initial observed for each project.

## Re-running the pipeline

Scripts are idempotent; safe to re-run any time.

```bash
# 1. Regenerate consistency report (reflects current Supabase + Notion state)
node scripts/calendar-consistency-check.mjs

# 2. Create any still-missing Projects pages
node scripts/backfill-notion-projects.mjs --confirm

# 3. Link Supabase → Notion (skips rows already linked)
node scripts/backfill-supabase-relations.mjs --confirm

# 4. Create SLab booking pages for events not yet backfilled
node scripts/backfill-notion-bookings.mjs --confirm

# 5. Audit + repair already-written SLab rows (covers Relation drift,
#    dual-initial extension, logs MJC orphans)
node scripts/repair-backfilled-slab-rows.mjs --confirm

# 6. Fill Projects pages 담당자 / 기간 / 상태 / 분류 / 참여자 수 / 코드 디렉토리
node scripts/backfill-projects-metadata.mjs --confirm

# 7. Emit researcher reminders for experiments with missing metadata
node scripts/create-researcher-reminders.mjs --confirm
```

Progress is persisted per-script under `.test-artifacts/`:
- `calendar-consistency-report.json` — full cross-check output + decisions
- `calendar-backfill-progress.json` — event_id → notion_page_id for SLab
- `calendar-repair-report.json` — repair actions + orphan list

## Invariants to preserve

- Never write raw participant phone/email into Notion.
- Do not overwrite existing `notion_project_page_id` / `notion_member_page_id` values on Supabase rows (scripts explicitly null-check).
- Never PATCH a Notion row's user-editable fields (특이사항 etc.) on re-run. The repair script only writes Relation fields (실험자, 프로젝트 (관련)), never text fields.
- `.test-artifacts/` is gitignored (contains PII from parsed descriptions).
