"use client";

import { useState } from "react";
import { ExperimentForm } from "@/components/experiment-form";
import { ExperimentFormCompleteness } from "@/components/experiment-form-completeness";
import type { Experiment } from "@/types/database";

export default function NewExperimentPage() {
  // Live mirror of the form's state, populated via ExperimentForm's
  // onDraftChange callback. The sidebar renders from this.
  const [draft, setDraft] = useState<Partial<Experiment>>({});

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">새 실험 만들기</h1>
        <p className="mt-1 text-sm text-muted">
          실험 정보를 입력하고 예약 페이지를 생성하세요. 오른쪽 사이드바에서
          필수·권장 항목 입력 현황을 실시간으로 확인할 수 있습니다.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0">
          <ExperimentForm onDraftChange={setDraft} />
        </div>
        <div className="order-first lg:order-last">
          <div className="lg:sticky lg:top-6">
            <ExperimentFormCompleteness draft={draft} />
          </div>
        </div>
      </div>
    </div>
  );
}
