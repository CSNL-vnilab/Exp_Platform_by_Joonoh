import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  verifyBookingEditToken,
  BookingEditTokenError,
} from "@/lib/booking-edit/token";
import {
  readVerifySession,
  BOOKING_EDIT_SESSION_COOKIE,
} from "@/lib/booking-edit/session";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import { BOOKING_EDIT_CUTOFF_HOURS } from "@/lib/utils/constants";
import { BRAND_NAME } from "@/lib/branding";
import { BookingEditForm } from "./edit-form";
import { VerifyForm } from "./verify-form";

interface PageProps {
  params: Promise<{ token: string }>;
}

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

  // Identity gate: until the participant proves name + phone we don't
  // expose any personal info (own name, email, slot list). The verify
  // screen shows only the experiment title — already implied by anyone
  // who has the email link, so no incremental leak.
  const cookieJar = await cookies();
  const sessionRaw = cookieJar.get(BOOKING_EDIT_SESSION_COOKIE)?.value;
  const session = readVerifySession(sessionRaw, verified.bookingGroupId);

  const supabase = createAdminClient();

  if (!session) {
    const { data: titleRow } = await supabase
      .from("bookings")
      .select("experiments(title)")
      .eq("booking_group_id", verified.bookingGroupId)
      .limit(1)
      .maybeSingle();
    const titleData = titleRow as
      | { experiments: { title: string } | null }
      | null;
    if (!titleData || !titleData.experiments) {
      return <Failure code="INVALID" />;
    }
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <header className="mb-6">
          <p className="text-sm text-gray-500">{BRAND_NAME}</p>
          <h1 className="mt-1 text-xl font-semibold text-gray-900">
            본인 확인
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-700">
            <b>{titleData.experiments.title}</b> 실험 예약에 등록하신 이름과
            전화번호를 입력해 주세요. 입력하신 정보가 일치할 때만 일정 변경 ·
            취소 페이지로 진입할 수 있습니다.
          </p>
        </header>
        <VerifyForm token={token} />
        <aside className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm leading-relaxed text-gray-700">
          <p className="font-semibold text-gray-900">참고 사항</p>
          <ul className="mt-2 list-disc pl-5 text-[13px]">
            <li>예약 시 입력하신 그대로의 이름·전화번호를 사용해 주세요.</li>
            <li>
              전화번호는 하이픈 (-) 유무 모두 가능합니다. (예: 010-1234-5678
              또는 01012345678)
            </li>
            <li>본인 확인 후 24시간 동안 같은 기기에서는 다시 묻지 않습니다.</li>
          </ul>
        </aside>
      </main>
    );
  }

  // Authenticated branch — load every booking in the group, ordered
  // chronologically by session_number (which renumberSessionsInGroup
  // keeps in sync with slot_start whenever a reschedule lands).
  const { data: bookings } = await supabase
    .from("bookings")
    .select(
      "id, slot_start, slot_end, session_number, status, experiment_id, participant_id, participants(name, email), experiments(title, session_duration_minutes, max_participants_per_slot, weekdays, experiment_mode)",
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
    participant_id: string;
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

  // Defense in depth: re-validate that the session cookie's participant_id
  // matches the group's participant. Cookies are group-scoped already by
  // the signed payload, but pinning to participant_id catches a stale
  // cookie surviving a group reassignment edge case.
  if (first.participant_id && session.participantId !== first.participant_id) {
    return <Failure code="INVALID" />;
  }

  const participantName = first.participants.name;
  const experimentTitle = first.experiments.title;
  const sessionDuration = first.experiments.session_duration_minutes;
  const weekdays = first.experiments.weekdays;

  // Shared with the API gates and the edit-link emails — one constant so the
  // displayed and enforced cutoffs never drift.
  const editCutoffHours = BOOKING_EDIT_CUTOFF_HOURS;

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
          아래에서 회차별로 일정 변경을 요청하거나 참여를 취소하실 수 있습니다.
          일정 변경은 실험자 승인 후 반영되며, 확정되면 안내 메일이
          발송됩니다.
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
            일정 변경은 <b>요청 → 실험자 승인 → 확정 메일</b> 순서로
            진행됩니다. 요청하신 시간은 실험자가 승인해야 실제 예약에
            반영됩니다.
          </li>
          <li>
            이미 지난 회차나 <b>불참 · 취소</b>된 회차도 새 일정으로 재조정을
            요청하실 수 있습니다. 다만 새로 선택하시는 시간은 지금부터{" "}
            <b>{editCutoffHours}시간 이후</b>여야 합니다.
          </li>
          <li>
            선택하신 시간이 다른 참여자의 예약과 겹치거나 실험 운영일이 아닌
            경우 요청이 거부될 수 있습니다.
          </li>
          <li>
            참여 취소는 즉시 처리되며, 요청 접수 및 승인 결과는 안내 메일로
            전달됩니다.
          </li>
        </ul>
      </aside>
    </main>
  );
}
