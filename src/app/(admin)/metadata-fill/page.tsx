import { requireUser } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { MetadataFillList } from "./metadata-fill-list";

export const dynamic = "force-dynamic";

// One-shot metadata fill page — pulls every experiment the current
// researcher owns that has at least one of the "gap" fields empty,
// pre-fills the form with current values, and lets them save each row
// individually. Used by the interview email so backfilled experiments
// can be brought up to spec without touching N detail pages.
//
// Gap fields tracked here mirror the metadata-reminder cron + a few
// fields the cron didn't cover (location_id, description, fee, IRB,
// recruitment_target). The cron's required set (code_repo_url +
// data_path) stays first-class — those two also gate experiment
// activation per /api/experiments/[id]/status.

const GAP_FIELDS = [
  "code_repo_url",
  "data_path",
  "pre_experiment_checklist",
  "protocol_version",
  "location_id",
  "description",
  "participation_fee",
  "irb_document_url",
  "recruitment_target",
] as const;

export default async function MetadataFillPage() {
  const profile = await requireUser();
  const admin = createAdminClient();

  const { data: rows } = await admin
    .from("experiments")
    .select(
      "id, title, project_name, status, start_date, end_date, code_repo_url, data_path, pre_experiment_checklist, protocol_version, location_id, description, participation_fee, irb_document_url, recruitment_target",
    )
    .eq("created_by", profile.id)
    // 2026-05-28 — hide pilot / equipment-test / one-off rows the
    // researcher already opted out from this nag flow.
    .eq("is_project", true)
    .order("created_at", { ascending: false });

  type Row = NonNullable<typeof rows>[number];
  const items = (rows ?? []).filter((e: Row) => {
    return GAP_FIELDS.some((f) => {
      const v = e[f as keyof Row];
      if (v == null || v === "") return true;
      if (Array.isArray(v) && v.length === 0) return true;
      if (typeof v === "string" && v.trim() === "") return true;
      // participation_fee=0 is ambiguous (could be intentional) — don't
      // treat as a gap here.
      return false;
    });
  });

  const { data: locations } = await admin
    .from("experiment_locations")
    .select("id, name, address_lines")
    .order("name", { ascending: true });

  // Lab-wide IRB URL — admin sets via /lab-settings. Surfaced as a
  // one-click prefill button next to each card's IRB URL input.
  const { data: lab } = await admin
    .from("labs")
    .select("irb_base_url")
    .eq("code", "CSNL")
    .maybeSingle();
  const labIrbBaseUrl = lab?.irb_base_url ?? null;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">
          실험 메타데이터 입력
        </h1>
        <p className="mt-1 text-sm text-muted">
          내가 만든 실험 중 비어 있는 필드가 있는 항목을 한 번에 채워
          저장합니다. 각 카드의 <b>저장</b> 버튼은 그 실험만 갱신합니다 —
          한 번에 다 채우지 않아도 됩니다.
        </p>
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          💡 pilot · 장비 테스트 · 일회성 예약처럼 정식 프로젝트가 아닌 항목은
          카드 우측 상단의 <b>&quot;프로젝트 아님 (면제)&quot;</b> 버튼으로
          면제 처리하실 수 있습니다. 면제된 실험은 다음 안내부터 자동으로
          제외됩니다.
        </p>
        {labIrbBaseUrl && (
          <p className="mt-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
            📎 관리자가 등록한 공용 IRB 문서 URL 이 있습니다. 각 카드의
            IRB 입력 칸 옆 <b>&quot;관리자 등록 IRB 사용&quot;</b> 버튼으로
            한 번에 채워넣을 수 있습니다.
          </p>
        )}
      </div>
      <MetadataFillList
        experiments={items}
        locations={locations ?? []}
        labIrbBaseUrl={labIrbBaseUrl}
      />
    </div>
  );
}
