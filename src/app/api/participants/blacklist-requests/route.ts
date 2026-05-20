import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { sendBlacklistApprovalRequestEmail } from "@/lib/services/blacklist-request-email";

// /api/participants/blacklist-requests
//
// Researcher-initiated blacklist request flow (migration 00061).
//   POST   → create N pending requests, one per selected participant
//            id, sharing the reason + optional phone-last4 supplied in
//            the modal. Fires an approval-request email vnilab→vnilab
//            (CC: requester) per request.
//   GET    → list requests. Admin sees all; researcher sees own.
//            Optional ?status=pending|approved|rejected|all (default
//            'pending').
//
// The 60-second class-change cooldown does not apply here — these
// are *requests*; the actual class flip happens on the admin approval
// endpoint via assign_participant_class_manual (which still serializes
// via advisory lock).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LAB_CODE = "CSNL";
const MAX_BATCH = 100;

const createSchema = z.object({
  participantIds: z.array(z.string()).min(1).max(MAX_BATCH),
  reason: z.string().trim().min(2).max(500),
  phoneLast4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "phoneLast4는 숫자 4자리여야 합니다")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

async function requireMember(): Promise<
  | {
      ok: true;
      userId: string;
      role: "admin" | "researcher";
      admin: ReturnType<typeof createAdminClient>;
    }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, disabled")
    .eq("id", user.id)
    .maybeSingle();
  const p = profile as { role?: string; disabled?: boolean } | null;
  if (!p || p.disabled || (p.role !== "admin" && p.role !== "researcher")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return {
    ok: true,
    userId: user.id,
    role: p.role as "admin" | "researcher",
    admin,
  };
}

// Approval-email enrichment helper.
async function fireApprovalEmails(
  admin: ReturnType<typeof createAdminClient>,
  requestRows: Array<{
    id: string;
    participant_id: string;
    reason: string;
    phone_last4: string | null;
  }>,
  requesterId: string,
  labId: string,
): Promise<void> {
  // Look up requester profile + participants in two batched queries.
  const { data: requester } = await admin
    .from("profiles")
    .select("display_name, contact_email")
    .eq("id", requesterId)
    .maybeSingle();
  const participantIds = [...new Set(requestRows.map((r) => r.participant_id))];
  const { data: parts } = await admin
    .from("participants")
    .select("id, name, email")
    .in("id", participantIds);
  const partMap = new Map(
    (parts ?? []).map((p) => [p.id, p as { id: string; name: string | null; email: string | null }]),
  );
  // public_code lookup
  const { data: ids } = await admin
    .from("participant_lab_identity")
    .select("participant_id, public_code")
    .eq("lab_id", labId)
    .in("participant_id", participantIds);
  const codeMap = new Map(
    (ids ?? []).map((r) => [r.participant_id, r.public_code as string]),
  );

  for (const req of requestRows) {
    const p = partMap.get(req.participant_id);
    sendBlacklistApprovalRequestEmail({
      requestId: req.id,
      participantName: p?.name ?? null,
      participantEmail: p?.email ?? null,
      participantPublicCode: codeMap.get(req.participant_id) ?? null,
      phoneLast4: req.phone_last4,
      reason: req.reason,
      requesterName: (requester as { display_name?: string | null } | null)?.display_name ?? null,
      requesterContactEmail:
        (requester as { contact_email?: string | null } | null)?.contact_email ?? null,
    }).catch((err) => {
      console.error(
        "[BlacklistReq] approval email fire-and-forget failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }
}

// ── POST: create requests ──
export async function POST(request: NextRequest) {
  const auth = await requireMember();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { admin, userId } = auth;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const ids = [...new Set(parsed.data.participantIds)].filter(isValidUUID);
  if (ids.length === 0) {
    return NextResponse.json({ error: "유효한 참여자가 없습니다" }, { status: 400 });
  }
  const reason = parsed.data.reason;
  const phoneLast4 = parsed.data.phoneLast4 ?? null;

  // Resolve lab id.
  const { data: lab } = await admin
    .from("labs")
    .select("id, code")
    .eq("code", LAB_CODE)
    .maybeSingle();
  if (!lab?.id) {
    return NextResponse.json({ error: "Lab not found" }, { status: 500 });
  }

  // Skip participants who are already blacklisted (no point) or have a
  // pending request — but allow approved/rejected re-submissions.
  const { data: existingClasses } = await admin
    .from("participant_classes")
    .select("participant_id, class, valid_from, valid_until")
    .eq("lab_id", lab.id)
    .in("participant_id", ids)
    .order("valid_from", { ascending: false });
  const latestClass = new Map<string, string>();
  const now = Date.now();
  for (const row of (existingClasses ?? []) as Array<{
    participant_id: string;
    class: string;
    valid_until: string | null;
  }>) {
    if (latestClass.has(row.participant_id)) continue;
    if (row.valid_until && new Date(row.valid_until).getTime() <= now) continue;
    latestClass.set(row.participant_id, row.class);
  }
  const { data: pendingExisting } = await admin
    .from("participant_blacklist_requests")
    .select("participant_id")
    .eq("lab_id", lab.id)
    .eq("status", "pending")
    .in("participant_id", ids);
  const pendingIds = new Set(
    ((pendingExisting ?? []) as Array<{ participant_id: string }>).map((r) => r.participant_id),
  );

  const insertRows: Array<{
    participant_id: string;
    lab_id: string;
    requested_by: string;
    reason: string;
    phone_last4: string | null;
  }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const pid of ids) {
    if (latestClass.get(pid) === "blacklist") {
      skipped.push({ id: pid, reason: "이미 블랙리스트" });
      continue;
    }
    if (pendingIds.has(pid)) {
      skipped.push({ id: pid, reason: "이미 승인 대기 중인 요청 있음" });
      continue;
    }
    insertRows.push({
      participant_id: pid,
      lab_id: lab.id,
      requested_by: userId,
      reason,
      phone_last4: phoneLast4,
    });
  }

  if (insertRows.length === 0) {
    return NextResponse.json(
      {
        ok: true,
        created: 0,
        skipped,
        note: "All selected participants are already blacklisted or have a pending request.",
      },
      { status: 200 },
    );
  }

  const { data: inserted, error: insErr } = await admin
    .from("participant_blacklist_requests")
    .insert(insertRows)
    .select("id, participant_id, reason, phone_last4");
  if (insErr) {
    return NextResponse.json(
      { error: `요청 저장 실패: ${insErr.message}` },
      { status: 500 },
    );
  }

  // Fire approval-request emails (vnilab→vnilab, CC requester).
  void fireApprovalEmails(
    admin,
    inserted as Array<{
      id: string;
      participant_id: string;
      reason: string;
      phone_last4: string | null;
    }>,
    userId,
    lab.id,
  );

  return NextResponse.json(
    {
      ok: true,
      created: inserted?.length ?? 0,
      skipped,
    },
    { status: 201 },
  );
}

// ── GET: list requests ──
export async function GET(request: NextRequest) {
  const auth = await requireMember();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const url = new URL(request.url);
  const statusRaw = (url.searchParams.get("status") ?? "pending").toLowerCase();
  const statusFilter =
    statusRaw === "pending" ||
    statusRaw === "approved" ||
    statusRaw === "rejected"
      ? statusRaw
      : null; // 'all' → no filter

  let q = auth.admin
    .from("participant_blacklist_requests")
    .select(
      "id, participant_id, lab_id, requested_by, reason, phone_last4, status, approved_by, approved_at, rejected_reason, created_at",
    )
    .order("created_at", { ascending: false });
  if (statusFilter) q = q.eq("status", statusFilter);
  // Researchers only see their own.
  if (auth.role !== "admin") q = q.eq("requested_by", auth.userId);

  const { data: rows, error } = await q.limit(500);
  if (error) {
    return NextResponse.json(
      { error: "목록 조회 실패" },
      { status: 500 },
    );
  }
  const list = (rows ?? []) as Array<{
    id: string;
    participant_id: string;
    requested_by: string;
    reason: string;
    phone_last4: string | null;
    status: string;
    approved_by: string | null;
    approved_at: string | null;
    rejected_reason: string | null;
    created_at: string;
  }>;

  // Hydrate participant + requester names for the UI.
  const participantIds = [...new Set(list.map((r) => r.participant_id))];
  const requesterIds = [...new Set(list.map((r) => r.requested_by))];
  const [{ data: parts }, { data: profs }] = await Promise.all([
    auth.admin
      .from("participants")
      .select("id, name, email")
      .in("id", participantIds),
    auth.admin
      .from("profiles")
      .select("id, display_name, contact_email")
      .in("id", requesterIds),
  ]);
  const partMap = new Map(
    ((parts ?? []) as Array<{ id: string; name: string | null; email: string | null }>).map(
      (p) => [p.id, p],
    ),
  );
  const reqMap = new Map(
    ((profs ?? []) as Array<{ id: string; display_name: string | null; contact_email: string | null }>).map(
      (p) => [p.id, p],
    ),
  );

  return NextResponse.json({
    requests: list.map((r) => ({
      ...r,
      participant: partMap.get(r.participant_id) ?? null,
      requester: reqMap.get(r.requested_by) ?? null,
    })),
  });
}
