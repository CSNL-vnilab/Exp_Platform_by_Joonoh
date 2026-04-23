"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BookingActions } from "@/components/booking-actions";
import { ClassBadge } from "@/components/class-badge";
import { BookingObservationModal } from "@/components/booking-observation-modal";
import type { ParticipantClass } from "@/types/database";

export interface BookingRowView {
  id: string;
  slot_start: string;
  slot_end: string;
  session_number: number;
  status: string;
  created_at: string;
  subject_number: number | null;
  participants: {
    name: string;
    phone: string;
    email: string;
    gender: string | null;
    birthdate: string | null;
  } | null;
  run_progress?: {
    blocks_submitted: number;
    completion_code: string | null;
    completion_code_issued_at: string | null;
    verified_at: string | null;
    is_pilot?: boolean | null;
    condition_assignment?: string | null;
    attention_fail_count?: number | null;
    screener_stats?: { total: number; passed: number } | null;
  } | null;
  // Joined by the bookings page from participant_class_current (see migration
  // 00025). Null when the participant has no class row yet.
  current_class?: ParticipantClass | null;
  // True when a booking_observations row already exists for this booking.
  has_observation?: boolean;
}

const statusCfg: Record<
  string,
  { label: string; variant: "default" | "success" | "danger" | "info" | "warning" }
> = {
  confirmed: { label: "확정", variant: "success" },
  running: { label: "진행 중", variant: "warning" },
  cancelled: { label: "취소", variant: "danger" },
  completed: { label: "완료", variant: "info" },
  no_show: { label: "노쇼", variant: "warning" },
};

type Filter = "all" | "confirmed" | "running" | "cancelled" | "completed" | "no_show";

interface Props {
  experimentId: string;
  experimentTitle: string;
  projectName: string | null;
  experimentMode?: "offline" | "online" | "hybrid";
  rows: BookingRowView[];
}

function csvEscape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function toCsv(rows: BookingRowView[]): string {
  const header = [
    "Sbj",
    "회차",
    "이름",
    "전화",
    "이메일",
    "성별",
    "생년월일",
    "슬롯 시작(KST)",
    "슬롯 종료(KST)",
    "상태",
    "예약일시",
  ];
  const fmtKst = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(new Date(iso))
      .replace(",", "");
  const body = rows.map((r) => {
    const p = r.participants;
    return [
      r.subject_number != null ? `Sbj${r.subject_number}` : "",
      String(r.session_number),
      p?.name ?? "",
      p?.phone ?? "",
      p?.email ?? "",
      p?.gender ?? "",
      p?.birthdate ?? "",
      fmtKst(r.slot_start),
      fmtKst(r.slot_end),
      statusCfg[r.status]?.label ?? r.status,
      fmtKst(r.created_at),
    ]
      .map(csvEscape)
      .join(",");
  });
  // UTF-8 BOM so Excel on macOS/Windows opens it with Korean characters intact.
  return "\uFEFF" + [header.join(","), ...body].join("\n");
}

export function BookingsManager({
  experimentId,
  experimentTitle,
  projectName,
  experimentMode = "offline",
  rows,
}: Props) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("confirmed");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<"emails" | "phones" | null>(null);
  const [verifyTarget, setVerifyTarget] = useState<BookingRowView | null>(null);
  const [observationTarget, setObservationTarget] =
    useState<BookingRowView | null>(null);

  const showsOnlineCols = experimentMode !== "offline";

  const counts = useMemo(() => {
    const c = { confirmed: 0, running: 0, cancelled: 0, completed: 0, no_show: 0 };
    for (const r of rows) {
      if (r.status in c) c[r.status as keyof typeof c]++;
    }
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.status !== filter) return false;
      if (!q) return true;
      const p = r.participants;
      const hay = [
        p?.name ?? "",
        p?.phone ?? "",
        p?.email ?? "",
        r.subject_number != null ? `Sbj${r.subject_number}` : "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, filter, query]);

  function downloadCsv() {
    const csv = toCsv(visible);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeTitle = (projectName ?? experimentTitle).replace(/[\\/:*?"<>|]/g, "_");
    a.href = url;
    a.download = `${safeTitle}_bookings.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function copyField(field: "email" | "phone") {
    const list = visible
      .map((r) => (field === "email" ? r.participants?.email : r.participants?.phone) ?? "")
      .filter(Boolean);
    const text = [...new Set(list)].join(field === "email" ? "; " : "\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(field === "email" ? "emails" : "phones");
      setTimeout(() => setCopied(null), 1800);
    } catch {
      // nothing
    }
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            ["확정", counts.confirmed, "text-emerald-600"],
            ["취소", counts.cancelled, "text-rose-600"],
            ["완료", counts.completed, "text-sky-600"],
            ["노쇼", counts.no_show, "text-amber-600"],
          ] as const
        ).map(([label, n, color]) => (
          <Card key={label}>
            <CardContent>
              <div className="text-xs text-muted">{label}</div>
              <div className={`mt-0.5 text-2xl font-bold ${color}`}>{n}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Controls */}
      <Card>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ["all", `전체 (${rows.length})`],
                ["confirmed", `확정 (${counts.confirmed})`],
                ...(showsOnlineCols
                  ? ([["running", `진행 중 (${counts.running})`]] as const)
                  : ([] as const)),
                ["cancelled", `취소 (${counts.cancelled})`],
                ["completed", `완료 (${counts.completed})`],
                ["no_show", `노쇼 (${counts.no_show})`],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  filter === k
                    ? "border-foreground bg-foreground text-white"
                    : "border-border text-muted hover:bg-card"
                }`}
              >
                {label}
              </button>
            ))}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="이름·전화·이메일·Sbj 검색"
                className="w-48 rounded-lg border border-border bg-white px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <Button size="sm" variant="secondary" onClick={() => copyField("email")}>
                {copied === "emails" ? "복사됨 ✓" : "이메일 복사"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => copyField("phone")}>
                {copied === "phones" ? "복사됨 ✓" : "전화 복사"}
              </Button>
              <Button size="sm" onClick={downloadCsv} disabled={visible.length === 0}>
                CSV 다운로드
              </Button>
              {showsOnlineCols && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    try {
                      const res = await fetch(
                        `/api/experiments/${experimentId}/data-export`,
                      );
                      const body = (await res.json()) as {
                        files?: Array<{ path: string; signed_url: string | null }>;
                        error?: string;
                      };
                      if (!res.ok) {
                        alert(body.error || "목록을 불러오지 못했습니다");
                        return;
                      }
                      const files = body.files ?? [];
                      if (files.length === 0) {
                        alert("수집된 데이터가 아직 없습니다.");
                        return;
                      }
                      // Open each signed URL in a new tab; researcher's
                      // browser pop-up policy may limit this — we also
                      // dump the list to clipboard as a fallback.
                      const urls = files
                        .map((f) => f.signed_url)
                        .filter((u): u is string => !!u);
                      if (urls.length === 0) {
                        alert("서명된 URL 생성에 실패했습니다");
                        return;
                      }
                      await navigator.clipboard.writeText(urls.join("\n")).catch(() => {});
                      urls.slice(0, 10).forEach((u) => window.open(u, "_blank"));
                      if (urls.length > 10) {
                        alert(
                          `${urls.length}개 중 10개만 새 탭으로 열었습니다. 전체 URL이 클립보드에 복사되었습니다.`,
                        );
                      }
                    } catch (err) {
                      alert(
                        "오류가 발생했습니다: " +
                          (err instanceof Error ? err.message : String(err)),
                      );
                    }
                  }}
                >
                  원본 데이터 다운로드
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table (desktop) / cards (mobile) */}
      {visible.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">
            조건에 맞는 예약이 없습니다.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden sm:block">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-card">
                      <th className="px-4 py-3 text-left font-medium text-muted">Sbj</th>
                      <th className="px-4 py-3 text-left font-medium text-muted">참여자</th>
                      <th className="px-4 py-3 text-left font-medium text-muted">클래스</th>
                      <th className="px-4 py-3 text-left font-medium text-muted">연락처</th>
                      <th className="px-4 py-3 text-left font-medium text-muted">예약 시간</th>
                      <th className="px-4 py-3 text-left font-medium text-muted">상태</th>
                      {showsOnlineCols && (
                        <th className="px-4 py-3 text-left font-medium text-muted">온라인 진행</th>
                      )}
                      <th className="px-4 py-3 text-left font-medium text-muted">예약일</th>
                      <th className="px-4 py-3 text-left font-medium text-muted">관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((b) => {
                      const p = b.participants;
                      const s = statusCfg[b.status] ?? statusCfg.confirmed;
                      return (
                        <tr
                          key={b.id}
                          className="border-b border-border last:border-b-0 hover:bg-card/50"
                        >
                          <td className="px-4 py-3 whitespace-nowrap text-foreground">
                            {b.subject_number != null ? `Sbj${b.subject_number}` : "-"}
                          </td>
                          <td className="px-4 py-3 font-medium text-foreground">
                            {p?.name ?? "-"}
                            {b.session_number > 1 && (
                              <span className="ml-1 text-xs text-muted">
                                ({b.session_number}회차)
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <ClassBadge value={b.current_class ?? null} />
                          </td>
                          <td className="px-4 py-3 text-muted">
                            <div className="tabular-nums">{p?.phone ?? "-"}</div>
                            <div className="text-xs truncate max-w-[220px]">{p?.email ?? ""}</div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-foreground tabular-nums">
                            {format(new Date(b.slot_start), "MM.dd HH:mm")} –{" "}
                            {format(new Date(b.slot_end), "HH:mm")}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={s.variant}>{s.label}</Badge>
                          </td>
                          {showsOnlineCols && (
                            <td className="px-4 py-3 text-xs">
                              <RunProgressCell row={b} />
                            </td>
                          )}
                          <td className="px-4 py-3 text-muted whitespace-nowrap text-xs">
                            {format(new Date(b.created_at), "yyyy.MM.dd")}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              {b.status === "confirmed" && (
                                <BookingActions
                                  bookingId={b.id}
                                  experimentId={experimentId}
                                  currentSlotStart={b.slot_start}
                                  currentSlotEnd={b.slot_end}
                                  sessionNumber={b.session_number}
                                />
                              )}
                              {showsOnlineCols &&
                                b.run_progress?.completion_code &&
                                !b.run_progress.verified_at && (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => setVerifyTarget(b)}
                                  >
                                    코드 확인
                                  </Button>
                                )}
                              {showsOnlineCols &&
                                (b.status === "confirmed" || b.status === "running") &&
                                !b.run_progress?.completion_code && (
                                  <ReissueTokenButton
                                    bookingId={b.id}
                                    experimentId={experimentId}
                                  />
                                )}
                              {showsOnlineCols && (
                                <PilotToggleButton
                                  booking={b}
                                  experimentId={experimentId}
                                />
                              )}
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setObservationTarget(b)}
                                title={
                                  b.has_observation
                                    ? "저장된 관찰 기록 수정"
                                    : "관찰 기록 입력"
                                }
                              >
                                <PencilIcon
                                  filled={!!b.has_observation}
                                  className="mr-1 h-3.5 w-3.5"
                                />
                                관찰 입력
                              </Button>
                              {b.status !== "confirmed" &&
                                !(
                                  showsOnlineCols &&
                                  b.run_progress?.completion_code &&
                                  !b.run_progress.verified_at
                                ) &&
                                !b.has_observation && (
                                  <span className="sr-only">—</span>
                                )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Mobile cards */}
          <div className="space-y-2 sm:hidden">
            {visible.map((b) => {
              const p = b.participants;
              const s = statusCfg[b.status] ?? statusCfg.confirmed;
              return (
                <Card key={b.id}>
                  <CardContent>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {p?.name ?? "-"}
                          </span>
                          {b.subject_number != null && (
                            <span className="text-xs text-muted">Sbj{b.subject_number}</span>
                          )}
                          {b.session_number > 1 && (
                            <span className="text-xs text-muted">· {b.session_number}회차</span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-muted tabular-nums">
                          {format(new Date(b.slot_start), "MM.dd HH:mm")} –{" "}
                          {format(new Date(b.slot_end), "HH:mm")}
                        </div>
                        <div className="mt-0.5 text-xs text-muted">
                          {p?.phone ?? ""}
                          {p?.email ? ` · ${p.email}` : ""}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Badge variant={s.variant}>{s.label}</Badge>
                        <ClassBadge value={b.current_class ?? null} compact />
                      </div>
                    </div>
                    {showsOnlineCols && (
                      <div className="mt-2">
                        <RunProgressCell row={b} />
                      </div>
                    )}
                    {b.status === "confirmed" && (
                      <div className="mt-3">
                        <BookingActions
                          bookingId={b.id}
                          experimentId={experimentId}
                          currentSlotStart={b.slot_start}
                          currentSlotEnd={b.slot_end}
                          sessionNumber={b.session_number}
                        />
                      </div>
                    )}
                    {showsOnlineCols &&
                      b.run_progress?.completion_code &&
                      !b.run_progress.verified_at && (
                        <div className="mt-3">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setVerifyTarget(b)}
                          >
                            코드 확인
                          </Button>
                        </div>
                      )}
                    <div className="mt-3">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setObservationTarget(b)}
                      >
                        <PencilIcon
                          filled={!!b.has_observation}
                          className="mr-1 h-3.5 w-3.5"
                        />
                        관찰 입력
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {verifyTarget && (
        <VerifyCompletionModal
          booking={verifyTarget}
          experimentId={experimentId}
          onClose={() => setVerifyTarget(null)}
        />
      )}

      {observationTarget && (
        <BookingObservationModal
          bookingId={observationTarget.id}
          slotStart={observationTarget.slot_start}
          slotEnd={observationTarget.slot_end}
          bookingStatus={observationTarget.status}
          open={!!observationTarget}
          onClose={() => setObservationTarget(null)}
          onSaved={() => {
            // Refresh so has_observation + possibly-updated booking status
            // (post_survey_done=true flips the row to "completed") rehydrate.
            setObservationTarget(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function ReissueTokenButton({
  bookingId,
  experimentId,
}: {
  bookingId: string;
  experimentId: string;
}) {
  const [busy, setBusy] = useState(false);
  async function reissue() {
    if (!window.confirm("새로운 /run 링크를 발급합니다. 기존 링크는 즉시 만료됩니다. 계속할까요?")) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/data/${bookingId}/reissue-token`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        run_url?: string;
        error?: string;
      };
      if (!res.ok || !body.run_url) {
        alert(body.error || "링크 재발급에 실패했습니다");
        return;
      }
      try {
        await navigator.clipboard.writeText(body.run_url);
        alert("새 링크가 클립보드에 복사되었습니다. 참여자에게 전달해 주세요.");
      } catch {
        prompt("새 링크(복사하여 전달):", body.run_url);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size="sm" variant="secondary" onClick={reissue} disabled={busy}>
      {busy ? "발급 중…" : "링크 재발급"}
    </Button>
  );
}

function RunProgressCell({ row }: { row: BookingRowView }) {
  const p = row.run_progress;
  if (!p) {
    return <span className="text-muted">대기 중</span>;
  }
  const badges = (
    <div className="flex flex-wrap items-center gap-1">
      {p.is_pilot && (
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
          파일럿
        </span>
      )}
      {p.condition_assignment && (
        <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
          {p.condition_assignment}
        </span>
      )}
      {typeof p.attention_fail_count === "number" && p.attention_fail_count > 0 && (
        <span
          className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700"
          title="주의 체크 실패"
        >
          ⚠ {p.attention_fail_count}
        </span>
      )}
      {p.screener_stats && p.screener_stats.total > 0 && (
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
            p.screener_stats.passed < p.screener_stats.total
              ? "bg-rose-100 text-rose-700"
              : "bg-emerald-100 text-emerald-700"
          }`}
          title="스크리너 통과/전체"
        >
          스크리너 {p.screener_stats.passed}/{p.screener_stats.total}
        </span>
      )}
    </div>
  );
  if (p.verified_at) {
    return (
      <div className="space-y-0.5">
        <div className="font-medium text-emerald-700">✓ 코드 확인됨</div>
        <div className="text-muted">{p.blocks_submitted}개 블록 제출</div>
        {badges}
      </div>
    );
  }
  if (p.completion_code) {
    return (
      <div className="space-y-0.5">
        <div className="font-mono text-[11px] font-semibold text-foreground break-all">
          {p.completion_code}
        </div>
        <div className="text-amber-700">확인 대기</div>
        {badges}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <div className="text-foreground">{p.blocks_submitted}개 블록 제출</div>
      <div className="text-muted">미완료</div>
      {badges}
    </div>
  );
}

function PilotToggleButton({
  booking,
  experimentId,
}: {
  booking: BookingRowView;
  experimentId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const isPilot = booking.run_progress?.is_pilot ?? false;
  const hasBlocks = (booking.run_progress?.blocks_submitted ?? 0) > 0;
  if (!booking.run_progress) return null;
  if (hasBlocks) return null;
  async function toggle() {
    if (
      !window.confirm(
        isPilot
          ? "파일럿 표시를 해제합니다. 이후 블록은 정식 데이터로 저장됩니다."
          : "파일럿으로 표시합니다. 데이터는 _pilot/ 경로에 저장되어 최종 분석에서 분리됩니다.",
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/pilot-toggle`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ booking_id: booking.id, is_pilot: !isPilot }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        alert(body.error || "변경 실패");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size="sm" variant="secondary" onClick={toggle} disabled={busy}>
      {busy ? "변경 중…" : isPilot ? "파일럿 해제" : "파일럿 표시"}
    </Button>
  );
}

function VerifyCompletionModal({
  booking,
  experimentId,
  onClose,
}: {
  booking: BookingRowView;
  experimentId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  // Start empty: the researcher must type what the participant reported,
  // not click-through the expected code the server already knows.
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/experiments/${experimentId}/data/${booking.id}/verify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completion_code: code }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErr(body.error || "확인에 실패했습니다");
        return;
      }
      setOk(true);
      setTimeout(() => {
        onClose();
        router.refresh();
      }, 800);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-foreground">완료 코드 확인</h3>
        <p className="mt-1 text-xs text-muted">
          참여자가 제출한 코드를 입력하면 예약 상태가 &ldquo;완료&rdquo;로 전환됩니다.
        </p>
        <label className="mt-4 block">
          <span className="text-xs font-medium text-muted">완료 코드</span>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border px-3 py-2 font-mono text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            placeholder="참여자가 전달한 코드"
          />
        </label>
        {err && (
          <p className="mt-3 rounded-lg bg-red-50 p-2 text-xs text-red-700">{err}</p>
        )}
        {ok && (
          <p className="mt-3 rounded-lg bg-emerald-50 p-2 text-xs text-emerald-700">
            확인되었습니다. 새로고침합니다…
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button size="sm" onClick={submit} disabled={busy || !code.trim() || ok}>
            {busy ? "확인 중…" : "확인"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Pencil glyph — filled when a booking_observations row exists, outlined
// otherwise. Inline SVG matches the rest of bookings-manager's chrome.
function PencilIcon({
  filled,
  className = "",
}: {
  filled: boolean;
  className?: string;
}) {
  if (filled) {
    return (
      <svg
        aria-hidden
        className={className}
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L4 13.172V16h2.828l7.379-7.379-2.828-2.828z" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.586 3.586a2 2 0 012.828 2.828L6.414 17.414 3 18l.586-3.414L14.586 3.586z"
      />
    </svg>
  );
}
