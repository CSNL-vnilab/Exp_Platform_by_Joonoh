import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import {
  buildUploadFormWorkbook,
  formatDateSpan,
  type ExportParticipant,
} from "@/lib/payments/excel";

// GET /api/experiments/:experimentId/payment-export/upload-form
//
// Streams the combined 일회성경비지급자_업로드양식_작성.xlsx for every
// participant in this experiment whose payment_info.status is
// 'submitted_to_admin' or 'paid'. Pending rows are excluded (no PII to
// render).
//
// Auth: requires the caller be the experiment's created_by (researcher) or
// an admin. RRN decrypt only happens inside this request handler; cipher-
// text never leaves the server.
//
// Audit: writes a payment_exports row with participant_ids + count +
// file_name so the export is visible on the admin payment log.

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await ctx.params;
  if (!isValidUUID(experimentId)) {
    return NextResponse.json({ error: "Invalid experiment ID" }, { status: 400 });
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

  // Auth check: researcher-owner or admin.
  const { data: experiment } = await admin
    .from("experiments")
    .select("id, title, created_by")
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

  // Pull submitted payment rows + joined participant data. Bookings are
  // pulled separately to compute total participation hours.
  const { data: rows } = await admin
    .from("participant_payment_info")
    .select(
      // name_override / email_override / phone added by migration 00050.
      "id, booking_group_id, participant_id, rrn_cipher, rrn_iv, rrn_tag, rrn_key_version, bank_name, account_number, account_holder, institution, signature_path, period_start, period_end, amount_krw, status, name_override, email_override, phone, participants(name, email, phone)",
    )
    .eq("experiment_id", experimentId)
    // 'claimed' rows are included — post-청구 the researcher still needs
    // to re-export the upload form to hand to 행정 while disbursement is
    // pending, and the admin still needs a paper trail once paid.
    .in("status", ["submitted_to_admin", "claimed", "paid"])
    .order("submitted_at", { ascending: true });

  if (!rows || rows.length === 0) {
    return NextResponse.json(
      { error: "제출된 정산 정보가 없습니다." },
      { status: 404 },
    );
  }

  // Batch-fetch all bookings once instead of per-row round-trips. For a
  // 200-participant experiment that drops 200 round-trips to 1.
  const bgIds = rows.map((r) => r.booking_group_id);
  const { data: allBookings } = await admin
    .from("bookings")
    .select("booking_group_id, slot_start, slot_end")
    .in("booking_group_id", bgIds)
    .order("slot_start", { ascending: true });

  const sessionsBy = new Map<
    string,
    Array<{ slot_start: string; slot_end: string }>
  >();
  for (const b of allBookings ?? []) {
    if (!b.booking_group_id) continue;
    const list = sessionsBy.get(b.booking_group_id) ?? [];
    list.push({ slot_start: b.slot_start, slot_end: b.slot_end });
    sessionsBy.set(b.booking_group_id, list);
  }

  // Build ExportParticipant list. Hours/date-span come from bookings.
  const participants: ExportParticipant[] = [];
  for (const r of rows) {
    const sessions = sessionsBy.get(r.booking_group_id) ?? [];
    const totalMs = sessions.reduce((acc, b) => {
      return acc + (new Date(b.slot_end).getTime() - new Date(b.slot_start).getTime());
    }, 0);
    const hours = totalMs > 0 ? totalMs / (1000 * 60 * 60) : 0;

    const first = sessions[0];
    const firstStart = first ? isoToHHMM(first.slot_start) : null;
    const firstEnd = first ? isoToHHMM(first.slot_end) : null;

    // Signature is embedded in individual forms only; the combined upload
    // form doesn't include signatures per the admin's template.
    const info = r as unknown as {
      institution: string | null;
      name_override: string | null;
      email_override: string | null;
      phone: string | null;
      participants: { name: string; email: string | null; phone: string | null } | null;
    };
    participants.push({
      participantId: r.participant_id,
      bookingGroupId: r.booking_group_id,
      name: info.name_override ?? info.participants?.name ?? "",
      email: info.email_override ?? info.participants?.email ?? null,
      phone: info.phone ?? info.participants?.phone ?? null,
      rrnCipher: r.rrn_cipher,
      rrnIv: r.rrn_iv,
      rrnTag: r.rrn_tag,
      rrnKeyVersion: r.rrn_key_version,
      bankName: r.bank_name,
      accountNumber: r.account_number,
      accountHolder: r.account_holder,
      signaturePng: null,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      amountKrw: r.amount_krw,
      participationHours: Math.round(hours * 10) / 10,
      institution: info.institution ?? "서울대학교",
      activityDateSpan: formatDateSpan(r.period_start, r.period_end),
      firstSessionStart: firstStart,
      firstSessionEnd: firstEnd,
    });
  }

  const buffer = await buildUploadFormWorkbook(participants);

  // Audit.
  await admin.from("payment_exports").insert({
    experiment_id: experimentId,
    exported_by: user.id,
    export_kind: "upload_form",
    participant_count: participants.length,
    participant_ids: participants.map((p) => p.participantId),
    file_name: "일회성경비지급자_업로드양식_작성.xlsx",
  });

  const ascii = `upload-form-${experimentId.slice(0, 8)}.xlsx`;
  const filenameStar = encodeURIComponent("일회성경비지급자_업로드양식_작성.xlsx");

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
  // Format in Asia/Seoul explicitly — Vercel runs in UTC and getHours()
  // would report UTC hours, shifting session times by -9h.
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}
