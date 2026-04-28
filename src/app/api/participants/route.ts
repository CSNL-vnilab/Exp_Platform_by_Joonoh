import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  Participant,
  ParticipantClass,
  ParticipantClassRow,
} from "@/types/database";
// Note: search on name/phone only runs in admin branch below. Researchers'
// searches are restricted to public_code matching (pseudonymous lookup).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LAB_CODE = "CSNL";
const MAX_LIMIT = 200;

type ClassFilter = ParticipantClass | "all";

function parseClassFilter(raw: string | null): ClassFilter {
  if (!raw) return "all";
  if (
    raw === "newbie" ||
    raw === "royal" ||
    raw === "blacklist" ||
    raw === "vip"
  ) {
    return raw;
  }
  return "all";
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Admin gate: non-admin researchers never receive PII fields in list
    // responses. Only `public_code` + `class` + aggregated counts. (QC C2.)
    const admin0 = createAdminClient();
    const { data: profile } = await admin0
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    const isAdmin = profile?.role === "admin";

    const url = new URL(request.url);
    const classFilter = parseClassFilter(url.searchParams.get("class"));
    const search = (url.searchParams.get("search") ?? "").trim();
    const labCode =
      (url.searchParams.get("lab") ?? "").trim() || DEFAULT_LAB_CODE;
    const limitRaw = Number(url.searchParams.get("limit") ?? "50");
    const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
        : 50;
    const offset =
      Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;

    const admin = admin0;
    const { data: lab } = await admin
      .from("labs")
      .select("id, code")
      .eq("code", labCode)
      .maybeSingle();
    if (!lab?.id) {
      return NextResponse.json(
        { error: "Lab not found", lab: labCode },
        { status: 404 },
      );
    }

    // ------------------------------------------------------------------
    // Class filter narrows the candidate set BEFORE we page participants.
    // ------------------------------------------------------------------
    let candidateIds: string[] | null = null;

    if (classFilter !== "all") {
      // Latest-effective-class view equivalent: pull participant_classes rows
      // in the lab matching the class, then filter out any that have been
      // superseded by a newer row (regardless of class).
      // Use admin client so the lab-wide class list works for any researcher
      // (RLS would otherwise restrict the view to rows linked to the
      // researcher's own experiments).
      const { data: classRows } = await admin
        .from("participant_classes")
        .select("participant_id, class, valid_from, valid_until")
        .eq("lab_id", lab.id)
        .order("valid_from", { ascending: false });

      const latestByParticipant = new Map<
        string,
        { class: ParticipantClass; valid_until: string | null }
      >();
      for (const row of (classRows ?? []) as Array<{
        participant_id: string;
        class: ParticipantClass;
        valid_from: string;
        valid_until: string | null;
      }>) {
        if (!latestByParticipant.has(row.participant_id)) {
          latestByParticipant.set(row.participant_id, {
            class: row.class,
            valid_until: row.valid_until,
          });
        }
      }
      const now = Date.now();
      candidateIds = [...latestByParticipant.entries()]
        .filter(([, v]) => {
          if (v.class !== classFilter) return false;
          if (v.valid_until && new Date(v.valid_until).getTime() <= now)
            return false;
          return true;
        })
        .map(([pid]) => pid);

      if (candidateIds.length === 0) {
        return NextResponse.json({
          participants: [],
          total: 0,
          limit,
          offset,
        });
      }
    }

    // ------------------------------------------------------------------
    // Search — accepts either a name/phone substring OR a public_code.
    // If search looks like a public_code for this lab, resolve to id set.
    // ------------------------------------------------------------------
    if (search) {
      const prefix = `${lab.code}-`;
      if (search.toUpperCase().startsWith(prefix)) {
        const publicCode = search.toUpperCase();
        const { data: idRow } = await admin
          .from("participant_lab_identity")
          .select("participant_id")
          .eq("lab_id", lab.id)
          .eq("public_code", publicCode)
          .maybeSingle();

        const matchedId = idRow?.participant_id ?? null;
        if (!matchedId) {
          return NextResponse.json({
            participants: [],
            total: 0,
            limit,
            offset,
          });
        }
        candidateIds = candidateIds
          ? candidateIds.filter((id) => id === matchedId)
          : [matchedId];
        if (candidateIds.length === 0) {
          return NextResponse.json({
            participants: [],
            total: 0,
            limit,
            offset,
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // Main participants query.
    // ------------------------------------------------------------------
    // Switched from cookie-bound `supabase` (RLS) to `admin` so every
    // researcher can see the lab-wide participant roster, not just the
    // people they personally booked. PII protection still happens here:
    // non-admin researchers only get id + created_at columns (the server
    // never serializes name/phone/email/gender/birthdate for them, even
    // accidentally). User directive 2026-04-28: 모든 연구원이 lab 참여자
    // 목록을 암호화된 public_code 형태로 파악할 수 있어야 한다.
    const baseCols = isAdmin
      ? "id, name, phone, email, gender, birthdate, created_at"
      : "id, created_at";

    let query = admin
      .from("participants")
      .select(baseCols, { count: "exact" });

    if (candidateIds && candidateIds.length > 0) {
      query = query.in("id", candidateIds);
    }
    if (search && !search.toUpperCase().startsWith(`${lab.code}-`)) {
      // Non-public-code search is admin-only: it probes name/phone, which
      // would otherwise leak identity to researchers ("does CSNL-XXXXXX
      // correspond to name Y?"). Researchers must search by public_code.
      if (!isAdmin) {
        return NextResponse.json({
          participants: [],
          total: 0,
          limit,
          offset,
          lab: { id: lab.id, code: lab.code },
        });
      }
      const phoneDigits = search.replace(/\D/g, "");
      if (phoneDigits.length >= 4) {
        query = query.or(`name.ilike.%${search}%,phone.ilike.%${phoneDigits}%`);
      } else {
        query = query.ilike("name", `%${search}%`);
      }
    }

    const {
      data: participantRows,
      error: listErr,
      count,
    } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (listErr) {
      console.error("[Participants GET] list failed:", listErr.message);
      return NextResponse.json(
        { error: "참여자 목록 조회에 실패했습니다" },
        { status: 500 },
      );
    }

    // When the caller isn't admin, the select only returned id+created_at,
    // so fields below (name/phone/etc.) are undefined. Cast through unknown
    // because Supabase's literal-column parser doesn't narrow variable selects.
    const rows = (participantRows ?? []) as unknown as Array<
      Partial<Participant> & { id: string; created_at: string }
    >;
    const ids = rows.map((r) => r.id);

    // ------------------------------------------------------------------
    // Batch-fetch public_code + current class for the page.
    // ------------------------------------------------------------------
    const publicCodeByParticipant = new Map<string, string>();
    if (ids.length > 0) {
      const { data: idRows } = await admin
        .from("participant_lab_identity")
        .select("participant_id, public_code")
        .eq("lab_id", lab.id)
        .in("participant_id", ids);
      for (const r of (idRows ?? []) as Array<{
        participant_id: string;
        public_code: string;
      }>) {
        publicCodeByParticipant.set(r.participant_id, r.public_code);
      }
    }

    // H1: compute per-participant completed_count (scoped to this lab's
    // experiments) and last_booking_at so the list UI stops rendering "0"/"-"
    // for every row. One grouped query per page.
    const aggregateByParticipant = new Map<
      string,
      { completed_count: number; last_booking_at: string | null }
    >();
    if (ids.length > 0) {
      const { data: bookingRows } = await admin
        .from("bookings")
        .select("participant_id, status, slot_start, experiments!inner(lab_id)")
        .eq("experiments.lab_id", lab.id)
        .in("participant_id", ids);
      type Row = {
        participant_id: string;
        status: string;
        slot_start: string;
      };
      for (const r of ((bookingRows ?? []) as unknown) as Row[]) {
        const prev = aggregateByParticipant.get(r.participant_id) ?? {
          completed_count: 0,
          last_booking_at: null as string | null,
        };
        if (r.status === "completed") prev.completed_count += 1;
        if (!prev.last_booking_at || r.slot_start > prev.last_booking_at) {
          prev.last_booking_at = r.slot_start;
        }
        aggregateByParticipant.set(r.participant_id, prev);
      }
    }

    const classByParticipant = new Map<string, ParticipantClassRow>();
    if (ids.length > 0) {
      // admin client so the class column populates for every participant on
      // the page, not just ones the researcher's RLS scope would allow.
      const { data: classRows } = await admin
        .from("participant_classes")
        .select("*")
        .eq("lab_id", lab.id)
        .in("participant_id", ids)
        .order("valid_from", { ascending: false });
      const now = Date.now();
      for (const row of (classRows ?? []) as ParticipantClassRow[]) {
        if (classByParticipant.has(row.participant_id)) continue;
        if (
          row.valid_until &&
          new Date(row.valid_until).getTime() <= now
        ) {
          continue;
        }
        classByParticipant.set(row.participant_id, row);
      }
    }

    const out = rows.map((p) => {
      const cls = classByParticipant.get(p.id) ?? null;
      const agg = aggregateByParticipant.get(p.id) ?? {
        completed_count: 0,
        last_booking_at: null,
      };
      const base = {
        id: p.id,
        created_at: p.created_at,
        public_code: publicCodeByParticipant.get(p.id) ?? null,
        lab_code: lab.code,
        // H1: populate from bookings aggregate, not from the stale class row.
        completed_count: agg.completed_count,
        last_booking_at: agg.last_booking_at,
        class: cls
          ? {
              class: cls.class,
              reason: cls.reason,
              assigned_kind: cls.assigned_kind,
              valid_from: cls.valid_from,
              valid_until: cls.valid_until,
              completed_count: cls.completed_count,
            }
          : null,
      };
      // Only admins see PII; researchers get the pseudonymous view.
      if (!isAdmin) return base;
      return {
        ...base,
        name: p.name,
        phone: p.phone,
        email: p.email,
        gender: p.gender,
        birthdate: p.birthdate,
      };
    });

    return NextResponse.json({
      participants: out,
      total: count ?? out.length,
      limit,
      offset,
      lab: { id: lab.id, code: lab.code },
    });
  } catch (err) {
    console.error("[Participants GET] failed:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
