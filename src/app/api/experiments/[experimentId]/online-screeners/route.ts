import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";

// GET  /api/experiments/:id/online-screeners          — list
// PUT  /api/experiments/:id/online-screeners          — replace list (atomic)
//
// Researcher-only. The shape matches experiment_online_screeners rows but
// position is derived from array index on PUT (0-based, then *100 so we
// can interleave new ones later without renumbering).

const screenerSchema = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum(["yes_no", "numeric", "single_choice", "multi_choice"]),
  question: z.string().min(1).max(1000),
  help_text: z.string().max(1000).nullable().optional(),
  validation_config: z.record(z.string(), z.unknown()).default({}),
  required: z.boolean().default(true),
});

async function requireResearcher(experimentId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: 401, error: "Unauthorized" as const };
  const admin = createAdminClient();
  const { data: exp } = await admin
    .from("experiments")
    .select("created_by")
    .eq("id", experimentId)
    .maybeSingle();
  if (!exp) return { status: 404, error: "Not found" as const };
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  if (!isAdmin && exp.created_by !== user.id)
    return { status: 403, error: "Forbidden" as const };
  return { admin, user };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await params;
  if (!isValidUUID(experimentId))
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const guard = await requireResearcher(experimentId);
  if ("error" in guard)
    return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { data } = await guard.admin
    .from("experiment_online_screeners")
    .select("*")
    .eq("experiment_id", experimentId)
    .order("position", { ascending: true });
  return NextResponse.json({ screeners: data ?? [] });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await params;
  if (!isValidUUID(experimentId))
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const guard = await requireResearcher(experimentId);
  if ("error" in guard)
    return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null);
  const parsed = z.array(screenerSchema).max(50).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Transactional-ish replace: delete then insert. Not atomic at SQL level
  // but guarded by the researcher's session being single-request; failures
  // leave the old set intact because we delete last after insert succeeds.
  // Instead we upsert keyed by id (new rows get fresh UUIDs), then delete
  // rows that weren't in the payload.
  // Guard against a researcher supplying an `id` that belongs to another
  // experiment — without this, onConflict:id would overwrite that foreign
  // row (review H5). Verify every supplied id currently belongs to this
  // experiment; unknown ids get nulled so they're inserted fresh.
  const suppliedIds = parsed.data
    .map((r) => r.id)
    .filter((x): x is string => !!x);
  let validIdSet = new Set<string>();
  if (suppliedIds.length > 0) {
    const { data: ownedRows } = await guard.admin
      .from("experiment_online_screeners")
      .select("id")
      .eq("experiment_id", experimentId)
      .in("id", suppliedIds);
    validIdSet = new Set((ownedRows ?? []).map((r) => r.id));
  }

  const payload = parsed.data.map((row, idx) => ({
    // Keep id only if it already belongs to this experiment; else drop so
    // a fresh UUID is assigned and we don't cross-experiment hijack.
    id: row.id && validIdSet.has(row.id) ? row.id : undefined,
    experiment_id: experimentId,
    position: (idx + 1) * 100,
    kind: row.kind,
    question: row.question,
    help_text: row.help_text ?? null,
    validation_config: row.validation_config,
    required: row.required,
  }));

  const { error: upErr } = await guard.admin
    .from("experiment_online_screeners")
    .upsert(payload, { onConflict: "id" });
  if (upErr) {
    return NextResponse.json(
      { error: "Upsert failed", detail: upErr.message },
      { status: 500 },
    );
  }

  // Delete rows not in new payload
  const keepIds = payload.filter((p) => p.id).map((p) => p.id as string);
  let delQuery = guard.admin
    .from("experiment_online_screeners")
    .delete()
    .eq("experiment_id", experimentId);
  if (keepIds.length > 0) {
    delQuery = delQuery.not("id", "in", `(${keepIds.join(",")})`);
  }
  await delQuery;

  const { data: fresh } = await guard.admin
    .from("experiment_online_screeners")
    .select("*")
    .eq("experiment_id", experimentId)
    .order("position", { ascending: true });
  return NextResponse.json({ screeners: fresh ?? [] });
}
