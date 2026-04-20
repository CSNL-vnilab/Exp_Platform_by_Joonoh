"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { ExperimentLocation } from "@/types/database";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LocationFormState {
  name: string;
  addressLines: string[];
  naverUrl: string;
}

const EMPTY_FORM: LocationFormState = {
  name: "",
  addressLines: [""],
  naverUrl: "",
};

// ---------------------------------------------------------------------------
// Add / Edit modal
// ---------------------------------------------------------------------------

interface LocationModalProps {
  open: boolean;
  onClose: () => void;
  initial?: ExperimentLocation | null;
  onSaved: () => void;
}

function LocationModal({ open, onClose, initial, onSaved }: LocationModalProps) {
  const { toast } = useToast();
  const isEdit = !!initial;

  const [form, setForm] = useState<LocationFormState>(() =>
    initial
      ? {
          name: initial.name,
          addressLines: initial.address_lines.length > 0 ? initial.address_lines : [""],
          naverUrl: initial.naver_url ?? "",
        }
      : EMPTY_FORM
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Reset state whenever the modal opens / closes or target changes
  function handleClose() {
    setForm(
      initial
        ? {
            name: initial.name,
            addressLines: initial.address_lines.length > 0 ? initial.address_lines : [""],
            naverUrl: initial.naver_url ?? "",
          }
        : EMPTY_FORM
    );
    setError("");
    onClose();
  }

  // Address line helpers
  function setLine(idx: number, value: string) {
    setForm((prev) => {
      const next = [...prev.addressLines];
      next[idx] = value;
      return { ...prev, addressLines: next };
    });
  }

  function addLine() {
    if (form.addressLines.length >= 5) return;
    setForm((prev) => ({ ...prev, addressLines: [...prev.addressLines, ""] }));
  }

  function removeLine(idx: number) {
    if (form.addressLines.length <= 1) return;
    setForm((prev) => {
      const next = prev.addressLines.filter((_, i) => i !== idx);
      return { ...prev, addressLines: next };
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    const nameTrimmed = form.name.trim();
    if (!nameTrimmed) return setError("장소 이름을 입력해 주세요.");
    if (nameTrimmed.length > 80) return setError("장소 이름은 80자 이하여야 합니다.");

    const addressLines = form.addressLines
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (addressLines.length === 0) return setError("주소를 최소 1줄 입력해 주세요.");
    if (addressLines.some((l) => l.length > 200))
      return setError("주소 각 줄은 200자 이하여야 합니다.");

    const naverUrl = form.naverUrl.trim() || null;
    if (naverUrl) {
      try {
        new URL(naverUrl);
      } catch {
        return setError("올바른 URL 형식이 아닙니다. (예: https://naver.me/...)");
      }
    }

    setLoading(true);

    const url = isEdit ? `/api/locations/${initial!.id}` : "/api/locations";
    const method = isEdit ? "PATCH" : "POST";
    const body: Record<string, unknown> = { name: nameTrimmed, address_lines: addressLines };
    if (naverUrl !== null) body.naver_url = naverUrl;
    else if (isEdit) body.naver_url = null;

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setLoading(false);

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? (isEdit ? "수정에 실패했습니다." : "추가에 실패했습니다."));
      return;
    }

    toast(isEdit ? "장소가 수정되었습니다" : "장소가 추가되었습니다", "success");
    onSaved();
    handleClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title={isEdit ? "장소 수정" : "장소 추가"}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input
          id="loc-name"
          label="장소 이름"
          type="text"
          placeholder="예: 본관 305호 행동실험실"
          value={form.name}
          onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
          required
          maxLength={80}
          autoComplete="off"
        />

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-foreground">
            주소 <span className="text-muted font-normal">(최소 1줄, 최대 5줄)</span>
          </label>
          <div className="flex flex-col gap-2">
            {form.addressLines.map((line, idx) => (
              <div key={idx} className="flex gap-2">
                <input
                  type="text"
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  placeholder={`주소 ${idx + 1}번째 줄`}
                  value={line}
                  onChange={(e) => setLine(idx, e.target.value)}
                  maxLength={200}
                  autoComplete="off"
                />
                {form.addressLines.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeLine(idx)}
                    className="flex-shrink-0 rounded-lg px-2 py-1 text-muted hover:bg-gray-100 hover:text-danger text-sm"
                    aria-label="줄 제거"
                  >
                    &times;
                  </button>
                )}
              </div>
            ))}
          </div>
          {form.addressLines.length < 5 && (
            <button
              type="button"
              onClick={addLine}
              className="mt-1 w-fit text-xs text-primary hover:underline"
            >
              + 줄 추가
            </button>
          )}
        </div>

        <Input
          id="loc-naver-url"
          label="네이버 지도 URL (선택)"
          type="url"
          placeholder="https://naver.me/..."
          value={form.naverUrl}
          onChange={(e) => setForm((prev) => ({ ...prev, naverUrl: e.target.value }))}
          autoComplete="off"
        />

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 mt-2">
          <Button type="button" variant="secondary" onClick={handleClose} disabled={loading}>
            취소
          </Button>
          <Button type="submit" disabled={loading}>
            {loading ? (isEdit ? "수정 중..." : "추가 중...") : isEdit ? "저장" : "추가"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Add location button (standalone, used from page header)
// ---------------------------------------------------------------------------

export function AddLocationButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  function handleSaved() {
    startTransition(() => router.refresh());
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>+ 장소 추가</Button>
      <LocationModal
        open={open}
        onClose={() => setOpen(false)}
        onSaved={handleSaved}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Main manager (card list + edit/delete)
// ---------------------------------------------------------------------------

interface LocationsManagerProps {
  initialLocations: ExperimentLocation[];
}

export function LocationsManager({ initialLocations }: LocationsManagerProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [, startTransition] = useTransition();
  const [editTarget, setEditTarget] = useState<ExperimentLocation | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function handleEditSaved() {
    startTransition(() => router.refresh());
  }

  async function handleDelete(loc: ExperimentLocation) {
    const confirmed = window.confirm(
      `"${loc.name}" 장소를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`
    );
    if (!confirmed) return;

    setDeletingId(loc.id);
    const res = await fetch(`/api/locations/${loc.id}`, { method: "DELETE" });
    setDeletingId(null);

    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: "삭제에 실패했습니다." }));
      toast(j.error ?? "삭제에 실패했습니다.", "error");
      return;
    }

    toast("장소가 삭제되었습니다", "success");
    startTransition(() => router.refresh());
  }

  if (initialLocations.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted text-center py-4">
          등록된 장소가 없습니다. 오른쪽 상단의 &quot;장소 추가&quot; 버튼으로 추가해 보세요.
        </p>
      </Card>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {initialLocations.map((loc) => {
          const busy = deletingId === loc.id;
          return (
            <Card key={loc.id} className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-foreground truncate">{loc.name}</h3>
                <div className="mt-1 flex flex-col gap-0.5">
                  {loc.address_lines.map((line, i) => (
                    <p key={i} className="text-sm text-muted">
                      {line}
                    </p>
                  ))}
                </div>
                {loc.naver_url && (
                  <a
                    href={loc.naver_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <MapPinIcon className="h-3.5 w-3.5" />
                    네이버 지도에서 보기
                  </a>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setEditTarget(loc);
                    setEditOpen(true);
                  }}
                >
                  수정
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => handleDelete(loc)}
                >
                  {busy ? "삭제 중..." : "삭제"}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <LocationModal
        open={editOpen}
        onClose={() => {
          setEditOpen(false);
          setEditTarget(null);
        }}
        initial={editTarget}
        onSaved={handleEditSaved}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------

function MapPinIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
      />
    </svg>
  );
}
