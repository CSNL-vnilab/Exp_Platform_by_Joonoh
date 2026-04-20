"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";

interface PrecautionQuestion {
  question: string;
  required_answer: boolean;
}

interface PrecautionCheckProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  precautions: PrecautionQuestion[];
  irbDocumentUrl?: string | null;
}

export function PrecautionCheck({
  open,
  onClose,
  onConfirm,
  precautions,
  irbDocumentUrl,
}: PrecautionCheckProps) {
  const [answers, setAnswers] = useState<Record<number, boolean | null>>(
    () => Object.fromEntries(precautions.map((_, i) => [i, null]))
  );

  const allAnswered = precautions.every((_, i) => answers[i] !== null);
  const allCorrect = precautions.every(
    (p, i) => answers[i] === p.required_answer
  );
  const hasWrongAnswer = precautions.some(
    (p, i) => answers[i] !== null && answers[i] !== p.required_answer
  );

  const handleAnswer = (index: number, value: boolean) => {
    setAnswers((prev) => ({ ...prev, [index]: value }));
  };

  const handleConfirm = () => {
    if (allAnswered && allCorrect) {
      onConfirm();
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="실험 참여 전 확인사항">
      <div className="space-y-6">
        {irbDocumentUrl && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="flex items-start gap-3">
              <svg className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-blue-800">IRB 승인 문서</p>
                <p className="mt-1 text-xs text-blue-600">
                  실험 참여 전 아래 IRB 승인 문서를 반드시 확인해주세요.
                </p>
                <a
                  href={irbDocumentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  IRB 문서 보기
                </a>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-4">
          <p className="text-sm font-medium text-foreground">
            아래 항목을 확인하고 응답해주세요.
          </p>
          {precautions.map((item, index) => {
            const isWrong = answers[index] !== null && answers[index] !== item.required_answer;
            return (
              <div
                key={index}
                className={`rounded-lg border p-4 ${
                  isWrong ? "border-red-300 bg-red-50" : "border-border bg-card"
                }`}
              >
                <p className="mb-3 text-sm text-foreground">{item.question}</p>
                <div className="flex gap-4">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name={`precaution-${index}`}
                      checked={answers[index] === true}
                      onChange={() => handleAnswer(index, true)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span className="text-sm text-foreground">예</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name={`precaution-${index}`}
                      checked={answers[index] === false}
                      onChange={() => handleAnswer(index, false)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span className="text-sm text-foreground">아니오</span>
                  </label>
                </div>
                {isWrong && (
                  <p className="mt-2 text-xs text-red-600">
                    해당 조건을 충족하지 않으면 실험 참여가 불가합니다.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {hasWrongAnswer && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-center">
            <p className="text-sm text-red-700">
              참여 조건을 충족하지 않아 실험에 참여하실 수 없습니다.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-3 border-t border-border pt-4">
          <Button variant="secondary" onClick={onClose}>
            취소
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!allAnswered || !allCorrect}
          >
            확인 및 계속하기
          </Button>
        </div>
      </div>
    </Modal>
  );
}
