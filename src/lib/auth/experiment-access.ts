// requireExperimentAccess — shared admin/owner gate for routes that
// operate on a single experiment.
//
// Why this exists (refactor-roadmap Phase B-light, 2026-05-29):
//
// At least 15 route files duplicated the same authentication boilerplate:
//
//     const { data: { user } } = await supabase.auth.getUser();
//     if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
//     const admin = createAdminClient();
//     const { data: exp } = await admin.from("experiments")
//       .select("id, created_by").eq("id", experimentId).maybeSingle();
//     if (!exp) return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
//     const { data: profile } = await admin.from("profiles")
//       .select("role").eq("id", user.id).maybeSingle();
//     const isOwner = exp.created_by === user.id;
//     const isAdmin = profile?.role === "admin";
//     if (!isOwner && !isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
//
// Three problems with that copy-paste:
//   1. **Drift.** Some routes selected extra columns from experiments
//      (e.g. `google_calendar_id`), others didn't — caller had to know
//      which boilerplate variant matched their needs.
//   2. **Inconsistent error messages.** "Unauthorized" vs "권한 없음"
//      vs "권한이 없습니다" depending on who wrote the route.
//   3. **No single place to harden.** When we add audit logging or
//      stricter role checks, we'd have to find every copy.
//
// This helper:
//   * validates the experimentId is a UUID (returns 400 if not),
//   * resolves the authenticated user (returns 401 if absent),
//   * loads the experiment (returns 404 if it doesn't exist),
//   * confirms the user is owner OR admin (returns 403 if neither),
//   * returns a context object with both Supabase clients pre-built so
//     callers don't redundantly re-create them.
//
// API style: early-return-on-failure. The helper returns either an
// AccessContext (caller continues) or a NextResponse (caller returns
// it directly). TypeScript's narrowing on `instanceof NextResponse`
// gives the caller a checked-at-compile-time path.

import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";

type ServerClient = Awaited<ReturnType<typeof createClient>>;
type AdminClient = ReturnType<typeof createAdminClient>;

export interface ExperimentAccessContext {
  /** Authenticated Supabase user. */
  user: User;
  /** Experiment row — id + created_by, the columns the auth check needs. */
  experiment: { id: string; created_by: string | null };
  /** True iff the authenticated user created this experiment. */
  isOwner: boolean;
  /** True iff the authenticated user has profiles.role='admin'. */
  isAdmin: boolean;
  /** User-scoped Supabase client (RLS sees auth.uid()). */
  supabase: ServerClient;
  /** Service-role Supabase client (bypasses RLS). */
  admin: AdminClient;
}

export interface ExperimentAccessOptions {
  /**
   * Extra columns to include in the experiment row select. The
   * required `id, created_by` are always included. Use this when the
   * caller would otherwise re-fetch the same row for a different
   * column set.
   *
   * Example: `extraColumns: "google_calendar_id, payment_link_auto_send"`
   * makes those fields available on the returned `experiment` object
   * (TypeScript widens accordingly — caller casts to the expected
   * shape).
   */
  extraColumns?: string;
  /**
   * When true, reject admins who aren't also the experiment owner.
   * Default false — admins get access alongside owners, which is the
   * common pattern (admin can do anything a researcher can on any
   * experiment).
   *
   * Use this for routes that should ONLY be touched by the
   * experiment's creator — e.g. researcher-owned mutations where an admin
   * reviewing the dashboard shouldn't accidentally overwrite the
   * researcher's data.
   */
  ownerOnly?: boolean;
}

/**
 * Returns either an `ExperimentAccessContext` (auth succeeded — caller
 * proceeds) or a `NextResponse` (auth failed — caller returns it).
 *
 * Sample usage:
 *
 *     const access = await requireExperimentAccess(experimentId);
 *     if (access instanceof NextResponse) return access;
 *     const { admin, supabase, user, isOwner, isAdmin } = access;
 *     // ...continue
 */
export async function requireExperimentAccess(
  experimentId: string,
  opts: ExperimentAccessOptions = {},
): Promise<ExperimentAccessContext | NextResponse> {
  if (!isValidUUID(experimentId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const columns = opts.extraColumns
    ? `id, created_by, ${opts.extraColumns}`
    : "id, created_by";
  const { data: exp } = await admin
    .from("experiments")
    .select(columns)
    .eq("id", experimentId)
    .maybeSingle();
  if (!exp) {
    return NextResponse.json(
      { error: "Experiment not found" },
      { status: 404 },
    );
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("role, disabled")
    .eq("id", user.id)
    .maybeSingle();

  // A disabled (offboarded/suspended) account loses ALL experiment access —
  // even to experiments it owns. Checked before owner/admin so a disabled
  // owner can't export PII or mutate payouts. (Central chokepoint; the two
  // hand-rolled auth blocks in payment-export/amount routes mirror this.)
  const disabled =
    (profile as unknown as { disabled?: boolean } | null)?.disabled === true;
  if (disabled) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const experimentRow = exp as unknown as {
    id: string;
    created_by: string | null;
  };
  const isOwner = experimentRow.created_by === user.id;
  const isAdmin =
    (profile as unknown as { role: string | null } | null)?.role === "admin";
  if (opts.ownerOnly) {
    if (!isOwner) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (!isOwner && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return {
    user,
    experiment: experimentRow,
    isOwner,
    isAdmin,
    supabase,
    admin,
  };
}
