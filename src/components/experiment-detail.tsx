"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ExperimentForm } from "@/components/experiment-form";
import type { Experiment, ExperimentChecklistItem } from "@/types/database";
import { format } from "date-fns";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";

const statusConfig: Record<
  string,
  { label: string; variant: "default" | "success" | "info" | "danger" }
> = {
  draft: { label: "초안", variant: "default" },
  active: { label: "진행 중", variant: "success" },
  completed: { label: "완료", variant: "info" },
  cancelled: { label: "취소", variant: "danger" },
};

interface ManualBlock {
  id: string;
  block_start: string;
  block_end: string;
  reason: string | null;
  created_at: string;
}

// datetime-local value (no timezone) → ISO UTC string, treating input as KST
function toIso(local: string): string {
  return new Date(local + "+09:00").toISOString();
}

// ISO UTC string → datetime-local string (KST)
function toLocal(iso: string): string {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600_000);
  return kst.toISOString().slice(0, 16);
}

interface ExperimentDetailProps {
  experiment: Experiment;
  bookingCount: number;
}

export function ExperimentDetail({ experiment, bookingCount }: ExperimentDetailProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [updating, setUpdating] = useState(false);

  // Checklist state mirrors DB; we PATCH on each toggle.
  const [checklist, setChecklist] = useState<ExperimentChecklistItem[]>(
    experiment.pre_experiment_checklist ?? [],
  );
  const [checklistSaving, setChecklistSaving] = useState(false);

  const hasCodeRepo = Boolean(experiment.code_repo_url?.trim());
  const hasDataPath = Boolean(experiment.data_path?.trim());
  const activationReady = hasCodeRepo && hasDataPath;

  const requiredOpenCount = checklist.filter((i) => i.required && !i.checked).length;
  const checklistComplete =
    checklist.length === 0 ||
    checklist.filter((i) => i.required).every((i) => i.checked);

  // --- 완전 삭제 ---
  const [deleting, setDeleting] = useState(false);

  // --- 수동 블록 modal state ---
  const [blockModalOpen, setBlockModalOpen] = useState(false);
  const [blocks, setBlocks] = useState<ManualBlock[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [blockStart, setBlockStart] = useState("");
  const [blockEnd, setBlockEnd] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [blockAdding, setBlockAdding] = useState(false);

  const status = statusConfig[experiment.status] ?? statusConfig.draft;
  const bookingUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/book/${experiment.id}`;

  async function handleStatusChange(newStatus: "active" | "completed") {
    if (newStatus === "active" && !activationReady) {
      toast(
        "코드 저장소와 데이터 경로를 모두 입력해야 실험을 활성화할 수 있습니다.",
        "error",
      );
      return;
    }

    setUpdating(true);
    const res = await fetch(`/api/experiments/${experiment.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast(j.error ?? "상태 변경 중 오류가 발생했습니다.", "error");
    } else {
      const j = await res.json().catch(() => ({}));
      if (j.notion_synced) {
        toast("상태가 변경되었고 Notion에 기록되었습니다.", "success");
      } else if (newStatus === "active" && j.notion_error) {
        toast("상태는 변경되었으나 Notion 동기화에 실패했습니다.", "error");
      } else {
        toast("상태가 변경되었습니다.", "success");
      }
      router.refresh();
    }
    setUpdating(false);
  }

  async function toggleChecklistItem(index: number, nextChecked: boolean) {
    // Guard against concurrent toggles: if a save is already in flight, drop
    // the extra click. The checkbox's `disabled={checklistSaving}` handles the
    // normal case; this is defence-in-depth against React batching quirks.
    if (checklistSaving) return;

    // Capture the pre-optimistic snapshot BEFORE calling setChecklist, so
    // rollback on error restores exactly the state the user saw, not the
    // closure-captured `checklist` (which may already include later toggles).
    let snapshot: ExperimentChecklistItem[] = [];
    let nextState: ExperimentChecklistItem[] = [];

    setChecklist((prev) => {
      snapshot = prev;
      nextState = prev.map((it, i) =>
        i === index
          ? {
              ...it,
              checked: nextChecked,
              checked_at: nextChecked ? new Date().toISOString() : null,
            }
          : it,
      );
      return nextState;
    });

    setChecklistSaving(true);
    const supabase = createClient();
    const allRequiredChecked = nextState
      .filter((i) => i.required)
      .every((i) => i.checked);
    const { error } = await supabase
      .from("experiments")
      .update({
        pre_experiment_checklist: nextState,
        checklist_completed_at: allRequiredChecked ? new Date().toISOString() : null,
      })
      .eq("id", experiment.id);
    setChecklistSaving(false);
    if (error) {
      toast("체크리스트 저장 중 오류가 발생했습니다.", "error");
      setChecklist(snapshot);
    } else {
      router.refresh();
    }
  }

  function handleCopyLink() {
    navigator.clipboard.writeText(bookingUrl).then(() => {
      toast("예약 링크가 복사되었습니다.", "success");
    });
  }

  async function handleDuplicate() {
    setUpdating(true);
    const res = await fetch(`/api/experiments/${experiment.id}/duplicate`, { method: "POST" });
    setUpdating(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast(j.error ?? "복사에 실패했습니다.", "error");
      return;
    }
    const { experiment: cloned } = await res.json();
    toast("실험을 복사했습니다. 복사본으로 이동합니다.", "success");
    router.push(`/experiments/${cloned.id}`);
    router.refresh();
  }

  // Task 1: 완전 삭제
  async function handleHardDelete() {
    const confirmed = window.confirm(
      "이 실험을 완전히 삭제합니다. 예약, 캘린더 연동 기록, 수동 블록이 모두 함께 삭제됩니다. 계속하시겠습니까?"
    );
    if (!confirmed) return;

    setDeleting(true);
    const res = await fetch(`/api/experiments/${experiment.id}`, { method: "DELETE" });
    setDeleting(false);

    if (res.ok) {
      toast("실험이 삭제되었습니다.", "success");
      router.push("/experiments");
      router.refresh();
      return;
    }

    if (res.status === 409) {
      const j = await res.json().catch(() => ({}));
      toast(j.error ?? "확정된 예약이 있어 삭제할 수 없습니다.", "error");
    } else {
      const j = await res.json().catch(() => ({}));
      toast(j.error ?? "삭제 중 오류가 발생했습니다.", "error");
    }
  }

  // Task 2: 수동 블록 fetch
  const fetchBlocks = useCallback(async () => {
    setBlocksLoading(true);
    try {
      const res = await fetch(`/api/experiments/${experiment.id}/manual-blocks`);
      if (!res.ok) {
        toast("블록 목록을 불러오지 못했습니다.", "error");
        return;
      }
      const data = await res.json();
      setBlocks(data.blocks ?? []);
    } finally {
      setBlocksLoading(false);
    }
  }, [experiment.id, toast]);

  function openBlockModal() {
    setBlockModalOpen(true);
    fetchBlocks();
  }

  async function handleAddBlock() {
    if (!blockStart || !blockEnd) {
      toast("시작 및 종료 시간을 입력해 주세요.", "error");
      return;
    }
    if (new Date(blockStart) >= new Date(blockEnd)) {
      toast("종료 시간은 시작 시간보다 늦어야 합니다.", "error");
      return;
    }

    setBlockAdding(true);
    const body: { block_start: string; block_end: string; reason?: string } = {
      block_start: toIso(blockStart),
      block_end: toIso(blockEnd),
    };
    if (blockReason.trim()) {
      body.reason = blockReason.trim();
    }

    const res = await fetch(`/api/experiments/${experiment.id}/manual-blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBlockAdding(false);

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast(j.error ?? "블록 추가 중 오류가 발생했습니다.", "error");
      return;
    }

    toast("수동 블록이 추가되었습니다.", "success");
    setBlockStart("");
    setBlockEnd("");
    setBlockReason("");
    fetchBlocks();
  }

  async function handleDeleteBlock(blockId: string) {
    const confirmed = window.confirm("이 블록을 삭제하시겠습니까?");
    if (!confirmed) return;

    const res = await fetch(
      `/api/experiments/${experiment.id}/manual-blocks/${blockId}`,
      { method: "DELETE" }
    );

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast(j.error ?? "블록 삭제 중 오류가 발생했습니다.", "error");
      return;
    }

    toast("블록이 삭제되었습니다.", "success");
    fetchBlocks();
  }

  if (editing) {
    return (
      <div>
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-foreground">실험 수정</h1>
        </div>
        <ExperimentForm
          experiment={experiment}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4">
        <Link
          href="/experiments"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground"
        >
          ← 실험 목록으로
        </Link>
      </div>
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-foreground">{experiment.title}</h1>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            수정
          </Button>
          <Button variant="secondary" size="sm" onClick={handleCopyLink}>
            예약 링크 복사
          </Button>
          <Button variant="secondary" size="sm" onClick={openBlockModal}>
            수동 블록 관리
          </Button>
          {experiment.status === "draft" && (
            <Button
              size="sm"
              disabled={updating || !activationReady}
              title={
                activationReady
                  ? undefined
                  : "코드 저장소와 데이터 경로를 입력해야 활성화할 수 있습니다."
              }
              onClick={() => handleStatusChange("active")}
            >
              활성화
            </Button>
          )}
          {experiment.status === "active" && (
            <Button
              variant="secondary"
              size="sm"
              disabled={updating}
              onClick={() => handleStatusChange("completed")}
            >
              완료 처리
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            disabled={deleting}
            onClick={handleHardDelete}
          >
            완전 삭제
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">실험 정보</h2>
            <dl className="grid gap-3 text-sm">
              {experiment.description && (
                <div>
                  <dt className="text-muted">설명</dt>
                  <dd className="mt-0.5 text-foreground">{experiment.description}</dd>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-muted">시작일</dt>
                  <dd className="mt-0.5 text-foreground">
                    {format(new Date(experiment.start_date), "yyyy.MM.dd")}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">종료일</dt>
                  <dd className="mt-0.5 text-foreground">
                    {format(new Date(experiment.end_date), "yyyy.MM.dd")}
                  </dd>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-muted">시작 시간</dt>
                  <dd className="mt-0.5 text-foreground">{experiment.daily_start_time}</dd>
                </div>
                <div>
                  <dt className="text-muted">종료 시간</dt>
                  <dd className="mt-0.5 text-foreground">{experiment.daily_end_time}</dd>
                </div>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">세션 설정</h2>
            <dl className="grid gap-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-muted">세션 시간</dt>
                  <dd className="mt-0.5 text-foreground">{experiment.session_duration_minutes}분</dd>
                </div>
                <div>
                  <dt className="text-muted">휴식 시간</dt>
                  <dd className="mt-0.5 text-foreground">{experiment.break_between_slots_minutes}분</dd>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-muted">세션 유형</dt>
                  <dd className="mt-0.5 text-foreground">
                    {experiment.session_type === "single" ? "단일 세션" : `다중 세션 (${experiment.required_sessions}회)`}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">슬롯당 최대 인원</dt>
                  <dd className="mt-0.5 text-foreground">{experiment.max_participants_per_slot}명</dd>
                </div>
              </div>
              <div>
                <dt className="text-muted">참여비</dt>
                <dd className="mt-0.5 text-foreground">
                  {experiment.participation_fee > 0
                    ? `${experiment.participation_fee.toLocaleString()}원`
                    : "없음"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Research metadata summary (migration 00022) */}
        <Card className="lg:col-span-2">
          <CardContent>
            <h2 className="text-lg font-semibold text-foreground mb-4">연구 메타데이터</h2>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted">분석 코드 저장소</dt>
                <dd className="mt-0.5 break-all text-foreground">
                  {experiment.code_repo_url ? (
                    /^https?:\/\//.test(experiment.code_repo_url) ? (
                      <a
                        href={experiment.code_repo_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {experiment.code_repo_url}
                      </a>
                    ) : (
                      <code className="rounded bg-card px-1.5 py-0.5 text-xs">
                        {experiment.code_repo_url}
                      </code>
                    )
                  ) : (
                    <span className="text-danger">미지정 — 활성화 불가</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted">원본 데이터 경로</dt>
                <dd className="mt-0.5 break-all text-foreground">
                  {experiment.data_path ? (
                    <code className="rounded bg-card px-1.5 py-0.5 text-xs">
                      {experiment.data_path}
                    </code>
                  ) : (
                    <span className="text-danger">미지정 — 활성화 불가</span>
                  )}
                </dd>
              </div>
              {experiment.parameter_schema && experiment.parameter_schema.length > 0 && (
                <div className="sm:col-span-2">
                  <dt className="text-muted">파라미터 스키마</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {experiment.parameter_schema.map((p, i) => (
                      <span
                        key={i}
                        className="rounded-full border border-border bg-white px-2 py-0.5 text-xs text-foreground"
                      >
                        {p.key}
                        <span className="ml-1 text-muted">({p.type})</span>
                      </span>
                    ))}
                  </dd>
                </div>
              )}
              {experiment.notion_experiment_page_id && (
                <div className="sm:col-span-2">
                  <dt className="text-muted">Notion 페이지</dt>
                  <dd className="mt-0.5 text-xs text-muted">
                    <code>{experiment.notion_experiment_page_id}</code>
                  </dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        {/* Pre-experiment checklist — booking gate */}
        <Card className="lg:col-span-2">
          <CardContent>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground">사전 체크리스트</h2>
                <p className="mt-1 text-sm text-muted">
                  {checklist.length === 0
                    ? "등록된 점검 항목이 없습니다. 양식에서 추가할 수 있습니다."
                    : checklistComplete
                      ? "모든 필수 항목이 완료되었습니다. 참여자가 예약 페이지에 접근할 수 있습니다."
                      : `참여자 예약 차단 중 — 필수 항목 ${requiredOpenCount}개 남음.`}
                </p>
              </div>
              <Badge
                variant={
                  checklist.length === 0
                    ? "default"
                    : checklistComplete
                      ? "success"
                      : "danger"
                }
              >
                {checklist.length === 0
                  ? "해당 없음"
                  : checklistComplete
                    ? "완료"
                    : "미완료"}
              </Badge>
            </div>
            {checklist.length > 0 && (
              <ul className="flex flex-col gap-2">
                {checklist.map((item, index) => (
                  <li
                    key={index}
                    className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-primary"
                      checked={!!item.checked}
                      disabled={checklistSaving}
                      onChange={(e) => toggleChecklistItem(index, e.target.checked)}
                    />
                    <div className="flex-1">
                      <span
                        className={`text-foreground ${
                          item.checked ? "line-through text-muted" : ""
                        }`}
                      >
                        {item.item}
                      </span>
                      {item.required && (
                        <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">
                          필수
                        </span>
                      )}
                      {item.checked_at && (
                        <span className="ml-2 text-xs text-muted">
                          · {formatDateKR(item.checked_at)} {formatTimeKR(item.checked_at)}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-foreground">예약 현황</h2>
                <p className="mt-1 text-sm text-muted">확정 예약 {bookingCount}건</p>
              </div>
              <Link href={`/experiments/${experiment.id}/bookings`}>
                <Button variant="secondary" size="sm">
                  예약 목록 보기
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Secondary actions (bottom-left) */}
      <div className="mt-6 flex justify-start">
        <Button
          variant="secondary"
          size="sm"
          disabled={updating}
          onClick={handleDuplicate}
        >
          실험 복사
        </Button>
      </div>

      {/* 수동 블록 관리 Modal */}
      <Modal
        open={blockModalOpen}
        onClose={() => setBlockModalOpen(false)}
        title={`수동 시간 블록 · ${experiment.title}`}
      >
        <div className="flex flex-col gap-5">
          <p className="text-sm text-muted">
            실험 기간 중 예약받지 않을 시간대를 수동으로 지정합니다. 이 블록은 참여자의 주간
            시간표에서 마감으로 표시됩니다.
          </p>

          {/* Existing blocks */}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-foreground">등록된 블록</h3>
            {blocksLoading ? (
              <p className="text-sm text-muted">불러오는 중...</p>
            ) : blocks.length === 0 ? (
              <p className="text-sm text-muted">등록된 수동 블록이 없습니다.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {blocks.map((block) => (
                  <li
                    key={block.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-sm"
                  >
                    <span className="text-foreground">
                      {formatDateKR(block.block_start)}{" "}
                      {formatTimeKR(block.block_start)} -{" "}
                      {formatTimeKR(block.block_end)}
                    </span>
                    <span className="mx-3 flex-1 truncate text-muted">
                      {block.reason ?? "(사유 없음)"}
                    </span>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleDeleteBlock(block.id)}
                    >
                      삭제
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add new block form */}
          <div className="border-t border-border pt-4">
            <h3 className="mb-3 text-sm font-semibold text-foreground">새 블록 추가</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="시작 일시 (KST)"
                id="block-start"
                type="datetime-local"
                value={blockStart}
                onChange={(e) => setBlockStart(e.target.value)}
              />
              <Input
                label="종료 일시 (KST)"
                id="block-end"
                type="datetime-local"
                value={blockEnd}
                onChange={(e) => setBlockEnd(e.target.value)}
              />
              <Input
                label="사유 (선택, 최대 200자)"
                id="block-reason"
                type="text"
                placeholder="예: 연구진 회의"
                maxLength={200}
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
              />
              <Button
                size="sm"
                disabled={blockAdding}
                onClick={handleAddBlock}
              >
                {blockAdding ? "추가 중..." : "추가"}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
