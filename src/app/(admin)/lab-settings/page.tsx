import { requireAdmin } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { LabSettingsForm } from "./lab-settings-form";

export const dynamic = "force-dynamic";

// Admin-only lab-wide settings page. Currently just irb_base_url —
// kept as a stable surface so future lab-wide knobs (default location,
// default participation fee, etc.) can hang off the same screen.
export default async function LabSettingsPage() {
  await requireAdmin();
  const admin = createAdminClient();
  const { data: lab } = await admin
    .from("labs")
    .select("id, code, name, irb_base_url")
    .eq("code", "CSNL")
    .maybeSingle();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">랩 설정</h1>
        <p className="mt-1 text-sm text-muted">
          연구실 전체에 적용되는 설정값. 연구원이 자기 실험에 매번 같은
          값을 입력하지 않도록 여기서 한 번만 등록합니다.
        </p>
      </div>
      <LabSettingsForm
        labCode={lab?.code ?? "CSNL"}
        labName={lab?.name ?? "CSNL"}
        initialIrbBaseUrl={lab?.irb_base_url ?? ""}
      />
    </div>
  );
}
