import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyPaymentToken, PaymentTokenError } from "@/lib/payments/token";
import { formatDateKR } from "@/lib/utils/date";
import PaymentInfoForm from "./PaymentInfoForm";

interface PageProps {
  params: Promise<{ token: string }>;
}

// Only two surfaces: "expired" (user-friendly; the legit user benefits
// from knowing to request a new link) and a generic "invalid" for every
// other failure mode. Conflating SHAPE/SIGNATURE/REVOKED prevents token
// enumeration via the response surface.
type TokenFailure = "EXPIRED" | "INVALID";

function Failure({ code }: { code: TokenFailure }) {
  const messages: Record<TokenFailure, { title: string; detail: string }> = {
    EXPIRED: {
      title: "링크가 만료되었습니다",
      detail:
        "정산 정보 입력 링크는 발급일로부터 60일간 유효합니다. 담당 연구원에게 새 링크를 요청해 주세요.",
    },
    INVALID: {
      title: "링크가 유효하지 않습니다",
      detail:
        "이메일의 링크 전체를 복사하셨는지 확인해 주세요. 문제가 계속되면 담당 연구원에게 문의해 주세요.",
    },
  };
  const m = messages[code];
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
      <h1 className="mb-2 text-lg font-semibold text-amber-900">{m.title}</h1>
      <p className="text-sm leading-relaxed text-amber-800">{m.detail}</p>
    </div>
  );
}

export default async function PaymentInfoPage({ params }: PageProps) {
  const { token } = await params;
  if (!token || token.length < 10) notFound();

  let verified;
  try {
    verified = verifyPaymentToken(token);
  } catch (err) {
    if (err instanceof PaymentTokenError && err.code === "EXPIRED") {
      return <Failure code="EXPIRED" />;
    }
    return <Failure code="INVALID" />;
  }

  const supabase = createAdminClient();
  // name_override / email_override / phone live in payment_info (migration
  // 00050) so a participant who already started filling the form (or who
  // re-opens after corrections) sees their last-entered values, not the
  // potentially stale participants.* row.
  const { data: info } = await supabase
    .from("participant_payment_info")
    .select(
      "id, booking_group_id, participant_id, experiment_id, status, period_start, period_end, amount_krw, token_hash, token_revoked_at, account_holder, bank_name, name_override, email_override, phone, participants(name, email, phone), experiments(title)",
    )
    .eq("booking_group_id", verified.bookingGroupId)
    .maybeSingle<{
      id: string;
      booking_group_id: string;
      participant_id: string;
      experiment_id: string;
      status: "pending_participant" | "submitted_to_admin" | "claimed" | "paid";
      period_start: string | null;
      period_end: string | null;
      amount_krw: number;
      token_hash: string;
      token_revoked_at: string | null;
      account_holder: string | null;
      bank_name: string | null;
      name_override: string | null;
      email_override: string | null;
      phone: string | null;
      participants: { name: string; email: string | null; phone: string | null } | null;
      experiments: { title: string } | null;
    }>();

  if (!info) return <Failure code="INVALID" />;
  if (info.token_hash !== verified.hash) return <Failure code="INVALID" />;
  // token_revoked_at is set on successful submit (so a stolen URL can't
  // be replayed). A legit participant who re-opens their link should
  // still see the "제출되었습니다" success screen — that's the branch
  // below, reached when status is non-pending. So only treat the revoke
  // as hard-invalid while the row hasn't been submitted yet.
  if (info.token_revoked_at && info.status === "pending_participant") {
    return <Failure code="INVALID" />;
  }

  // Stamp first_opened_at on the first valid load (P0 #6 / migration
  // 00052). Signals payment-info-notify.service to NOT rotate the token
  // on the last-session auto-dispatch — the participant already has
  // this URL in their browser/bookmark, so rotating would break it.
  // CAS via .is(... NULL) so concurrent loads don't double-write.
  if (info.status === "pending_participant") {
    await supabase
      .from("participant_payment_info")
      .update({ payment_link_first_opened_at: new Date().toISOString() })
      .eq("id", info.id)
      .is("payment_link_first_opened_at", null);
  }

  const participantName = info.name_override ?? info.participants?.name ?? "";
  const participantPhone = info.phone ?? info.participants?.phone ?? "";
  const participantEmail = info.email_override ?? info.participants?.email ?? "";
  const experimentTitle = info.experiments?.title ?? "실험";

  if (info.status !== "pending_participant") {
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500 text-white">
            <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-emerald-800">정산 정보가 제출되었습니다</h1>
          <p className="mt-2 text-sm text-emerald-700">
            {experimentTitle} 참여비가 곧 {info.bank_name ?? ""} 계좌로 지급될 예정입니다.
          </p>
          <p className="mt-1 text-xs text-emerald-700/80">
            추가 수정이 필요하시면 담당 연구원에게 문의해 주세요.
          </p>
        </div>
      </div>
    );
  }

  // Surface a soft warning if the experiment period hasn't ended yet — the
  // participant can still fill the form (sometimes people do it early to
  // get it out of the way) but they should know the check happens server-
  // side at submit time.
  const now = new Date();
  const endDate = info.period_end ? new Date(`${info.period_end}T23:59:59+09:00`) : null;
  const sessionsStillUpcoming = endDate ? now < endDate : false;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-white p-5">
        <h1 className="text-lg font-semibold text-foreground">정산 정보 입력</h1>
        <p className="mt-1 text-sm text-muted">
          {experimentTitle} — {participantName}님
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">실험 기간</dt>
          <dd className="text-foreground">
            {info.period_start ? formatDateKR(info.period_start) : "-"} ~{" "}
            {info.period_end ? formatDateKR(info.period_end) : "-"}
          </dd>
          <dt className="text-muted">지급 예정액</dt>
          <dd className="font-semibold text-foreground">
            {info.amount_krw.toLocaleString()}원
          </dd>
        </dl>
      </div>

      {sessionsStillUpcoming && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          ⚠ 아직 실험이 완료되지 않았습니다. 모든 세션을 마치신 후 제출해 주세요.
          지금 작성은 가능하지만, 제출은 마지막 세션 종료 후에만 처리됩니다.
        </div>
      )}

      <PaymentInfoForm
        token={token}
        defaultName={participantName}
        defaultPhone={participantPhone}
        defaultEmail={participantEmail}
        experimentTitle={experimentTitle}
        amountKrw={info.amount_krw}
      />

      <div className="rounded-lg border border-border bg-muted/10 p-4 text-xs leading-relaxed text-muted">
        <p className="mb-1 font-semibold text-foreground">🔒 개인정보 처리 안내</p>
        주민등록번호는 AES-256 암호화되어 저장되며, 행정 제출용 엑셀 파일 생성 시에만 복호화됩니다.
        전자서명은 비공개 저장소에 보관되며 담당 연구원만 열람할 수 있습니다.
      </div>
    </div>
  );
}
