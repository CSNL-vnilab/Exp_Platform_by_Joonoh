"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BookingActions } from "@/components/booking-actions";

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
}

const statusCfg: Record<
  string,
  { label: string; variant: "default" | "success" | "danger" | "info" | "warning" }
> = {
  confirmed: { label: "확정", variant: "success" },
  cancelled: { label: "취소", variant: "danger" },
  completed: { label: "완료", variant: "info" },
  no_show: { label: "노쇼", variant: "warning" },
};

type Filter = "all" | "confirmed" | "cancelled" | "completed" | "no_show";

interface Props {
  experimentId: string;
  experimentTitle: string;
  projectName: string | null;
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

export function BookingsManager({ experimentId, experimentTitle, projectName, rows }: Props) {
  const [filter, setFilter] = useState<Filter>("confirmed");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<"emails" | "phones" | null>(null);

  const counts = useMemo(() => {
    const c = { confirmed: 0, cancelled: 0, completed: 0, no_show: 0 };
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
                      <th className="px-4 py-3 text-left font-medium text-muted">연락처</th>
                      <th className="px-4 py-3 text-left font-medium text-muted">예약 시간</th>
                      <th className="px-4 py-3 text-left font-medium text-muted">상태</th>
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
                          <td className="px-4 py-3 text-muted whitespace-nowrap text-xs">
                            {format(new Date(b.created_at), "yyyy.MM.dd")}
                          </td>
                          <td className="px-4 py-3">
                            {b.status === "confirmed" ? (
                              <BookingActions
                                bookingId={b.id}
                                experimentId={experimentId}
                                currentSlotStart={b.slot_start}
                                currentSlotEnd={b.slot_end}
                                sessionNumber={b.session_number}
                              />
                            ) : (
                              <span className="text-xs text-muted">—</span>
                            )}
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
                      <Badge variant={s.variant}>{s.label}</Badge>
                    </div>
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
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
