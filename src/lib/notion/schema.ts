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
  | { name: string; type: "title" }
  | { name: string; type: "relation"; relatedDbId: string };

// Canonical Korean column names indexed by semantic id. Single owner —
// `client.ts`, `health` cron, and `notion-setup.mjs` all read from here
// so a column rename in one place automatically updates the others.
// Added iter 27 (2026-05-30) to replace the 25+ inline `"실험명"`
// string literals that were scattered across the file.
export const NOTION_COLUMN = {
  TITLE: "실험명",
  DATE: "실험날짜",
  TIME: "시간",
  PROJECT: "프로젝트",
  PROTOCOL_VERSION: "버전넘버",
  SUBJECT_ID: "피험자 ID",
  SESSION_NUMBER: "회차",
  PARTICIPANT: "참여자",
  RESEARCHER: "실험자",
  PROJECT_RELATION: "프로젝트 (관련)",
  PUBLIC_ID: "공개 ID",
  STATUS: "상태",
  PRE_SURVEY_DONE: "Pre-Survey 완료",
  PRE_SURVEY_INFO: "Pre-Survey 정보",
  POST_SURVEY_DONE: "Post-Survey 완료",
  POST_SURVEY_INFO: "Post-Survey 정보",
  NOTABLE_OBSERVATIONS: "특이사항",
  CODE_DIRECTORY: "Code Directory",
  DATA_DIRECTORY: "Data Directory",
  PARAMETER: "Parameter",
  NOTES: "Notes",
} as const;

export type NotionColumnName =
  (typeof NOTION_COLUMN)[keyof typeof NOTION_COLUMN];

/** @deprecated since iter 27 — prefer `NOTION_COLUMN.TITLE`. */
export const NOTION_TITLE_COLUMN = NOTION_COLUMN.TITLE;

// Non-title columns, in the desired display order for the default view.
// Researcher convenience: 실험명 → 실험날짜 → 시간 → 프로젝트 → 버전넘버 →
// 피험자 ID → 회차 → (rest free). New columns added via notion-setup.mjs
// land in this order; EXISTING columns keep their current UI order and
// need a one-time drag in the Notion UI (API doesn't support re-ordering
// existing database-level properties; view-level reorder is possible
// via /v1/views but requires creating a named view). See
// docs/notion-db-template.md §9.
// Expected Relation targets. These are stable DB ids in the CSNL
// Notion workspace; if they ever change the drift detector flags it.
export const NOTION_MEMBERS_DB_ID = "94854705-c91d-4a35-a91e-803c5934745e";
export const NOTION_PROJECTS_DB_ID = "76e7c392-127e-47f3-8b7e-212610db9376";

export const NOTION_REQUIRED_PROPERTIES: NotionPropertySpec[] = [
  { name: NOTION_COLUMN.TITLE, type: "title" },
  { name: NOTION_COLUMN.DATE, type: "date" },
  { name: NOTION_COLUMN.TIME, type: "rich_text" },
  { name: NOTION_COLUMN.PROJECT, type: "rich_text" },
  { name: NOTION_COLUMN.PROTOCOL_VERSION, type: "rich_text" },
  { name: NOTION_COLUMN.SUBJECT_ID, type: "rich_text" },
  { name: NOTION_COLUMN.SESSION_NUMBER, type: "number" },
  { name: NOTION_COLUMN.PARTICIPANT, type: "rich_text" },
  // 실험자: Relation → CSNL Members. Populated from
  // profiles.notion_member_page_id; empty when unmapped.
  {
    name: NOTION_COLUMN.RESEARCHER,
    type: "relation",
    relatedDbId: NOTION_MEMBERS_DB_ID,
  },
  // 프로젝트 (관련): Relation → Projects & Chores. Populated from
  // experiments.notion_project_page_id; empty when unmapped.
  {
    name: NOTION_COLUMN.PROJECT_RELATION,
    type: "relation",
    relatedDbId: NOTION_PROJECTS_DB_ID,
  },
  { name: NOTION_COLUMN.PUBLIC_ID, type: "rich_text" },
  {
    name: NOTION_COLUMN.STATUS,
    type: "select",
    options: ["확정", "취소", "완료", "no_show"],
  },
  { name: NOTION_COLUMN.PRE_SURVEY_DONE, type: "checkbox" },
  { name: NOTION_COLUMN.PRE_SURVEY_INFO, type: "rich_text" },
  { name: NOTION_COLUMN.POST_SURVEY_DONE, type: "checkbox" },
  { name: NOTION_COLUMN.POST_SURVEY_INFO, type: "rich_text" },
  { name: NOTION_COLUMN.NOTABLE_OBSERVATIONS, type: "rich_text" },
  { name: NOTION_COLUMN.CODE_DIRECTORY, type: "rich_text" },
  { name: NOTION_COLUMN.DATA_DIRECTORY, type: "rich_text" },
  { name: NOTION_COLUMN.PARAMETER, type: "rich_text" },
  { name: NOTION_COLUMN.NOTES, type: "rich_text" },
];

export interface NotionLivePropertyType {
  type: string;
  // Select type exposes its options — we care about these because if
  // the set of select options drifts we want to surface it.
  selectOptions?: string[];
  // Relation type exposes the target database id.
  relatedDbId?: string;
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
    if (p.type === "relation") {
      return `${p.name}:relation→${p.relatedDbId.replace(/-/g, "")}`;
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
    if (spec.type === "relation") {
      // Normalise: Notion returns ids with dashes; spec strips them.
      const liveDb = (actual.relatedDbId ?? "").replace(/-/g, "");
      const expectedDb = spec.relatedDbId.replace(/-/g, "");
      if (liveDb !== expectedDb) {
        items.push({
          name: spec.name,
          kind: "type_mismatch",
          expected: `relation → ${expectedDb}`,
          actual: `relation → ${liveDb || "(none)"}`,
          details: "Relation target DB id differs from spec.",
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
