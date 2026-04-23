import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import {
  buildClaimBundle,
  fetchClaimRows,
} from "@/lib/payments/claim-bundle";

// POST /api/experiments/:experimentId/payment-claim
//
// "참여자비 청구" click from the researcher UI. Bundles every
// submitted-but-not-yet-claimed participant into one ZIP and atomically
// transitions them to status='claimed'. Idempotent in the sense that
// re-clicking after a successful claim produces a 404 "nothing to claim"
// rather than duplicating.
//
// Auth: experiment owner or admin.
//
// Atomicity story: we run a compare-and-swap status transition per row
// (WHERE status='submitted_to_admin'). Only rows that successfully flipped
// are included in the bundle. If the ZIP generation fails after some rows
// flipped, we roll them back — failure path details in comments below.

export async function POST(
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

  // 1. Gather submitted rows. Cap at MAX_CLAIM_BATCH so a single claim
  //    doesn't try to hold (Excel + signature + bankbook) × N in memory
  //    for pathological experiment sizes. Researcher reclicks for the
  //    next batch — status flip ensures no duplicates.
  const MAX_CLAIM_BATCH = 200;
  const rows = (await fetchClaimRows(admin, experimentId)).slice(
    0,
    MAX_CLAIM_BATCH,
  );
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "청구할 참여자가 없습니다." },
      { status: 404 },
    );
  }

  // 2. Create the payment_claims row first so we have a claim_id to stamp
  //    onto every participant_payment_info row. We update the total_krw
  //    after status transitions complete (because some may fail the CAS).
  const { data: claim, error: claimErr } = await admin
    .from("payment_claims")
    .insert({
      experiment_id: experimentId,
      claimed_by: user.id,
      booking_group_ids: [],
      participant_count: 0,
      total_krw: 0,
      file_name: null,
    })
    .select("id")
    .single();
  if (claimErr || !claim) {
    return NextResponse.json(
      { error: "청구 레코드 생성에 실패했습니다." },
      { status: 500 },
    );
  }

  // 3. CAS each row from 'submitted_to_admin' → 'claimed'. We record
  //    only rows that actually flipped, so if a row's status changed
  //    between our SELECT and UPDATE (e.g. the researcher's partner
  //    clicked the same button concurrently), we silently drop it.
  const now = new Date().toISOString();
  const claimedRows: typeof rows = [];
  for (const r of rows) {
    const { error: updateErr, count } = await admin
      .from("participant_payment_info")
      .update(
        {
          status: "claimed",
          claimed_at: now,
          claimed_by: user.id,
          claimed_in: claim.id,
        },
        { count: "exact" },
      )
      .eq("booking_group_id", r.bookingGroupId)
      .eq("status", "submitted_to_admin");
    if (updateErr) {
      console.error(
        "[PaymentClaim] CAS update failed for",
        r.bookingGroupId,
        updateErr.message,
      );
      continue;
    }
    if ((count ?? 0) === 1) {
      claimedRows.push(r);
    }
  }

  if (claimedRows.length === 0) {
    // Nothing flipped — concurrent claim or race. Roll back the empty
    // claim row to avoid audit clutter.
    await admin.from("payment_claims").delete().eq("id", claim.id);
    return NextResponse.json(
      { error: "청구할 참여자가 없습니다." },
      { status: 404 },
    );
  }

  // 4. Build the ZIP. If this fails we roll back the CAS.
  let bundle;
  try {
    bundle = await buildClaimBundle(admin, claimedRows);
  } catch (err) {
    console.error(
      "[PaymentClaim] bundle build failed:",
      err instanceof Error ? err.message : "unknown",
    );
    // Roll back: revert claimed → submitted_to_admin only for rows still
    // in the 'claimed' state that point at this claim row. If another
    // session flipped one to 'paid' in the meantime (unlikely but
    // possible), we leave that row untouched — the claim row stays in
    // the DB as "partial claim record" and we keep the payment_exports
    // audit trail. Better to orphan a partial record than silently
    // violate the invariant that paid rows have a claim_in.
    const ids = claimedRows.map((r) => r.bookingGroupId);
    await admin
      .from("participant_payment_info")
      .update({
        status: "submitted_to_admin",
        claimed_at: null,
        claimed_by: null,
        claimed_in: null,
      })
      .in("booking_group_id", ids)
      .eq("claimed_in", claim.id)
      .eq("status", "claimed"); // CAS: only reverse rows still in 'claimed'

    // Only delete the claim row if zero rows still reference it. If any
    // row was concurrently moved to 'paid' (keeping claimed_in set), the
    // claim stays in the DB as a historical artefact.
    const { count: stillRefs } = await admin
      .from("participant_payment_info")
      .select("id", { count: "exact", head: true })
      .eq("claimed_in", claim.id);
    if ((stillRefs ?? 0) === 0) {
      await admin.from("payment_claims").delete().eq("id", claim.id);
    }
    return NextResponse.json(
      { error: "청구 번들 생성에 실패했습니다." },
      { status: 500 },
    );
  }

  // 5. Back-fill the claim row with final numbers + file name.
  const fileName = buildClaimFileName(experiment.title, claimedRows.length);
  await admin
    .from("payment_claims")
    .update({
      booking_group_ids: bundle.includedBookingGroupIds,
      participant_count: bundle.participantCount,
      total_krw: bundle.totalKrw,
      file_name: fileName,
    })
    .eq("id", claim.id);

  // 6. Write a payment_exports audit row mirroring the claim.
  await admin.from("payment_exports").insert({
    experiment_id: experimentId,
    exported_by: user.id,
    export_kind: "claim_bundle",
    participant_count: bundle.participantCount,
    participant_ids: claimedRows.map((r) => r.participantId),
    file_name: fileName,
  });

  const asciiName = `claim-${experimentId.slice(0, 8)}-${Date.now()}.zip`;
  const star = encodeURIComponent(fileName);

  return new NextResponse(bundle.zipBuffer as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${star}`,
      "Cache-Control": "no-store",
      "X-Claim-Id": claim.id,
      "X-Participant-Count": String(bundle.participantCount),
      "X-Total-Krw": String(bundle.totalKrw),
    },
  });
}

function buildClaimFileName(experimentTitle: string, count: number): string {
  // Strip filesystem-unsafe chars + leading dots (path traversal guard) +
  // cap at 80 chars so Content-Disposition headers stay short.
  const safe = experimentTitle
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80) || "experiment";
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `실험참여자비청구_${safe}_${yyyymmdd}_${count}명.zip`;
}
