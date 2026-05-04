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
  // account_number selected so the success screen can show a masked
  // tail (Phase 5a / C-P0-8 in the improvement plan).
  const { data: info } = await supabase
    .from("participant_payment_info")
    .select(
      "id, booking_group_id, participant_id, experiment_id, status, period_start, period_end, amount_krw, token_hash, token_revoked_at, account_holder, account_number, bank_name, name_override, email_override, phone, participants(name, email, phone), experiments(title)",
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
      account_number: string | null;
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

  // P0-Ε: do NOT stamp payment_link_first_opened_at here. The previous
  // implementation stamped on every valid GET — which made the stamp
  // trivially trippable by any party who got the URL (email forwarding,
  // browser sync to a family member, spam-filter preview pane, shoulder-
  // surfed phone preview). The stamp controls token-preserve behavior
  // in payment-info-notify.service; an attacker with the URL but not
  // the form data could prevent legitimate auto-rotation, pinning the
  // token alive for the full 60-day TTL.
  //
  // The stamp now lives at POST /api/payment-info/[token]/touch and is
  // called from PaymentInfoForm's mount effect — i.e. only after a real
  // browser actually rendered the form.

  // Header still uses participantName for "{title} — {name}님" greeting,
  // but the form gets ONLY the contact channels (phone + email). Name,
  // bank, account, RRN, holder, institution are never pre-filled — see
  // PaymentInfoForm for the rationale (privacy invariant: form must
  // never display anyone else's sensitive data, including the
  // participant's own name leaking from a stale participants row).
  const participantName = info.name_override ?? info.participants?.name ?? "";
  const participantPhone = info.phone ?? info.participants?.phone ?? "";
  const participantEmail = info.email_override ?? info.participants?.email ?? "";
  const experimentTitle = info.experiments?.title ?? "실험";

  if (info.status !== "pending_participant") {
    // C-P0-8: success screen now mentions a real disbursement window
    // ("곧" was vague enough to spawn 1-week status pings) and shows
    // the masked account tail so the participant can sanity-check.
    const tail = (info.account_number ?? "").replace(/\D/g, "").slice(-4);
    const maskedAccount = tail
      ? `${info.bank_name ?? ""} 계좌 (****${tail})`
      : info.bank_name
        ? `${info.bank_name} 계좌`
        : "등록하신 계좌";
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
            {experimentTitle} 참여비가 행정 처리 후 보통 <b>2~4주 이내</b>에
            {" "}{maskedAccount}로 입금될 예정입니다.
          </p>
          <p className="mt-2 text-xs text-emerald-700/80">
            1개월 이상 입금이 지연되거나 수정이 필요하시면 담당 연구원에게 문의해
            주세요.
          </p>
        </div>
      </div>
    );
  }

  // P0-Θ: hard gate when not all sessions in the booking_group have
  // ended. Previously the form rendered with a small amber warning and
  // the submit endpoint blocked at the network level — but the form
  // held no draft state, so anything the participant typed (RRN, bank,
  // signature) was silently discarded on tab close. They came back days
  // later thinking they'd "already done the form" and had to start over.
  // We now refuse to render the form at all when pending sessions remain
  // and tell them precisely when they can come back.
  const { data: groupBookings } = await supabase
    .from("bookings")
    .select("id, slot_end, status")
    .eq("booking_group_id", info.booking_group_id);
  const liveBookings = (groupBookings ?? []).filter(
    (b) => b.status === "confirmed" || b.status === "running",
  );
  const lastLiveSlotEnd = liveBookings
    .map((b) => new Date(b.slot_end).getTime())
    .reduce<number | null>((max, t) => (max === null || t > max ? t : max), null);
  const pendingCount = liveBookings.length;

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

      {pendingCount > 0 ? (
        <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-5 text-sm text-amber-900 leading-relaxed">
          <p className="mb-2 text-base font-semibold">
            ⚠ 아직 입력하실 시점이 아닙니다
          </p>
          <p className="mb-2">
            남은 회차 <b>{pendingCount}회</b>
            {lastLiveSlotEnd
              ? ` · 마지막 세션 종료 예정: ${formatDateKR(new Date(lastLiveSlotEnd).toISOString())}`
              : ""}
          </p>
          <p className="mb-3">
            지금은 작성하셔도 <b>저장되지 않습니다</b>. 모든 회차 종료 후 다시
            이 링크를 열어 한 번에 입력해 주세요. 종료 시점에 동일한 링크가
            담긴 안내 메일도 자동 재발송됩니다.
          </p>
          <p className="text-xs text-amber-800/80">
            이 메일·링크는 본인에게만 발급된 일회성 링크이니 보관해 주세요.
          </p>
        </div>
      ) : (
        <PaymentInfoForm
          token={token}
          defaultPhone={participantPhone}
          defaultEmail={participantEmail}
          experimentTitle={experimentTitle}
          amountKrw={info.amount_krw}
        />
      )}

      <div className="rounded-lg border border-border bg-muted/10 p-4 text-xs leading-relaxed text-muted">
        <p className="mb-1 font-semibold text-foreground">🔒 개인정보 처리 안내</p>
        주민등록번호는 AES-256 암호화되어 저장되며, 행정 제출용 엑셀 파일 생성 시에만 복호화됩니다.
        전자서명은 비공개 저장소에 보관되며 담당 연구원만 열람할 수 있습니다.
      </div>
    </div>
  );
}
