"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";

export function LabSettingsForm({
  labCode,
  labName,
  initialIrbBaseUrl,
}: {
  labCode: string;
  labName: string;
  initialIrbBaseUrl: string;
}) {
  const { toast } = useToast();
  const [irbBaseUrl, setIrbBaseUrl] = useState(initialIrbBaseUrl);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/lab/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ irb_base_url: irbBaseUrl.trim() || null }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(j?.error ?? "저장 실패", "error");
        return;
      }
      toast("저장 완료", "success");
    } catch {
      toast("네트워크 오류가 발생했습니다", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted">
          랩 코드:{" "}
          <span className="font-mono text-foreground">{labCode}</span> ·{" "}
          {labName}
        </p>

        <div>
          <Input
            id="irb_base_url"
            label="IRB 문서 URL (관리자 공용)"
            type="url"
            placeholder="https://drive.google.com/drive/folders/…"
            value={irbBaseUrl}
            onChange={(e) => setIrbBaseUrl(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">
            연구원이 <code>/metadata-fill</code> 에서 카드별로{" "}
            <b>&quot;관리자 등록 IRB 사용&quot;</b> 버튼을 누르면 이 주소가
            그 실험의 IRB 문서 URL 칸에 한 번에 채워집니다. 비워두면 그
            버튼은 표시되지 않습니다.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? "저장 중…" : "저장"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
