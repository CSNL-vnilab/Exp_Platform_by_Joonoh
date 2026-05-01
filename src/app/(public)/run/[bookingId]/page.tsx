import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyRunToken, hashToken, TokenError } from "@/lib/experiments/run-token";
import { RunShell } from "@/components/run/run-shell";
import { RunErrorBoundary } from "@/components/run/run-error-boundary";
import { brandContactEmailOrNull } from "@/lib/branding";
import type { OnlineRuntimeConfig } from "@/types/database";

// Progress state is mutated by /api/.../block uploads. We render server-
// side once and must always reflect the latest counter — no ISR, no cache.
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{ t?: string }>;
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ResearcherContact {
  name: string;
  email: string | null;
  phone: string | null;
}

// Best-effort researcher lookup so the error screen can show "ask THIS
// person" instead of an unactionable "ask the researcher". Cheap two
// queries; on any failure we just return null and the screen falls back
// to the lab-wide inbox if env-configured.
async function lookupResearcher(bookingId: string): Promise<ResearcherContact | null> {
  try {
    const supabase = createAdminClient();
    const { data: booking } = await supabase
      .from("bookings")
      .select("experiments(created_by)")
      .eq("id", bookingId)
      .maybeSingle();
    const createdBy = (booking?.experiments as { created_by: string | null } | null)
      ?.created_by;
    if (!createdBy) return null;
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name, contact_email, email, phone")
      .eq("id", createdBy)
      .maybeSingle();
    if (!profile) return null;
    const p = profile as {
      display_name: string | null;
      contact_email: string | null;
      email: string | null;
      phone: string | null;
    };
    const contactEmail = (p.contact_email ?? "").trim() || (p.email ?? "").trim() || null;
    return {
      name: (p.display_name ?? "").trim() || "담당 연구원",
      email: contactEmail,
      phone: (p.phone ?? "").trim() || null,
    };
  } catch {
    return null;
  }
}

// Public runtime shell for remote JS experiments. Token auth only — no
// Supabase user cookie needed. Participants arrive here from the confirmation
// email link (/run/{bookingId}?t={token}).

export default async function RunPage({ params, searchParams }: PageProps) {
  const { bookingId } = await params;
  const { t } = await searchParams;

  if (!uuidRe.test(bookingId)) notFound();

  // Resolve researcher contact early so every error path below can show
  // a real "ask this person" mailto/phone instead of unactionable text.
  const researcher = await lookupResearcher(bookingId);

  if (!t) {
    return (
      <TokenError_ reason="missing" researcher={researcher}>
        접근 링크에 필요한 토큰이 없습니다. 이메일로 받으신 링크를 그대로 다시 열어주세요.
      </TokenError_>
    );
  }

  try {
    verifyRunToken(t, bookingId);
  } catch (err) {
    const code = err instanceof TokenError ? err.code : "SHAPE";
    return (
      <TokenError_ reason={code === "EXPIRED" ? "expired" : "invalid"} researcher={researcher}>
        {code === "EXPIRED"
          ? "링크가 만료되었습니다. 아래 담당 연구원에게 새 링크를 요청해 주세요."
          : "링크가 유효하지 않습니다. 이메일 링크를 그대로 다시 열어주세요."}
      </TokenError_>
    );
  }

  const supabase = createAdminClient();

  const { data: progress } = await supabase
    .from("experiment_run_progress")
    .select(
      "token_hash, token_revoked_at, blocks_submitted, completion_code, completion_code_issued_at, is_pilot, condition_assignment",
    )
    .eq("booking_id", bookingId)
    .maybeSingle();

  if (!progress) {
    return (
      <TokenError_ reason="invalid" researcher={researcher}>
        이 예약은 온라인 실행 세션이 없습니다.
      </TokenError_>
    );
  }
  if (progress.token_revoked_at) {
    return (
      <TokenError_ reason="revoked" researcher={researcher}>
        링크가 취소되었습니다. 아래 담당 연구원에게 문의해 주세요.
      </TokenError_>
    );
  }
  if (progress.token_hash !== hashToken(t)) {
    return (
      <TokenError_ reason="invalid" researcher={researcher}>
        링크가 더 이상 유효하지 않습니다. 새로 발급된 링크를 사용해 주세요.
      </TokenError_>
    );
  }

  const { data: booking } = await supabase
    .from("bookings")
    .select(
      "id, subject_number, experiment_id, experiments(id, title, description, experiment_mode, online_runtime_config, irb_document_url, data_consent_required, precautions)",
    )
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) notFound();
  const exp = booking.experiments as unknown as {
    id: string;
    title: string;
    description: string | null;
    experiment_mode: "offline" | "online" | "hybrid";
    online_runtime_config: OnlineRuntimeConfig | null;
    irb_document_url: string | null;
    data_consent_required: boolean;
    precautions: Array<{ question: string; required_answer: boolean }> | null;
  } | null;

  if (!exp || exp.experiment_mode === "offline") {
    return (
      <TokenError_ reason="invalid" researcher={researcher}>
        이 실험은 온라인 실행 대상이 아닙니다.
      </TokenError_>
    );
  }
  if (!exp.online_runtime_config?.entry_url) {
    return (
      <TokenError_ reason="invalid" researcher={researcher}>
        실험이 아직 실행 준비 중입니다. 담당 연구원이 설정을 완료하면 다시 시도해 주세요.
      </TokenError_>
    );
  }

  // Fetch online screeners + prior passed/failed responses. Shell uses these
  // to render the screening step.
  const { data: screenerRows } = await supabase
    .from("experiment_online_screeners")
    .select("id, position, kind, question, help_text, validation_config, required")
    .eq("experiment_id", exp.id)
    .order("position", { ascending: true });

  const { data: screenerResponses } = await supabase
    .from("experiment_online_screener_responses")
    .select("screener_id, passed")
    .eq("booking_id", booking.id);

  const passedScreenerIds = new Set(
    (screenerResponses ?? [])
      .filter((r) => r.passed)
      .map((r) => r.screener_id),
  );

  return (
    <RunErrorBoundary>
      <RunShell
        token={t}
        booking={{
          id: booking.id,
          subject_number: booking.subject_number ?? 0,
          is_pilot: progress.is_pilot ?? false,
          condition: progress.condition_assignment ?? null,
        }}
        experiment={{
          id: exp.id,
          title: exp.title,
          description: exp.description,
          mode: exp.experiment_mode,
          runtime_config: exp.online_runtime_config,
          irb_document_url: exp.irb_document_url,
          data_consent_required: exp.data_consent_required,
          precautions: exp.precautions ?? [],
        }}
        progress={{
          blocks_submitted: progress.blocks_submitted,
          completion_code: progress.completion_code,
        }}
        screeners={{
          questions: (screenerRows ?? []).map((s) => ({
            id: s.id,
            kind: s.kind as "yes_no" | "numeric" | "single_choice" | "multi_choice",
            question: s.question,
            help_text: s.help_text,
            required: s.required,
            validation_config: (s.validation_config ?? {}) as Record<string, unknown>,
          })),
          passed_ids: Array.from(passedScreenerIds),
        }}
      />
    </RunErrorBoundary>
  );
}

function TokenError_({
  children,
  reason,
  researcher,
}: {
  children: React.ReactNode;
  reason: string;
  researcher: ResearcherContact | null;
}) {
  // Researcher email wins; fall back to lab-wide inbox only when env-
  // configured (P0 #1 helper — never the placeholder).
  const contactEmail = researcher?.email ?? brandContactEmailOrNull();
  const contactName = researcher?.name ?? "담당 연구원";
  const contactPhone = researcher?.phone ?? null;

  return (
    <div className="mx-auto max-w-xl py-20 text-center">
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
        <svg
          className="h-8 w-8 text-danger"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
          />
        </svg>
      </div>
      <h1 className="text-xl font-semibold text-foreground">실험을 열 수 없습니다</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">{children}</p>

      {(contactEmail || contactPhone) && (
        <div className="mx-auto mt-6 max-w-sm rounded-lg border border-border bg-muted/10 p-4 text-left">
          <p className="mb-1 text-xs font-semibold text-foreground">담당 연구원 · 문의</p>
          <p className="text-sm text-foreground">
            {contactName}
            {contactPhone ? ` · ${contactPhone}` : ""}
          </p>
          {contactEmail && (
            <a
              href={`mailto:${contactEmail}?subject=${encodeURIComponent("실험 링크 문의")}`}
              className="mt-2 inline-block rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              이메일로 문의하기 →
            </a>
          )}
        </div>
      )}

      <p className="mt-6 text-xs text-muted" aria-hidden>
        err: {reason}
      </p>
    </div>
  );
}
