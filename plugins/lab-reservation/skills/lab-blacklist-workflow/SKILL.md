---
description: How the lab-reservation blacklist flow works end-to-end — researcher request, admin approval, class flip, phone last-4 stamp, cascade-cancel, promo-email hard gate. Use when working on `participant_blacklist_requests`, the blacklist queue UI, or the `participant_classes` table. Triggers on "blacklist", "블랙리스트", "block participant", "ban".
---

# Lab-reservation blacklist request → approval workflow

## Data model

- `participant_classes` (migration 00025) — append-only class history per (participant, lab). Latest non-expired row wins as effective class. Classes: `newbie / royal / blacklist / vip`.
- `participant_class_audit` (migration 00025) — trigger-written log of every class transition. FK on `participant_id` is RESTRICT (not CASCADE) so deleting a participant fails with FK violation until you delete audit rows first.
- `participant_blacklist_requests` (migration 00061) — pending / approved / rejected queue. Partial UNIQUE (`participant_id`, `lab_id`) WHERE `status = 'pending'` prevents duplicate open requests.
- `assign_participant_class_manual(p_participant_id, p_lab_id, p_class, p_reason, p_valid_until, p_assigned_by)` RPC (migration 00029) — the single source of truth for manual class flips. Takes an advisory lock per `(participant, lab)`, audit trigger fires on the INSERT.

## Flow (already shipped to main)

1. **Researcher selects participants** on `/participants` (the lab-wide roster is open to all members per the 2026-05-19 directive). The selection bar shows **"블랙리스트 등록 신청"** alongside the **"홍보 메일 보내기"** button.

2. **`BlacklistRequestModal`** collects a 사유 (required, 2–500 chars) + optional 전화번호 끝 4자리 (any input format; only last-4 stored). POST to `/api/participants/blacklist-requests`.

3. **Route inserts N pending rows** (one per selected participant, shared reason), skipping anyone already-blacklisted or already-pending. Fires `sendBlacklistApprovalRequestEmail` per row — `vnilab@gmail.com → vnilab@gmail.com (CC: requester contact_email)` with participant identifiers and 승인 큐 link. Fire-and-forget so SMTP flakes don't fail the insert.

4. **Admin opens `/blacklist-requests`** (sidebar "블랙리스트 승인", admin-only via `requireAdmin`). Status-tabbed queue.

5. **승인**: POST `/api/participants/blacklist-requests/[id]` with `{ action: "approve" }`. Atomic steps:
   - `assign_participant_class_manual(...class='blacklist')` — RPC handles advisory lock + audit trigger.
   - If the request carried `phone_last4`: `UPDATE participants SET phone = '<last4>'` (privacy guard — full phone never stored for blacklisted rows).
   - Cascade-cancel future confirmed/running bookings (P2-3 mirror).
   - Mark request `status='approved'` with approver + timestamp.

6. **반려**: POST same endpoint with `{ action: "reject", rejectedReason }`. Just updates the request row.

## Hard gate: promo email NEVER goes to a blacklisted participant

In `/api/participants/promo-email`, after resolving the recipient list, the route loads each participant's latest non-expired class row and forces `deliverable = false` whenever it's `blacklist`. This is unconditional — even a valid email with no prior send goes to the `blacklisted` bucket in the recipient breakdown. See `blacklistedSet` in `src/app/api/participants/promo-email/route.ts`.

## UI display

- Roster row, 클래스 column: `ClassBadge` + (for blacklist) the reason text in red beneath the badge.
- `/experiments/{id}` 세션 설정 card: `참여자 수 N(현재) / M(최대)` counts DISTINCT participant_id over engaged statuses (`confirmed / running / completed / no_show`) — pure-cancelled participants fall out of the count automatically, same semantics as `book_slot`'s recruitment gate.

## When you're modifying any of this

- Class assignment goes through the RPC; never `INSERT INTO participant_classes` directly from app code.
- Phone last-4 stamp is the standing privacy policy for blacklisted rows. Don't auto-restore the full phone on un-blacklist; the full number is gone the moment approval fires.
- A re-blacklist on someone already blacklisted (e.g. updating the reason) is just another `assign_participant_class_manual` call — schema is append-only, latest reason wins.
