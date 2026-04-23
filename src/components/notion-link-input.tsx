"use client";

import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

// Single-field setter for a Notion page-id link (member or project).
// Accepts paste of full Notion page URL or bare 32-char hex; the server
// normalises.
//
// Props:
//   label        — "CSNL Members Notion 페이지" etc.
//   currentId    — existing value (dashed UUID) or null
//   endpoint     — PATCH target URL, e.g. /api/users/abc/... or
//                  /api/experiments/xyz
//   field        — field name in the PATCH body
//                  ('notion_member_page_id' | 'notion_project_page_id')
//   helperText   — small explanatory text
//   externalUrl  — when set, surface a "Notion에서 열기" link
//                  (we build it from currentId if absent)

interface Props {
  label: string;
  currentId: string | null;
  endpoint: string;
  field: "notion_member_page_id" | "notion_project_page_id";
  helperText?: string;
}

export function NotionLinkInput({
  label,
  currentId,
  endpoint,
  field,
  helperText,
}: Props) {
  const { toast } = useToast();
  const [value, setValue] = useState<string>(currentId ?? "");
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState<string | null>(currentId);

  const externalUrl = current
    ? `https://www.notion.so/${current.replace(/-/g, "")}`
    : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    const body: Record<string, string | null> = {};
    // Empty string means "clear the link". The API route interprets "".
    body[field] = value.trim() === "" ? "" : value.trim();
    try {
      const res = await fetch(endpoint, {
        method: endpoint.includes("/api/users/") ? "PATCH" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast(j.error ?? "저장 실패", "error");
        return;
      }
      const j = await res.json().catch(() => ({}));
      const newVal =
        (j.profile?.[field] ?? j.experiment?.[field] ?? null) as string | null;
      setCurrent(newVal);
      setValue(newVal ?? "");
      toast(newVal ? "Notion 링크가 저장되었습니다." : "링크가 해제되었습니다.", "success");
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "저장 중 오류가 발생했습니다.",
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-border bg-white p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-primary hover:text-primary-hover"
          >
            Notion 에서 열기 →
          </a>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={`${field}-input`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Notion 페이지 URL 붙여넣기 또는 32자 hex ID"
          className="flex-1"
        />
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "저장 중…" : "저장"}
        </Button>
        {current && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={saving}
            onClick={() => {
              setValue("");
              handleSubmit({ preventDefault: () => {} } as FormEvent);
            }}
          >
            해제
          </Button>
        )}
      </div>
      {helperText && (
        <p className="mt-1.5 text-xs text-muted">{helperText}</p>
      )}
      {current && !externalUrl && (
        <p className="mt-1 text-[11px] text-muted font-mono break-all">
          {current}
        </p>
      )}
    </form>
  );
}
