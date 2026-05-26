import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  verifyBookingEditToken,
  BookingEditTokenError,
} from "@/lib/booking-edit/token";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { BRAND_NAME } from "@/lib/branding";
import { BookingEditForm } from "./edit-form";

interface PageProps {
  params: Promise<{ token: string }>;
}

// Two surfaces only: "expired" (user-friendly; user benefits from knowing
// to request a new link) and a generic "invalid" for every other failure
// mode. Conflating SHAPE/SIGNATURE prevents token enumeration.
type TokenFailure = "EXPIRED" | "INVALID";

function Failure({ code }: { code: TokenFailure }) {
  const messages: Record<TokenFailure, { title: string; detail: string }> = {
    EXPIRED: {
      title: "링크가 만료되었습니다",
      detail:
        "실험 수정 링크는 발급일로부터 60일간 유효합니다. 담당 연구원에게 새 링크를 요청해 주세요.",
    },
    INVALID: {
      title: "링크가 유효하지 않습니다",
      detail:
        "이메일의 링크 전체를 복사하셨는지 확인해 주세요. 문제가 계속되면 담당 연구원에게 문의해 주세요.",
    },
  };
  const m = messages[code];
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
        <h1 className="mb-2 text-lg font-semibold text-amber-900">{m.title}</h1>
        <p className="text-sm leading-relaxed text-amber-800">{m.detail}</p>
      </div>
    </main>
  );
}

export default async function BookingEditPage({ params }: PageProps) {
  const { token } = await params;
  if (!token || token.length < 10) notFound();

  let verified;
  try {
    verified = verifyBookingEditToken(token);
  } catch (err) {
    if (err instanceof BookingEditTokenError && err.code === "EXPIRED") {
      return <Failure code="EXPIRED" />;
    }
    return <Failure code="INVALID" />;
  }

  const supabase = createAdminClient();

  // Load every booking in the participant's group, including the ones that
  // are already cancelled/completed — the page shows them all so the
  // participant can see what's actionable vs already locked in.
  const { data: bookings } = await supabase
    .from("bookings")
    .select(
      "id, slot_start, slot_end, session_number, status, experiment_id, participants(name, email), experiments(title, session_duration_minutes, max_participants_per_slot, weekdays, experiment_mode)",
    )
    .eq("booking_group_id", verified.bookingGroupId)
    .order("session_number", { ascending: true });

  if (!bookings || bookings.length === 0) {
    return <Failure code="INVALID" />;
  }

  type Row = {
    id: string;
    slot_start: string;
    slot_end: string;
    session_number: number;
    status: "confirmed" | "cancelled" | "completed" | "no_show" | "running";
    experiment_id: string;
    participants: { name: string; email: string } | null;
    experiments: {
      title: string;
      session_duration_minutes: number;
      max_participants_per_slot: number;
      weekdays: number[];
      experiment_mode: "offline" | "online" | "hybrid";
    } | null;
  };

  const rows = bookings as unknown as Row[];
  const first = rows[0];
  if (!first.experiments || !first.participants) {
    return <Failure code="INVALID" />;
  }

  const participantName = first.participants.name;
  const experimentTitle = first.experiments.title;
  const sessionDuration = first.experiments.session_duration_minutes;
  const weekdays = first.experiments.weekdays;

  // Booking starts must be at least N hours in the future. 24h matches the
  // historic "변경·취소는 24시간 전까지" guidance the old emails carried.
  const editCutoffHours = 24;

  const formRows = rows.map((r) => ({
    id: r.id,
    slot_start: r.slot_start,
    slot_end: r.slot_end,
    session_number: r.session_number,
    status: r.status,
    slot_label_date: formatDateKR(r.slot_start),
    slot_label_time: `${formatTimeKR(r.slot_start)} – ${formatTimeKR(r.slot_end)}`,
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="mb-6">
        <p className="text-sm text-gray-500">{BRAND_NAME}</p>
        <h1 className="mt-1 text-xl font-semibold text-gray-900">
          실험 일정 수정 / 취소
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-700">
          {participantName}님, <b>{experimentTitle}</b> 실험 예약 정보입니다.
          아래에서 회차별로 일정을 변경하거나 참여를 취소하실 수 있습니다.
        </p>
      </header>

      <BookingEditForm
        token={token}
        rows={formRows}
        sessionDurationMinutes={sessionDuration}
        weekdays={weekdays}
        editCutoffHours={editCutoffHours}
      />

      <aside className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm leading-relaxed text-gray-700">
        <p className="font-semibold text-gray-900">참고 사항</p>
        <ul className="mt-2 list-disc pl-5 text-[13px]">
          <li>
            일정 변경 / 취소는 각 회차 시작 <b>{editCutoffHours}시간 전</b>까지
            가능합니다. 그 이후에는 담당 연구원에게 직접 연락해 주세요.
          </li>
          <li>
            새로 선택하신 시간이 이미 다른 참여자의 예약과 겹치거나 실험
            운영일이 아닌 경우 변경이 거부됩니다.
          </li>
          <li>
            변경 / 취소 시 담당 연구원에게도 자동으로 알림이 전송됩니다.
          </li>
        </ul>
      </aside>
    </main>
  );
}
