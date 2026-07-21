"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { ExperimentLocation } from "@/types/database";

// Shared 장소 추가/수정 modal. Used by both the /locations admin page
// (locations-manager.tsx) and the experiment-create wizard's step-1 "실험
// 장소" card, so a researcher can add an address inline WITHOUT navigating
// away and losing the whole wizard (the original bug). onSaved receives the
// created/updated location so the wizard can append + auto-select it.

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

function initialForm(initial?: ExperimentLocation | null): LocationFormState {
  return initial
    ? {
        name: initial.name,
        addressLines:
          initial.address_lines.length > 0 ? initial.address_lines : [""],
        naverUrl: initial.naver_url ?? "",
      }
    : EMPTY_FORM;
}

export interface LocationModalProps {
  open: boolean;
  onClose: () => void;
  initial?: ExperimentLocation | null;
  onSaved: (location: ExperimentLocation) => void;
}

export function LocationModal({
  open,
  onClose,
  initial,
  onSaved,
}: LocationModalProps) {
  const { toast } = useToast();
  const isEdit = !!initial;

  const [form, setForm] = useState<LocationFormState>(() =>
    initialForm(initial),
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function handleClose() {
    setForm(initialForm(initial));
    setError("");
    onClose();
  }

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
      let parsed: URL | null = null;
      try {
        parsed = new URL(naverUrl);
      } catch {
        return setError("올바른 URL 형식이 아닙니다. (예: https://naver.me/...)");
      }
      // http/https only — mirrors the server + DB check (stored-XSS guard).
      if (!/^https?:$/i.test(parsed.protocol)) {
        return setError("http 또는 https 주소만 사용할 수 있습니다.");
      }
    }

    setLoading(true);

    const url = isEdit ? `/api/locations/${initial!.id}` : "/api/locations";
    const method = isEdit ? "PATCH" : "POST";
    const body: Record<string, unknown> = {
      name: nameTrimmed,
      address_lines: addressLines,
    };
    if (naverUrl !== null) body.naver_url = naverUrl;
    else if (isEdit) body.naver_url = null;

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setLoading(false);

    const json = (await res.json().catch(() => ({}))) as {
      location?: ExperimentLocation;
      error?: string;
    };
    if (!res.ok || !json.location) {
      setError(
        json.error ?? (isEdit ? "수정에 실패했습니다." : "추가에 실패했습니다."),
      );
      return;
    }

    toast(isEdit ? "장소가 수정되었습니다" : "장소가 추가되었습니다", "success");
    onSaved(json.location);
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
                    className="flex-shrink-0 rounded-lg px-2 py-1 text-muted hover:bg-neutral-100 hover:text-danger text-sm"
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
          <Button type="submit" loading={loading}>
            {isEdit ? "저장" : "추가"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
