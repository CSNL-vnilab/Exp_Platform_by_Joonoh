"use client";

import { ExperimentForm } from "@/components/experiment-form";

export default function NewExperimentPage() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">새 실험 만들기</h1>
        <p className="mt-1 text-sm text-muted">실험 정보를 입력하고 예약 페이지를 생성하세요.</p>
      </div>
      <ExperimentForm />
    </div>
  );
}
