import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { OnlineRuntimeConfig } from "@/types/database";
import { RunShell } from "@/components/run/run-shell";
import { RunErrorBoundary } from "@/components/run/run-error-boundary";

export const dynamic = "force-dynamic";

// Researcher-side preview of the /run shell with the experiment's current
// online_runtime_config. No token, no persistence — uses a dummy booking
// and surfaces a warning banner so researchers know data won't save.
// Mirrors Prolific's "Preview" link. Admin/owner only.

export default async function PreviewRunPage({
  params,
}: {
  params: Promise<{ experimentId: string }>;
}) {
  const { experimentId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const admin = createAdminClient();
  const { data: exp } = await admin
    .from("experiments")
    .select(
      "id, title, description, experiment_mode, online_runtime_config, irb_document_url, data_consent_required, precautions, created_by",
    )
    .eq("id", experimentId)
    .maybeSingle();
  if (!exp) notFound();

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";
  if (!isAdmin && exp.created_by !== user.id) notFound();

  if (exp.experiment_mode === "offline" || !exp.online_runtime_config) {
    return (
      <div className="py-20 text-center text-sm text-muted">
        온라인 설정이 없는 실험은 프리뷰를 제공하지 않습니다.
      </div>
    );
  }

  const { data: screenerRows } = await admin
    .from("experiment_online_screeners")
    .select("id, position, kind, question, help_text, validation_config, required")
    .eq("experiment_id", experimentId)
    .order("position", { ascending: true });

  return (
    <div className="space-y-3">
      <div
        className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        role="status"
        aria-live="polite"
      >
        <strong>연구원 프리뷰 모드</strong> — 이 화면은 참여자가 보게 될 흐름을 그대로
        보여주지만, 제출된 응답은 서버에 저장되지 않습니다. 실제 실험 링크는 예약이
        완료된 참여자에게 이메일로 발송됩니다.
        <Link
          href={`/experiments/${experimentId}`}
          className="ml-2 underline hover:text-amber-700"
        >
          돌아가기
        </Link>
      </div>
      <RunErrorBoundary>
        <RunShell
          token="preview-token-never-valid"
          booking={{
            id: "00000000-0000-0000-0000-000000000000",
            subject_number: 0,
            is_pilot: true,
            condition: (exp.online_runtime_config as { counterbalance_spec?: { conditions?: string[] } })
              ?.counterbalance_spec?.conditions?.[0] ?? null,
          }}
          experiment={{
            id: exp.id,
            title: `[프리뷰] ${exp.title}`,
            description: exp.description,
            mode: exp.experiment_mode as "online" | "hybrid",
            runtime_config: exp.online_runtime_config as OnlineRuntimeConfig,
            irb_document_url: exp.irb_document_url,
            data_consent_required: exp.data_consent_required,
            precautions: exp.precautions ?? [],
          }}
          progress={{ blocks_submitted: 0, completion_code: null }}
          screeners={{
            questions: (screenerRows ?? []).map((s) => ({
              id: s.id,
              kind: s.kind as "yes_no" | "numeric" | "single_choice" | "multi_choice",
              question: s.question,
              help_text: s.help_text,
              required: s.required,
              validation_config: (s.validation_config ?? {}) as Record<string, unknown>,
            })),
            passed_ids: [],
          }}
        />
      </RunErrorBoundary>
    </div>
  );
}
