---
description: How the BCC-from-self recruitment ("홍보") email flow works — editable subject/body template seeded from experiment metadata, server-rendered preview, single send To: GMAIL_USER + BCC: deliverable participants. Use when working on promo email, recruitment mail, or experiment promotion. Triggers on "promo email", "홍보 메일", "recruitment email", "BCC blast".
---

# Lab-reservation BCC promo-email workflow

## Architecture

- **Single template builder** (`src/lib/services/participant-promo-email.ts`): `buildPromoTemplate(experiment)` returns `{ subject, body }` seeded from `experiments.{title, start_date, end_date, weekdays, daily_start_time, daily_end_time, session_type, required_sessions, participation_fee, experiment_mode}` + the joined `experiment_locations(name)`.
- **Long lab name** comes from `BRAND_FULL_NAME` (`NEXT_PUBLIC_LAB_FULL_NAME` env, falls back to `BRAND_NAME`) — used in the intro prose. Sign-off uses short `BRAND_NAME`.
- **Server render**: `renderPromoHtml(body)` is the single source of truth for both preview and send — escapes, linkifies URLs, `<br>` for newlines, wraps with branded email shell. WYSIWYG for the operator.
- **Audit log**: `participant_promo_sends` (migration 00060) — one row per recipient per campaign, sharing the SMTP message-id. Used to mark "기발송" and skip on the next campaign for the same experiment.

## Send model — "self with BCC", not per-recipient

The route at `/api/participants/promo-email` does ONE `sendEmail` call:
- `to`: `process.env.GMAIL_USER` (the lab's own sending account — sends to itself).
- `bcc`: every deliverable participant's email.
- `subject` / `html` / `text` from the operator-edited body.

Why: addresses never leak between recipients, no per-recipient SMTP round-trip, one message-id covers the whole campaign.

## Three hard-gate exclusions

In the recipient resolver:

1. **Undeliverable email** — placeholder forms (`@-`, `@no-email.local`, `@imported.invalid`, `@vnilab.local`, `@example.com`) and anything not matching the basic email regex.
2. **Already sent** — joined `participant_promo_sends` rows with `status='sent'` for this experiment id.
3. **Blacklisted** — joined latest non-expired `participant_classes` row with `class='blacklist'`. Unconditional override — even a valid never-sent email is forced `deliverable=false`. See `blacklistedSet` for the implementation.

## Modal UX (`src/components/promo-email-modal.tsx`)

Three states:
- `pick` — choose an active experiment from the mode-scoped dropdown (offline tab → offline experiments only).
- `preview` — server-rendered HTML in an iframe, editable subject/body textareas. "미리보기" re-renders.
- `done` — per-campaign counts (sent / undeliverable / blacklisted / already-sent).

Confirmation is explicit — `mode: "send", confirm: true` body. Nothing auto-fires.

## Default template structure (2026-05-20)

```
안녕하세요, 

{BRAND_FULL_NAME}에서 「{title}」 실험 참여자를 모집합니다.
아래 내용을 확인하시고 관심이 있으시면 예약 페이지에서 편하신 시간을 선택해 주세요.

· 모집 기간: {start_date} ~ {end_date}
· 운영 요일: {weekdays}
· 운영 시간: {HH:MM} ~ {HH:MM}
· 세션: {duration}분 × {required_sessions}회차
· 참여비: {fee}원
· 장소: {experiment_locations.name}     ← only when location_id is set

▶ 예약 페이지:
{appBase}/book/{experimentId}

감사합니다
{BRAND_NAME} 드림
```

Removed from the default (vs. earlier iterations): project line, `· {mode}` tag on session, `[실험 소개]` block, "더 이상 모집 안내…" opt-out footer. The operator can add any of those back via the textarea per send.

## When you're modifying any of this

- Keep `renderPromoHtml` as the single render path. If you add features (formatting, signatures, etc.) put them in that function so preview = sent.
- Never CC/BCC participants alongside each other in a per-recipient send loop; the "single message + BCC" model is intentional and the privacy story.
- New exclusion rules go into the recipient resolver alongside `blacklistedSet`, not into the SMTP send path.
