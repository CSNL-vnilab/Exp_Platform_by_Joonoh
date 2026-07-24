"use client";

import { useState } from "react";
import {
  WeekTimetable,
  type SerializedSlot,
} from "@/components/booking/week-timetable";

interface FormRow {
  id: string;
  slot_start: string;
  slot_end: string;
  session_number: number;
  status: "confirmed" | "cancelled" | "completed" | "no_show" | "running";
  slot_label_date: string;
  slot_label_time: string;
}

interface Props {
  token: string;
  rows: FormRow[];
  experimentId: string;
  startDate: string; // YYYY-MM-DD (KST)
  endDate: string; // YYYY-MM-DD (KST)
  editCutoffHours: number;
}

// A participant may REQUEST a reschedule for a confirmed, no-showed, or
// cancelled session. The request is deferred (applied only after the
// experimenter approves), so there is NO old-slot cutoff here — a past or
// missed session must still show the button. Only completed/running
// sessions are non-requestable. The NEW picked time still has to be
// ≥ cutoff in the future, but that is validated by the server on submit,
// not by whether we show the button.
function isEditable(row: FormRow): boolean {
  return (
    row.status === "confirmed" ||
    row.status === "no_show" ||
    row.status === "cancelled"
  );
}

// Renders a picked slot as "8/5 (화) 14:00–15:00" in KST for the confirm line.
const slotDateFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  weekday: "short",
});
const slotTimeFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
function formatSlotLabel(slot: SerializedSlot): string {
  const d = slotDateFmt.format(new Date(slot.slot_start));
  const t1 = slotTimeFmt.format(new Date(slot.slot_start));
  const t2 = slotTimeFmt.format(new Date(slot.slot_end));
  return `${d} ${t1}–${t2}`;
}

export function BookingEditForm(props: Props) {
  const { token, rows, experimentId, startDate, endDate, editCutoffHours } =
    props;

  const [list, setList] = useState<FormRow[]>(rows);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Per-ROW drafts (keyed by booking id) — NOT a single shared value.
  // A single shared draft meant opening a second session's picker wiped the
  // first session's in-progress pick (and left the submit button disabled).
  // Keying by row.id lets each session hold its own new-time + reason.
  const [draftByRow, setDraftByRow] = useState<Record<string, SerializedSlot | null>>({});
  const [reasonByRow, setReasonByRow] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null); // booking id currently submitting
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Booking ids whose reschedule REQUEST has been accepted this session.
  // Editing is disabled for these until the page reloads (server has the
  // pending request; a second submit would 409).
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set());

  function statusLabel(s: FormRow["status"]): { text: string; color: string } {
    switch (s) {
      case "confirmed":
        return { text: "예약됨", color: "text-emerald-700 bg-emerald-50 border-emerald-200" };
      case "cancelled":
        return { text: "취소됨", color: "text-neutral-500 bg-neutral-100 border-neutral-200" };
      case "completed":
        return { text: "참여 완료", color: "text-blue-700 bg-blue-50 border-blue-200" };
      case "running":
        return { text: "진행 중", color: "text-violet-700 bg-violet-50 border-violet-200" };
      case "no_show":
        return { text: "불참", color: "text-rose-700 bg-rose-50 border-rose-200" };
    }
  }

  function startEdit(row: FormRow) {
    // Only switch which row's panel is open — never clear another row's
    // in-progress pick. The row keeps whatever draft it already had.
    setEditingId(row.id);
    setError(null);
    setInfo(null);
  }

  function cancelEdit(rowId?: string) {
    setEditingId(null);
    // Abandon only THIS row's draft, leaving other rows' picks intact.
    if (rowId) {
      setDraftByRow((m) => ({ ...m, [rowId]: null }));
      setReasonByRow((m) => ({ ...m, [rowId]: "" }));
    }
  }

  async function submitReschedule(row: FormRow) {
    const draft = draftByRow[row.id];
    if (!draft) {
      setError("새 시간을 선택해 주세요.");
      return;
    }
    const startIso = draft.slot_start;
    const endIso = draft.slot_end;

    const reason = (reasonByRow[row.id] ?? "").trim();

    setBusy(row.id);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/booking-edit/${token}/${row.id}/reschedule`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slot_start: startIso,
          slot_end: endIso,
          ...(reason ? { reason } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Includes the 409 "이미 처리 대기 중인 변경 요청이 있습니다" case,
        // surfaced via data.error.
        setError(data?.error ?? "일정 변경 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      // The request is now DEFERRED: the server accepted a reschedule
      // REQUEST (no immediate apply, no `rows` in the response). Show the
      // returned message and lock this row from further edits until reload.
      setRequestedIds((prev) => {
        const next = new Set(prev);
        next.add(row.id);
        return next;
      });
      setInfo(
        data?.message ??
          "일정 변경 요청이 접수되었습니다. 실험자 승인 후 반영됩니다.",
      );
      setEditingId(null);
      setDraftByRow((m) => ({ ...m, [row.id]: null }));
      setReasonByRow((m) => ({ ...m, [row.id]: "" }));
    } catch {
      setError("네트워크 오류로 일정 변경 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(null);
    }
  }

  async function submitCancel(row: FormRow) {
    const ok = window.confirm(
      `${row.session_number}회차 (${row.slot_label_date} ${row.slot_label_time}) 참여를 정말 취소하시겠습니까?\n취소된 회차는 복구할 수 없습니다.`,
    );
    if (!ok) return;
    setBusy(row.id);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/booking-edit/${token}/${row.id}/cancel`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "취소에 실패했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      setList((prev) =>
        prev.map((r) =>
          r.id === row.id ? { ...r, status: "cancelled" as const } : r,
        ),
      );
      const warn: string | null = data?.calendar_sync_warning ?? null;
      setInfo(
        warn
          ? `${row.session_number}회차 참여가 취소되었습니다.\n⚠️ ${warn}`
          : `${row.session_number}회차 참여가 취소되었습니다.`,
      );
    } catch {
      setError("네트워크 오류로 취소에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3">
      {info && (
        <div className="whitespace-pre-line rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {info}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      <ul className="space-y-3">
        {list.map((row) => {
          const editable = isEditable(row);
          const isEditing = editingId === row.id;
          const isBusy = busy === row.id;
          const requested = requestedIds.has(row.id);
          const status = statusLabel(row.status);
          // Missed / cancelled sessions are re-BOOK requests; confirmed
          // sessions are advance-notice change requests.
          const isRebook =
            row.status === "no_show" || row.status === "cancelled";
          const requestLabel = isRebook
            ? "새 일정으로 재예약 요청"
            : "일정 변경 요청";
          return (
            <li
              key={row.id}
              className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-neutral-900">
                    {row.session_number}회차
                    <span
                      className={`ml-2 inline-block rounded-full border px-2 py-0.5 text-2xs font-medium ${status.color}`}
                    >
                      {status.text}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-neutral-700">
                    {row.slot_label_date} · {row.slot_label_time}
                  </p>
                </div>

                {requested && (
                  <span className="shrink-0 self-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-2xs font-medium text-amber-800">
                    요청 접수됨 (승인 대기)
                  </span>
                )}

                {editable && !isEditing && !requested && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(row)}
                      disabled={isBusy}
                      className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                    >
                      {requestLabel}
                    </button>
                    {row.status === "confirmed" && (
                      <button
                        type="button"
                        onClick={() => submitCancel(row)}
                        disabled={isBusy}
                        className="rounded border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                      >
                        {isBusy ? "취소 중..." : "참여 취소"}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {isEditing && (
                <div className="mt-3 border-t pt-3">
                  <p className="text-xs font-medium text-neutral-700">
                    새 시간 선택
                  </p>
                  <p className="mt-0.5 text-2xs text-neutral-500">
                    아래 <b className="text-green-700">예약 가능</b>(초록)
                    시간대만 선택할 수 있습니다. 지금부터 {editCutoffHours}시간
                    이내이거나 이미 찬 시간은 표시되지 않거나 선택되지 않습니다.
                  </p>

                  <div className="mt-3">
                    <WeekTimetable
                      experimentId={experimentId}
                      experiment={{ start_date: startDate, end_date: endDate }}
                      slotsUrl={`/api/booking-edit/${token}/slots?exclude=${row.id}`}
                      disableRealtime
                      singleSelect
                      selectedSlots={draftByRow[row.id] ? [draftByRow[row.id]!] : []}
                      onChange={(slots) =>
                        setDraftByRow((m) => ({ ...m, [row.id]: slots[0] ?? null }))
                      }
                    />
                  </div>

                  <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
                    {draftByRow[row.id] ? (
                      <span>
                        선택한 새 시간:{" "}
                        <b className="text-blue-700">
                          {formatSlotLabel(draftByRow[row.id]!)}
                        </b>
                      </span>
                    ) : (
                      <span className="text-neutral-500">
                        위 시간표에서 원하는 시간을 선택해 주세요.
                      </span>
                    )}
                  </div>

                  <label className="mt-3 block text-xs font-medium text-neutral-700">
                    사유 (선택)
                  </label>
                  <input
                    type="text"
                    value={reasonByRow[row.id] ?? ""}
                    onChange={(e) =>
                      setReasonByRow((m) => ({ ...m, [row.id]: e.target.value }))
                    }
                    disabled={isBusy}
                    maxLength={500}
                    placeholder="예: 개인 사정으로 참여가 어려워 일정을 옮기고 싶습니다"
                    className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="mt-1 text-2xs text-neutral-500">
                    변경은 실험자 승인 후 반영되며, 확정되면 안내 메일이
                    발송됩니다.
                  </p>

                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => submitReschedule(row)}
                      disabled={isBusy || !draftByRow[row.id]}
                      className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {isBusy ? "요청 중..." : "요청 보내기"}
                    </button>
                    <button
                      type="button"
                      onClick={() => cancelEdit(row.id)}
                      disabled={isBusy}
                      className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                    >
                      뒤로
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
