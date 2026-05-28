"use client";

import { useState } from "react";

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
  sessionDurationMinutes: number;
  weekdays: number[]; // 0..6 (Sun..Sat), KST
  editCutoffHours: number;
}

// Pads a 2-digit zero-prefixed number.
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Renders an ISO timestamp as the value `<input type="datetime-local">`
// expects: `YYYY-MM-DDTHH:mm` in the user's LOCAL timezone (the browser
// interprets datetime-local as local time, not UTC). We display values
// in KST since the lab operates there; users in other zones will see
// times that "look wrong" but the booking pipeline normalizes.
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  // Render in KST regardless of the user's locale — the picker should
  // mirror what the original booking page used. KST = UTC+9.
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${pad2(kst.getUTCMonth() + 1)}-${pad2(kst.getUTCDate())}T${pad2(kst.getUTCHours())}:${pad2(kst.getUTCMinutes())}`;
}

// Converts the datetime-local input value (which the browser treats as
// local time in the user's TZ — we assume KST per the booking flow) into
// a UTC ISO string for the API.
function localInputToKstIso(value: string): string {
  // value shape: "YYYY-MM-DDTHH:mm"
  const [datePart, timePart] = value.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  // Treat as KST → UTC.
  const utcMs = Date.UTC(y, m - 1, d, hh - 9, mm, 0);
  return new Date(utcMs).toISOString();
}

function isEditable(row: FormRow, cutoffHours: number): boolean {
  if (row.status !== "confirmed") return false;
  const cutoff = new Date(row.slot_start).getTime() - cutoffHours * 60 * 60 * 1000;
  return Date.now() < cutoff;
}

const weekdayLabelKR = ["일", "월", "화", "수", "목", "금", "토"];

export function BookingEditForm(props: Props) {
  const { token, rows, sessionDurationMinutes, weekdays, editCutoffHours } =
    props;
  const allowedWeekdaysLabel = weekdays
    .map((w) => weekdayLabelKR[w])
    .join(", ");

  const [list, setList] = useState<FormRow[]>(rows);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftStart, setDraftStart] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null); // booking id currently submitting
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function statusLabel(s: FormRow["status"]): { text: string; color: string } {
    switch (s) {
      case "confirmed":
        return { text: "예약됨", color: "text-emerald-700 bg-emerald-50 border-emerald-200" };
      case "cancelled":
        return { text: "취소됨", color: "text-gray-500 bg-gray-100 border-gray-200" };
      case "completed":
        return { text: "참여 완료", color: "text-blue-700 bg-blue-50 border-blue-200" };
      case "running":
        return { text: "진행 중", color: "text-violet-700 bg-violet-50 border-violet-200" };
      case "no_show":
        return { text: "불참", color: "text-rose-700 bg-rose-50 border-rose-200" };
    }
  }

  function startEdit(row: FormRow) {
    setEditingId(row.id);
    setDraftStart(isoToLocalInput(row.slot_start));
    setError(null);
    setInfo(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftStart("");
  }

  async function submitReschedule(row: FormRow) {
    if (!draftStart) {
      setError("새 시작 시간을 선택해 주세요.");
      return;
    }
    const startIso = localInputToKstIso(draftStart);
    const endMs = new Date(startIso).getTime() + sessionDurationMinutes * 60 * 1000;
    const endIso = new Date(endMs).toISOString();

    setBusy(row.id);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/booking-edit/${token}/${row.id}/reschedule`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot_start: startIso, slot_end: endIso }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "일정 변경에 실패했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      // Server returns the updated group so we can show renumbered sessions.
      const updated: FormRow[] | undefined = data?.rows;
      if (updated && Array.isArray(updated)) {
        setList(updated);
      } else {
        // Fallback: local patch.
        setList((prev) =>
          prev.map((r) =>
            r.id === row.id ? { ...r, slot_start: startIso, slot_end: endIso } : r,
          ),
        );
      }
      const warn: string | null = data?.calendar_sync_warning ?? null;
      setInfo(
        warn
          ? `${row.session_number}회차 일정이 변경되었습니다. 변경 안내 메일이 발송되었어요.\n⚠️ ${warn}`
          : `${row.session_number}회차 일정이 변경되었습니다. 변경 안내 메일이 발송되었어요.`,
      );
      setEditingId(null);
      setDraftStart("");
    } catch {
      setError("네트워크 오류로 일정 변경에 실패했습니다. 잠시 후 다시 시도해 주세요.");
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
          const editable = isEditable(row, editCutoffHours);
          const isEditing = editingId === row.id;
          const isBusy = busy === row.id;
          const status = statusLabel(row.status);
          return (
            <li
              key={row.id}
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {row.session_number}회차
                    <span
                      className={`ml-2 inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${status.color}`}
                    >
                      {status.text}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-gray-700">
                    {row.slot_label_date} · {row.slot_label_time}
                  </p>
                </div>

                {editable && !isEditing && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(row)}
                      disabled={isBusy}
                      className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      일정 변경
                    </button>
                    <button
                      type="button"
                      onClick={() => submitCancel(row)}
                      disabled={isBusy}
                      className="rounded border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                    >
                      {isBusy ? "취소 중..." : "참여 취소"}
                    </button>
                  </div>
                )}

                {!editable && row.status === "confirmed" && (
                  <span className="shrink-0 text-[12px] text-gray-500">
                    시작 {editCutoffHours}시간 이내 — 변경 불가
                  </span>
                )}
              </div>

              {isEditing && (
                <div className="mt-3 border-t pt-3">
                  <label className="block text-xs font-medium text-gray-700">
                    새 시작 시간 (KST)
                  </label>
                  <input
                    type="datetime-local"
                    value={draftStart}
                    onChange={(e) => setDraftStart(e.target.value)}
                    disabled={isBusy}
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="mt-1 text-[11px] text-gray-500">
                    실험 운영 요일: {allowedWeekdaysLabel} · 회차 길이{" "}
                    {sessionDurationMinutes}분 (종료 시간은 자동 계산됩니다)
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => submitReschedule(row)}
                      disabled={isBusy || !draftStart}
                      className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {isBusy ? "변경 중..." : "변경 저장"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={isBusy}
                      className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
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
