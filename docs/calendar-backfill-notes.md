# 2026 Calendar backfill notes

Run date: 2026-04-23 KST.
Target: SLab Google Calendar (`dvjmpc33e56l0euaq4c0dekvu4@group.calendar.google.com`)
Window: 2026-01-01 ~ 2026-12-31 (245 events fetched).

## What got backfilled

- **Notion Projects & Chores** — 13 new canonical project pages created (see list below). Case/space variants merged (Pilot/pilot/Self Pilot/self pilot/Self-Pilot → 2 canonical pages). 1 non-project name (`meeting: SK`) deliberately skipped.
- **Supabase linkage** — all 2 existing experiments linked to their matching Notion Projects page via `experiments.notion_project_page_id`. 3/4 profiles linked to CSNL Members page via `profiles.notion_member_page_id` (matched by email-local-part → initial).
- **Notion SLab booking rows** — one row per parsed 2026 calendar event (236/245 parsed). Each row populated with 실험명 / 실험날짜 / 시간 / 프로젝트 / 피험자 ID / 회차 / 참여자 / 실험자 Relation / 프로젝트(관련) Relation / 상태=완료.

## Decisions made autonomously

These aren't researcher-input calls — they were defaults picked to keep the backfill moving. Flag in review if any is wrong.

### Case/space normalization
The 17 raw project names observed in calendar titles were normalized by lowercase + collapse `[\s_-]+` to `-`, merging case/separator variants to one canonical Notion page:

| Canonical | Variants covered |
|---|---|
| `Pilot` | Pilot, pilot |
| `Self Pilot` | Self Pilot, self pilot, Self-Pilot |

All others kept as single canonical. If researchers actually meant different things by `Pilot` vs `Self Pilot` vs `self pilot` etc, split pages manually in Notion UI.

### Blacklist
Events whose "project" string was actually a non-experiment annotation got skipped entirely. Current blacklist:
- `meeting: SK`

### Title parsing fallback
Events without `[INIT]` brackets but starting with an ALL-CAPS 2-4 letter token followed by whitespace/colon (e.g. `JOP Pilot`, `JOP: Pilot`, `BYL self pilot`) were parsed as if the prefix WAS a bracketed initial. 8 events recovered this way.

### Dual-initial brackets
Events like `[BHL SYJ] pilot` / `[JYK BHL] LabTour 실습 준비` were credited to the FIRST initial only. The second researcher is noted but not relation-linked.

### Backfilled row 상태
All backfilled rows set `상태 = 완료` since they're past events.

## Researcher decisions still outstanding

### 1. Unknown initial: `MJC` (22 events)

`[MJC]` appears on 22 events through January (all "Exp9" project). No matching row in Members DB. Candidates: JHR/JSL/SMJ/JOP/SK/BYL/JYK/SYJ/MSY/BHL/MIN JIN/SL.

**Decision needed:** Add MJC to Members DB and re-run `scripts/backfill-supabase-relations.mjs`, or map to an existing initial, or leave un-linked (rows already have 실험자 relation blank).

### 2. Unparsed events (9 remaining after parser improvements)

These aren't experiments per format, but may still warrant Notion entries if they're tracked work:

- 2026-01-12 `Test`
- 2026-01-20 `GPU 회의`
- 2026-02-09 `TAC meeting: SK`
- 2026-03-12 `Day 5 Sbj 5` (truncated title — no project)
- 2026-03-26 `[JYK BHL] LabTour 실습 준비` (this DOES parse if we treat it as dual-initial with project='LabTour 실습 준비' — currently parsed and row created for JYK only; flag for review)
- 2026-03-31 `New Event` (placeholder)
- 2026-04-02 `tES 점검`
- 2026-04-03 `OpenLab`
- 2026-04-19 `[실험] E2E 테스트 실험 …` (system-generated E2E test)

**Decision needed:** which (if any) of these should become Notion rows.

### 3. Participant name duplicates

Participant names observed in BOTH Korean and English romanization for the same person:

| Korean | Romanized (same count range) |
|---|---|
| 왕주미 (5) | jumi wang (7) |
| 김다영 (5) | dayoung Kim (6) |
| 이보현 (10) | bohyun lee (6) |
| 이효연 (5) | Hyoyeon Lee (7) |

Current backfill created separate Notion rows treating them as distinct participants.

**Decision needed:** merge in Notion by editing the 참여자 column on duplicates, OR keep separate for historical accuracy, OR write a follow-up script that canonicalizes (risky — need the mapping from researcher).

### 4. Profile `csnl@vnilab.local` (admin)

No initial matches — by design, admin doesn't run experiments. Currently has no `notion_member_page_id`. No action needed unless this admin should also appear as a researcher on some legacy events.

### 5. Missing 담당자 relation on new Projects pages

The 13 newly-created Projects & Chores pages are empty except for 항목명 title. No 담당자 (relation to Members) is filled.

**Decision needed:** auto-fill 담당자 from the dominant initial that appears for each project in the calendar? (E.g. "Main task" has mostly BYL events → 담당자 = BYL's Members page.) Proposed follow-up script: `scripts/backfill-projects-owner.mjs`.

## Re-running steps

All backfill scripts are idempotent:

```bash
# Regenerate consistency report (reflects current Supabase + Notion state)
node scripts/calendar-consistency-check.mjs

# Create missing Projects pages (skips ones already present)
node scripts/backfill-notion-projects.mjs --confirm

# Link Supabase experiments.notion_project_page_id + profiles.notion_member_page_id
node scripts/backfill-supabase-relations.mjs --confirm

# Create SLab booking pages for events not yet backfilled (reads progress file)
node scripts/backfill-notion-bookings.mjs --confirm
```

`.test-artifacts/calendar-backfill-progress.json` tracks which Google Calendar event IDs already produced a Notion booking row, so re-runs skip them.

## Invariants to preserve

- Never write raw participant phone/email into Notion.
- Do not overwrite existing `notion_project_page_id` / `notion_member_page_id` values on Supabase rows (scripts explicitly check for null first).
- Only create NEW Notion rows; never PATCH existing backfilled rows on re-run (if someone edits 특이사항 in Notion, we leave it alone).
