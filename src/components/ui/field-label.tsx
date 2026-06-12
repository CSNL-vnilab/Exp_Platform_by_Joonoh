// Field-requirement label component. Single source of truth for how we
// surface "필수 / 활성화-필수 / 권장 / 선택" in the experiment form.
// Maps to docs/experiment-field-requirements.md.

import type { ReactNode } from "react";

export type FieldRequirement =
  | "required"
  | "required_for_activation"
  | "recommended"
  | "optional";

const SUFFIX: Record<FieldRequirement, { text: string; cls: string } | null> = {
  required: { text: "*", cls: "text-danger" },
  required_for_activation: {
    text: "* (활성화 전 필수)",
    cls: "ml-1 rounded bg-warning-50 px-1.5 py-0.5 text-2xs font-medium text-warning-800 border border-warning-200",
  },
  recommended: {
    text: "권장",
    cls: "ml-1 rounded bg-info-50 px-1.5 py-0.5 text-2xs font-medium text-info-800 border border-info-200",
  },
  optional: { text: "(선택)", cls: "ml-1 text-xs text-muted font-normal" },
};

interface Props {
  htmlFor?: string;
  children: ReactNode;
  requirement: FieldRequirement;
  // Optional inline hint rendered below the label.
  help?: string;
}

export function FieldLabel({ htmlFor, children, requirement, help }: Props) {
  const suffix = SUFFIX[requirement];
  return (
    <div className="flex flex-col gap-0.5">
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-foreground flex items-center flex-wrap gap-1"
      >
        <span>{children}</span>
        {suffix &&
          (requirement === "required" ? (
            <span className={suffix.cls} aria-label="필수">
              {suffix.text}
            </span>
          ) : (
            <span className={suffix.cls}>{suffix.text}</span>
          ))}
      </label>
      {help && <span className="text-xs text-neutral-600">{help}</span>}
    </div>
  );
}
