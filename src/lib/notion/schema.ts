// Canonical Notion database schema definition. Single source of truth
// consumed by:
//   - src/lib/notion/client.ts — when writing pages, property names MUST
//     match these literals exactly or the PATCH 400s.
//   - /api/cron/notion-health — diffs the live database against this
//     spec and records drift.
//   - scripts/notion-setup.mjs — idempotent schema fixer (reads and
//     re-declares the same list).
//
// Any time a property is added to client.ts, it must be added here too
// and vice versa — the health cron is the enforcement mechanism.

export type NotionPropertySpec =
  | { name: string; type: "rich_text" }
  | { name: string; type: "number" }
  | { name: string; type: "date" }
  | { name: string; type: "checkbox" }
  | { name: string; type: "select"; options: string[] }
  | { name: string; type: "title" };

export const NOTION_TITLE_COLUMN = "실험명";

// Non-title columns, in the desired display order for the default view.
// Researcher convenience: 실험명 → 실험날짜 → 시간 → 프로젝트 → 버전넘버 →
// 피험자 ID → 회차 → (rest free). New columns added via notion-setup.mjs
// land in this order; EXISTING columns keep their current UI order and
// need a one-time drag in the Notion UI (API doesn't support re-ordering
// existing database-level properties; view-level reorder is possible
// via /v1/views but requires creating a named view). See
// docs/notion-db-template.md §9.
export const NOTION_REQUIRED_PROPERTIES: NotionPropertySpec[] = [
  { name: "실험명", type: "title" },
  { name: "실험날짜", type: "date" },
  { name: "시간", type: "rich_text" },
  { name: "프로젝트", type: "rich_text" },
  { name: "버전넘버", type: "rich_text" },
  { name: "피험자 ID", type: "rich_text" },
  { name: "회차", type: "number" },
  { name: "참여자", type: "rich_text" },
  // 실험자: researcher running the session. Separated from 참여자 so
  // the Notion column reflects session ownership clearly and so we can
  // later upgrade to a People/Relation link (CSNL members DB).
  { name: "실험자", type: "rich_text" },
  { name: "공개 ID", type: "rich_text" },
  {
    name: "상태",
    type: "select",
    options: ["확정", "취소", "완료", "no_show"],
  },
  { name: "Pre-Survey 완료", type: "checkbox" },
  { name: "Pre-Survey 정보", type: "rich_text" },
  { name: "Post-Survey 완료", type: "checkbox" },
  { name: "Post-Survey 정보", type: "rich_text" },
  { name: "특이사항", type: "rich_text" },
  { name: "Code Directory", type: "rich_text" },
  { name: "Data Directory", type: "rich_text" },
  { name: "Parameter", type: "rich_text" },
  { name: "Notes", type: "rich_text" },
];

export interface NotionLivePropertyType {
  type: string;
  // Select type exposes its options — we care about these because if
  // the set of select options drifts we want to surface it.
  selectOptions?: string[];
}

export interface NotionDriftItem {
  name: string;
  kind: "missing" | "type_mismatch" | "select_options_changed" | "unexpected";
  expected?: string;
  actual?: string;
  details?: string;
}

export interface NotionDriftReport {
  healthy: boolean;
  schema_hash: string;
  items: NotionDriftItem[];
  checked_at: string;
  title_column_name: string | null;
}

// Canonical hash of the expected schema. Stored with every health check so
// we can detect "my spec changed but nobody redeployed" separately from
// "someone edited the DB in the UI".
export function computeExpectedSchemaHash(): string {
  // Lexicographic-stable JSON of the spec. We don't use a real hash (no
  // crypto) because we want the hash to be human-inspectable in logs.
  const canonical = NOTION_REQUIRED_PROPERTIES.map((p) => {
    if (p.type === "select") {
      return `${p.name}:select[${[...p.options].sort().join("|")}]`;
    }
    return `${p.name}:${p.type}`;
  })
    .sort()
    .join(";");
  // djb2 hash → base36
  let h = 5381;
  for (let i = 0; i < canonical.length; i += 1) {
    h = ((h << 5) + h + canonical.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

// Compares a fetched Notion schema against NOTION_REQUIRED_PROPERTIES.
// Returns items describing every deviation; `healthy` is true iff items
// is empty.
export function diffNotionSchema(
  live: Record<string, NotionLivePropertyType>,
  titleColumnName: string | null,
): NotionDriftReport {
  const items: NotionDriftItem[] = [];

  if (titleColumnName !== NOTION_TITLE_COLUMN) {
    items.push({
      name: NOTION_TITLE_COLUMN,
      kind: titleColumnName == null ? "missing" : "type_mismatch",
      expected: "title",
      actual: titleColumnName ?? "(no title column)",
      details:
        titleColumnName == null
          ? "Notion DB has no title column"
          : `title column is named '${titleColumnName}', expected '${NOTION_TITLE_COLUMN}'`,
    });
  }

  for (const spec of NOTION_REQUIRED_PROPERTIES) {
    if (spec.type === "title") continue; // handled above
    const actual = live[spec.name];
    if (!actual) {
      items.push({
        name: spec.name,
        kind: "missing",
        expected: spec.type,
      });
      continue;
    }
    if (actual.type !== spec.type) {
      items.push({
        name: spec.name,
        kind: "type_mismatch",
        expected: spec.type,
        actual: actual.type,
      });
      continue;
    }
    if (spec.type === "select") {
      const expectedOpts = new Set(spec.options);
      const actualOpts = new Set(actual.selectOptions ?? []);
      const missing = [...expectedOpts].filter((o) => !actualOpts.has(o));
      const extra = [...actualOpts].filter((o) => !expectedOpts.has(o));
      if (missing.length > 0 || extra.length > 0) {
        items.push({
          name: spec.name,
          kind: "select_options_changed",
          expected: [...expectedOpts].sort().join("|"),
          actual: [...actualOpts].sort().join("|"),
          details:
            (missing.length ? `missing options: ${missing.join(", ")}` : "") +
            (missing.length && extra.length ? "; " : "") +
            (extra.length ? `extra options: ${extra.join(", ")}` : ""),
        });
      }
    }
  }

  // Properties on the Notion DB that our spec doesn't cover are tracked
  // but not considered a drift failure — researchers may add custom cols.
  const expected = new Set(NOTION_REQUIRED_PROPERTIES.map((p) => p.name));
  for (const name of Object.keys(live)) {
    if (!expected.has(name)) {
      items.push({
        name,
        kind: "unexpected",
        actual: live[name].type,
        details:
          "Property exists on Notion DB but not in the canonical spec. OK if intentional.",
      });
    }
  }

  // `unexpected` doesn't fail health; everything else does.
  const realDrift = items.filter((i) => i.kind !== "unexpected");
  return {
    healthy: realDrift.length === 0,
    schema_hash: computeExpectedSchemaHash(),
    items,
    checked_at: new Date().toISOString(),
    title_column_name: titleColumnName,
  };
}
