"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ClassBadge } from "@/components/class-badge";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";
import type { ParticipantClass, UserRole } from "@/types/database";

// Matches the response contract from GET /api/participants/[participantId].
export interface ParticipantDetailData {
  participant: {
    id: string;
    // PII fields are null for non-admin researchers — the server strips them
    // before the RSC payload is generated. Only `id` and `created_at` are
    // guaranteed to be populated.
    name: string | null;
    phone: string | null;
    email: string | null;
    gender: "male" | "female" | "other" | null;
    birthdate: string | null;
    created_at: string;
  };
  lab_identity: {
    public_code: string;
    lab_code: string;
  };
  class: {
    class: ParticipantClass;
    reason: string | null;
    assigned_by: string | null;
    assigned_kind: "auto" | "manual";
    valid_from: string;
    valid_until: string | null;
    completed_count: number;
  } | null;
  bookings: Array<{
    id: string;
    experiment_title: string;
    experiment_id: string;
    slot_start: string;
    slot_end: string;
    status: string;
    session_number: number;
    subject_number: number | null;
  }>;
  stats: {
    completed: number;
    confirmed: number;
    cancelled: number;
    no_show: number;
  };
  audit: Array<{
    previous_class: ParticipantClass | null;
    new_class: ParticipantClass;
    reason: string | null;
    changed_kind: "auto" | "manual";
    changed_by: string | null;
    created_at: string;
  }>;
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

const genderLabels: Record<string, string> = {
  male: "남성",
  female: "여성",
  other: "기타",
};

interface Props {
  data: ParticipantDetailData;
  role: UserRole;
}

export function ParticipantDetail({ data, role }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const isAdmin = role === "admin";

  const [classModalOpen, setClassModalOpen] = useState(false);

  const current = data.class;
  const isBlacklisted = current?.class === "blacklist";

  return (
    <div>
      <div className="mb-4">
        <Link
          href="/participants"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground"
        >
          ← 참여자 목록으로
        </Link>
      </div>

      {isBlacklisted && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-900"
        >
          이 참여자는 블랙리스트 상태입니다. 신규 예약은 자동으로 차단됩니다.
        </div>
      )}

      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-foreground">
            {isAdmin && data.participant.name
              ? data.participant.name
              : data.lab_identity.public_code}
          </h1>
          <span className="rounded-md bg-card px-2 py-0.5 text-xs text-muted">
            {data.lab_identity.public_code}
          </span>
          <ClassBadge value={current?.class ?? null} />
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="rounded-full bg-sky-50 px-3 py-1 text-sky-800">
            완료 {data.stats.completed}
          </span>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-800">
            예정 {data.stats.confirmed}
          </span>
          <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-800">
            노쇼 {data.stats.no_show}
          </span>
          <span className="rounded-full bg-rose-50 px-3 py-1 text-rose-800">
            취소 {data.stats.cancelled}
          </span>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 개인정보 — admin-only. Researchers only see the public code card below. */}
        {isAdmin ? (
          <Card>
            <CardContent>
              <h2 className="mb-4 text-lg font-semibold text-foreground">
                개인정보
              </h2>
              <dl className="grid gap-3 text-sm">
                <Row label="이름" value={data.participant.name} />
                <Row
                  label="전화번호"
                  value={data.participant.phone || "(미입력)"}
                  mono
                />
                <Row
                  label="이메일"
                  value={
                    /@-$|@no-email\.local$|@imported\.invalid$/.test(
                      data.participant.email ?? "",
                    )
                      ? "(미입력)"
                      : data.participant.email
                  }
                  mono
                />
                <Row
                  label="성별"
                  value={
                    data.participant.gender
                      ? (genderLabels[data.participant.gender] ?? "-")
                      : "-"
                  }
                />
                <Row
                  label="생년월일"
                  value={data.participant.birthdate || "-"}
                  mono
                />
                <Row
                  label="최초 등록일"
                  value={formatDateKR(data.participant.created_at)}
                />
              </dl>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent>
              <h2 className="mb-4 text-lg font-semibold text-foreground">
                공개 식별자
              </h2>
              <p className="text-sm text-muted">
                연구원 계정은 개인식별정보에 접근할 수 없습니다. 아래 공개 ID로
                참여자를 식별해 주세요.
              </p>
              <div className="mt-3 rounded-lg border border-border bg-card px-3 py-2 font-mono text-sm text-foreground">
                {data.lab_identity.public_code}
              </div>
            </CardContent>
          </Card>
        )}

        {/* 클래스 관리 */}
        <Card>
          <CardContent>
            <div className="mb-3 flex items-start justify-between gap-2">
              <h2 className="text-lg font-semibold text-foreground">클래스 관리</h2>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setClassModalOpen(true)}
              >
                클래스 변경
              </Button>
            </div>
            {current ? (
              <dl className="grid gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <dt className="text-muted">현재 클래스</dt>
                  <dd>
                    <ClassBadge value={current.class} />
                  </dd>
                </div>
                <Row label="사유" value={current.reason ?? "-"} />
                <Row
                  label="지정 방식"
                  value={current.assigned_kind === "manual" ? "수동" : "자동"}
                />
                <Row
                  label="지정자"
                  value={current.assigned_by ?? "시스템"}
                  mono={!!current.assigned_by}
                />
                <Row
                  label="유효 시작"
                  value={
                    current.valid_from
                      ? `${formatDateKR(current.valid_from)} ${formatTimeKR(current.valid_from)}`
                      : "-"
                  }
                />
                <Row
                  label="유효 종료"
                  value={
                    current.valid_until
                      ? `${formatDateKR(current.valid_until)} ${formatTimeKR(current.valid_until)}`
                      : "무기한"
                  }
                />
                <Row
                  label="누적 완료 세션"
                  value={`${current.completed_count}회`}
                />
              </dl>
            ) : (
              <p className="text-sm text-muted">
                아직 클래스가 지정되지 않았습니다 (미분류).
              </p>
            )}
          </CardContent>
        </Card>

        {/* 클래스 변경 이력 (audit trail — QC R-H3) */}
        <Card className="lg:col-span-2">
          <CardContent>
            <h2 className="mb-4 text-lg font-semibold text-foreground">
              클래스 변경 이력
            </h2>
            {data.audit.length === 0 ? (
              <p className="text-sm text-muted">이력이 없습니다.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {data.audit.map((a, i) => (
                  <li
                    key={i}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
                  >
                    <span className="whitespace-nowrap tabular-nums text-xs text-muted">
                      {formatDateKR(a.created_at)} {formatTimeKR(a.created_at)}
                    </span>
                    <div className="flex items-center gap-2">
                      <ClassBadge value={a.previous_class} compact />
                      <span className="text-muted">→</span>
                      <ClassBadge value={a.new_class} compact />
                    </div>
                    <Badge
                      variant={a.changed_kind === "manual" ? "info" : "default"}
                    >
                      {a.changed_kind === "manual" ? "수동" : "자동"}
                    </Badge>
                    {a.reason && (
                      <span className="flex-1 basis-full text-xs text-muted sm:basis-auto">
                        · {a.reason}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        {/* 예약 이력 */}
        <Card className="lg:col-span-2">
          <CardContent>
            <h2 className="mb-4 text-lg font-semibold text-foreground">예약 이력</h2>
            {data.bookings.length === 0 ? (
              <p className="text-sm text-muted">예약 이력이 없습니다.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-card text-left">
                      <th className="px-3 py-2 font-medium text-muted">실험명</th>
                      <th className="px-3 py-2 font-medium text-muted">일시</th>
                      <th className="px-3 py-2 font-medium text-muted">회차</th>
                      <th className="px-3 py-2 font-medium text-muted">Sbj</th>
                      <th className="px-3 py-2 font-medium text-muted">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bookings.map((b) => {
                      const s = statusCfg[b.status] ?? {
                        label: b.status,
                        variant: "default" as const,
                      };
                      return (
                        <tr
                          key={b.id}
                          className="border-b border-border last:border-b-0"
                        >
                          <td className="px-3 py-2">
                            <Link
                              href={`/experiments/${b.experiment_id}`}
                              className="text-primary hover:underline"
                            >
                              {b.experiment_title}
                            </Link>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap tabular-nums text-foreground">
                            {formatDateKR(b.slot_start)} {formatTimeKR(b.slot_start)}
                          </td>
                          <td className="px-3 py-2 text-muted">{b.session_number}</td>
                          <td className="px-3 py-2 text-muted">
                            {b.subject_number != null ? `Sbj${b.subject_number}` : "-"}
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant={s.variant}>{s.label}</Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <ClassEditModal
        open={classModalOpen}
        onClose={() => setClassModalOpen(false)}
        current={current?.class ?? null}
        isAdmin={isAdmin}
        participantId={data.participant.id}
        onSaved={() => {
          setClassModalOpen(false);
          toast("클래스가 변경되었습니다.", "success");
          router.refresh();
        }}
      />
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd
        className={`mt-0.5 text-foreground ${mono ? "font-mono text-xs break-all" : ""}`}
      >
        {value ?? "-"}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Class edit modal
// ---------------------------------------------------------------------------

interface ClassEditModalProps {
  open: boolean;
  onClose: () => void;
  current: ParticipantClass | null;
  isAdmin: boolean;
  participantId: string;
  onSaved: () => void;
}

const CLASS_OPTIONS: Array<{ value: ParticipantClass; label: string; adminOnly: boolean }> = [
  { value: "newbie", label: "뉴비", adminOnly: false },
  { value: "royal", label: "로열", adminOnly: false },
  { value: "blacklist", label: "블랙리스트", adminOnly: true },
  { value: "vip", label: "VIP", adminOnly: true },
];

function ClassEditModal({
  open,
  onClose,
  current,
  isAdmin,
  participantId,
  onSaved,
}: ClassEditModalProps) {
  const { toast } = useToast();
  const [chosen, setChosen] = useState<ParticipantClass>(current ?? "newbie");
  const [reason, setReason] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit() {
    setErr(null);

    // Mirror the server's zod: blacklist requires a ≥5-char reason.
    if (chosen === "blacklist" && reason.trim().length < 5) {
      setErr("블랙리스트 지정은 5자 이상의 사유가 필요합니다.");
      return;
    }

    if (chosen === "blacklist") {
      const confirmed = window.confirm(
        "정말 블랙리스트로 지정하시겠습니까? 이 작업은 감사 로그에 기록됩니다.",
      );
      if (!confirmed) return;
    }

    setSaving(true);
    try {
      const body: {
        class: ParticipantClass;
        reason?: string;
        valid_until?: string | null;
      } = { class: chosen };
      if (reason.trim()) body.reason = reason.trim();
      if (validUntil) {
        // datetime-local value interpreted as KST, matching experiment-detail.tsx.
        body.valid_until = new Date(validUntil + "+09:00").toISOString();
      }

      const res = await fetch(`/api/participants/${participantId}/class`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 429) {
          setErr(j.error ?? "너무 자주 변경했습니다. 잠시 후 다시 시도하세요.");
        } else if (res.status === 403) {
          setErr(j.error ?? "권한이 없습니다. 관리자에게 문의하세요.");
        } else if (res.status === 400) {
          setErr(j.error ?? "입력값을 확인해 주세요.");
        } else {
          setErr(j.error ?? "저장에 실패했습니다.");
        }
        return;
      }

      // Surface the blacklist → future-booking cascade count so the admin
      // knows how many active invitations were cancelled as part of this
      // action.
      const payload = (await res.json().catch(() => ({}))) as {
        cascade_cancelled_bookings?: number;
      };
      if ((payload.cascade_cancelled_bookings ?? 0) > 0) {
        toast(
          `향후 예약 ${payload.cascade_cancelled_bookings}건이 자동 취소되었습니다.`,
          "info",
        );
      }

      setReason("");
      setValidUntil("");
      onSaved();
    } catch {
      toast("네트워크 오류가 발생했습니다.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="클래스 변경">
      <div className="space-y-4">
        <div>
          <label
            htmlFor="class-select"
            className="text-xs font-medium text-muted"
          >
            클래스
          </label>
          <select
            id="class-select"
            value={chosen}
            onChange={(e) => setChosen(e.target.value as ParticipantClass)}
            className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            {CLASS_OPTIONS.map((opt) => (
              <option
                key={opt.value}
                value={opt.value}
                disabled={opt.adminOnly && !isAdmin}
              >
                {opt.label}
                {opt.adminOnly && !isAdmin ? " (관리자 전용)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="class-reason" className="text-xs font-medium text-muted">
            사유 {chosen === "blacklist" && <span className="text-danger">*</span>}
          </label>
          <textarea
            id="class-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              chosen === "blacklist"
                ? "구체적인 사유를 5자 이상 입력해 주세요."
                : "선택 사항"
            }
            className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div>
          <label
            htmlFor="class-valid-until"
            className="text-xs font-medium text-muted"
          >
            유효 종료 (선택, KST)
          </label>
          <input
            id="class-valid-until"
            type="datetime-local"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <p className="mt-1 text-xs text-muted">
            비워두면 무기한으로 적용됩니다.
          </p>
        </div>

        {err && (
          <p className="rounded-lg bg-red-50 p-2 text-xs text-red-700">{err}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            취소
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={saving}
            variant={chosen === "blacklist" ? "danger" : "primary"}
          >
            {saving ? "저장 중…" : "저장"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
