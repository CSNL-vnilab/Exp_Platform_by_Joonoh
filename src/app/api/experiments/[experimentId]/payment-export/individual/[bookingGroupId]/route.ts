import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import {
  buildIndividualFormWorkbook,
  formatDateSpan,
  type ExportParticipant,
} from "@/lib/payments/excel";

// GET /api/experiments/:experimentId/payment-export/individual/:bookingGroupId
//
// Streams a single 실험참여자비 양식_{name}.xlsx for the participant whose
// booking_group matches. Same auth rules as the upload-form route:
// researcher-owner or admin. RRN decrypt + signature fetch both happen
// server-side; bytes never leak out.

export async function GET(
  _req: NextRequest,
  ctx: {
    params: Promise<{ experimentId: string; bookingGroupId: string }>;
  },
) {
  const { experimentId, bookingGroupId } = await ctx.params;
  if (!isValidUUID(experimentId) || !isValidUUID(bookingGroupId)) {
    return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: experiment } = await admin
    .from("experiments")
    .select("id, created_by")
    .eq("id", experimentId)
    .maybeSingle();
  if (!experiment) {
    return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
  }
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isOwner = experiment.created_by === user.id;
  const isAdmin = profile?.role === "admin";
  if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: row } = await admin
    .from("participant_payment_info")
    .select(
      "id, booking_group_id, participant_id, rrn_cipher, rrn_iv, rrn_tag, rrn_key_version, bank_name, account_number, account_holder, institution, signature_path, period_start, period_end, amount_krw, status, participants(name, email)",
    )
    .eq("experiment_id", experimentId)
    .eq("booking_group_id", bookingGroupId)
    .maybeSingle();

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.status === "pending_participant") {
    return NextResponse.json(
      { error: "참가자가 아직 정산 정보를 입력하지 않았습니다." },
      { status: 409 },
    );
  }

  const { data: bookings } = await admin
    .from("bookings")
    .select("slot_start, slot_end")
    .eq("booking_group_id", bookingGroupId)
    .order("slot_start", { ascending: true });
  const sessions = bookings ?? [];
  const totalMs = sessions.reduce(
    (acc, b) => acc + (new Date(b.slot_end).getTime() - new Date(b.slot_start).getTime()),
    0,
  );
  const hours = totalMs > 0 ? totalMs / (1000 * 60 * 60) : 0;
  const first = sessions[0];

  // Fetch signature from private storage.
  let signaturePng: Buffer | null = null;
  if (row.signature_path) {
    const { data: file } = await admin.storage
      .from("participant-signatures")
      .download(row.signature_path);
    if (file) {
      const buf = Buffer.from(await file.arrayBuffer());
      signaturePng = buf;
    }
  }

  const info = row as unknown as {
    institution: string | null;
    participants: { name: string; email: string | null } | null;
  };
  const participantName = info.participants?.name ?? "";

  const participant: ExportParticipant = {
    participantId: row.participant_id,
    bookingGroupId: row.booking_group_id,
    name: participantName,
    email: info.participants?.email ?? null,
    rrnCipher: row.rrn_cipher,
    rrnIv: row.rrn_iv,
    rrnTag: row.rrn_tag,
    rrnKeyVersion: row.rrn_key_version,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    accountHolder: row.account_holder,
    signaturePng,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    amountKrw: row.amount_krw,
    participationHours: Math.round(hours * 10) / 10,
    institution: info.institution ?? "서울대학교",
    activityDateSpan: formatDateSpan(row.period_start, row.period_end),
    firstSessionStart: first ? isoToHHMM(first.slot_start) : null,
    firstSessionEnd: first ? isoToHHMM(first.slot_end) : null,
  };

  const buffer = await buildIndividualFormWorkbook(participant);

  await admin.from("payment_exports").insert({
    experiment_id: experimentId,
    exported_by: user.id,
    export_kind: "individual_form",
    participant_count: 1,
    participant_ids: [row.participant_id],
    file_name: `실험참여자비 양식_${participantName}.xlsx`,
  });

  const safeName = participantName.replace(/[^a-zA-Z0-9가-힣_-]/g, "_") || "참가자";
  const displayName = `실험참여자비 양식_${safeName}.xlsx`;
  const ascii = `participant-form-${row.booking_group_id.slice(0, 8)}.xlsx`;
  const filenameStar = encodeURIComponent(displayName);

  return new NextResponse(buffer as BodyInit, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${filenameStar}`,
      "Cache-Control": "no-store",
    },
  });
}

function isoToHHMM(iso: string): string {
  // Force Asia/Seoul — Vercel runs UTC by default.
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}
