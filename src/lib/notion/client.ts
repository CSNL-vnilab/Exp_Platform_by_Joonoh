// Notion writes go through our rate-limit-aware wrapper instead of
// @notionhq/client so we can read X-RateLimit-Remaining / Retry-After
// headers and back off pre-emptively. The wrapper handles auth,
// Notion-Version, JSON body, and 429 retry with Retry-After respect.
import { fetchNotion } from "@/lib/notion/rate-limit";
import { NOTION_COLUMN } from "@/lib/notion/schema";

export interface BookingNotionData {
  experimentTitle: string;
  projectName: string | null;
  subjectNumber: number | null;
  sessionNumber: number;
  sessionDateIso: string; // ISO timestamp (UTC); Notion stores as "YYYY-MM-DD HH:MM"
  slotStartIso: string;
  slotEndIso: string;
  participantName: string;
  phone: string;
  email: string;
  status: string;
  fee: number;
  researcherName: string | null;
  // Lab-scoped pseudonymous participant identifier (e.g. "CSNL-A4F2B1").
  // Optional so legacy callers don't break; if null/absent, the 공개 ID
  // column is left blank.
  publicCode?: string | null;
  // Experiment protocol version (migration 00042). Free-form string,
  // e.g. "v1.2", "2026-03-rev2". Null/absent → 버전넘버 column blank.
  protocolVersion?: string | null;
  // Relation → CSNL Members DB page id for the researcher who owns the
  // experiment (migration 00043). Populates 실험자 relation. Optional —
  // if absent the relation cell is left empty (no fallback text column
  // because we already have rich_text 참여자 for the participant).
  researcherMemberPageId?: string | null;
  // Relation → Projects & Chores DB page id. Populates 프로젝트 (관련)
  // relation. Optional — rich_text 프로젝트 still carries the project
  // name string so legacy views keep working.
  projectPageId?: string | null;
}

// Property names match the Notion database template in
// docs/NOTION_DB_TEMPLATE.md. Optional columns (code/data/parameter/notes)
// are left blank for the researcher to fill in manually after the session.
export async function createBookingPage(data: BookingNotionData): Promise<string> {
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!dbId) throw new Error("NOTION_DATABASE_ID not configured");

  const kstDate = data.sessionDateIso.slice(0, 10);
  const timeRange = `${formatTime(data.slotStartIso)} - ${formatTime(data.slotEndIso)}`;

  const properties: Record<string, unknown> = {
    [NOTION_COLUMN.TITLE]: {
      title: [{ text: { content: data.experimentTitle } }],
    },
    [NOTION_COLUMN.PROJECT]: {
      rich_text: [{ text: { content: data.projectName ?? "" } }],
    },
    [NOTION_COLUMN.DATE]: { date: { start: kstDate } },
    [NOTION_COLUMN.TIME]: {
      rich_text: [{ text: { content: timeRange } }],
    },
    [NOTION_COLUMN.SUBJECT_ID]: {
      rich_text: [
        {
          text: {
            content:
              data.subjectNumber != null ? `Sbj${data.subjectNumber}` : "",
          },
        },
      ],
    },
    [NOTION_COLUMN.SESSION_NUMBER]: { number: data.sessionNumber },
    [NOTION_COLUMN.PARTICIPANT]: {
      rich_text: [{ text: { content: data.participantName } }],
    },
    // NOTE: 실험자 is now a Relation column (type changed via Notion API
    // 2026-04-23). It's populated below only when researcherMemberPageId
    // is known. Writing rich_text here would 400.
    [NOTION_COLUMN.STATUS]: { select: { name: data.status } },
    // Pseudonymous lab-scoped code. Populated when Stream B's identity row
    // exists; otherwise left empty. This column is the preferred external
    // reference (see docs/notion-db-template.md §7 PII note).
    [NOTION_COLUMN.PUBLIC_ID]: {
      rich_text: [{ text: { content: data.publicCode ?? "" } }],
    },
    // Experiment protocol version label (migration 00042).
    [NOTION_COLUMN.PROTOCOL_VERSION]: {
      rich_text: [{ text: { content: data.protocolVersion ?? "" } }],
    },
  };
  // Optional Relation arrays (migration 00043). Only emit when we have an
  // id — Notion accepts empty [] but we'd rather not clutter the payload.
  if (data.researcherMemberPageId) {
    properties[NOTION_COLUMN.RESEARCHER] = {
      relation: [{ id: data.researcherMemberPageId }],
    };
  }
  if (data.projectPageId) {
    properties[NOTION_COLUMN.PROJECT_RELATION] = {
      relation: [{ id: data.projectPageId }],
    };
  }

  const response = await fetchNotion<{ id: string }>("/v1/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dbId.trim() },
      properties,
    }),
  });

  return response.id;
}

export async function updateBookingPage(
  pageId: string,
  status: string,
): Promise<void> {
  await fetchNotion(`/v1/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        [NOTION_COLUMN.STATUS]: { select: { name: status } },
      },
    }),
  });
}

// Archive (soft-delete) a booking's Notion page — used by the 노쇼 wipe
// flow, which deletes the DB rows entirely. archived:true moves the page
// to Notion's trash so the calendar mirror stays truthful. Best-effort:
// callers wrap this in try/catch (a Notion outage must not block the wipe).
export async function archiveBookingPage(pageId: string): Promise<void> {
  await fetchNotion(`/v1/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
}

export interface ExperimentNotionData {
  experimentTitle: string;
  projectName: string | null;
  codeRepoUrl: string;
  dataPath: string;
  parameterSchema: Array<{
    key: string;
    type: string;
    default?: string | number | null;
    options?: string[];
  }>;
  checklist: Array<{ item: string; required: boolean }>;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  researcherName: string | null;
  status: string;
  // Experiment protocol version label (migration 00042).
  protocolVersion?: string | null;
  // Relation page ids (migration 00043). See BookingNotionData above.
  researcherMemberPageId?: string | null;
  projectPageId?: string | null;
}

// Mirrors an experiment (not a booking) into Notion on draft → active.
// Booking-level rows continue to point at the same Code/Data columns, but
// are now pre-filled at the experiment level so researchers stop hand-typing.
// Returns the created Notion page id, or null if NOTION_API_KEY is absent.
export async function createExperimentPage(
  data: ExperimentNotionData,
): Promise<string | null> {
  if (!process.env.NOTION_API_KEY) return null;
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!dbId) throw new Error("NOTION_DATABASE_ID not configured");

  const paramSummary = data.parameterSchema
    .map((p) => {
      const opts =
        p.type === "enum" && p.options?.length ? ` [${p.options.join("|")}]` : "";
      const def = p.default != null && p.default !== "" ? ` = ${p.default}` : "";
      return `${p.key}: ${p.type}${opts}${def}`;
    })
    .join("\n");

  const checklistSummary = data.checklist
    .map((c) => `${c.required ? "[R]" : "[ ]"} ${c.item}`)
    .join("\n");

  const properties: Record<string, unknown> = {
    [NOTION_COLUMN.TITLE]: {
      title: [{ text: { content: `[실험] ${data.experimentTitle}` } }],
    },
    [NOTION_COLUMN.PROJECT]: {
      rich_text: [{ text: { content: data.projectName ?? "" } }],
    },
    [NOTION_COLUMN.PROTOCOL_VERSION]: {
      rich_text: [{ text: { content: data.protocolVersion ?? "" } }],
    },
    [NOTION_COLUMN.DATE]: {
      date: { start: data.startDate, end: data.endDate },
    },
    [NOTION_COLUMN.TIME]: {
      rich_text: [
        { text: { content: `${data.startDate} ~ ${data.endDate}` } },
      ],
    },
    [NOTION_COLUMN.SUBJECT_ID]: {
      rich_text: [{ text: { content: "실험 마스터" } }],
    },
    [NOTION_COLUMN.SESSION_NUMBER]: { number: 0 },
    // 참여자 is blank on the experiment-master row — there's no specific
    // person tied to it. The researcher goes in the 실험자 Relation
    // column populated below (only when researcherMemberPageId is set).
    [NOTION_COLUMN.PARTICIPANT]: {
      rich_text: [{ text: { content: "" } }],
    },
    [NOTION_COLUMN.STATUS]: { select: { name: data.status } },
    // Notion Text column accepts both URLs and raw paths, so we standardise on
    // rich_text rather than branching on url/text. This matches the documented
    // schema in docs/notion-db-template.md: the column must be configured as
    // Text (not URL) so server-path strings don't 400.
    [NOTION_COLUMN.CODE_DIRECTORY]: {
      rich_text: [{ text: { content: data.codeRepoUrl } }],
    },
    [NOTION_COLUMN.DATA_DIRECTORY]: {
      rich_text: [{ text: { content: data.dataPath } }],
    },
    [NOTION_COLUMN.PARAMETER]: {
      rich_text: [{ text: { content: paramSummary || "(없음)" } }],
    },
    [NOTION_COLUMN.NOTES]: {
      rich_text: [
        {
          text: {
            content: checklistSummary
              ? `체크리스트:\n${checklistSummary}`
              : "",
          },
        },
      ],
    },
  };
  // Relations (migration 00043) — only emit when we have the id.
  if (data.researcherMemberPageId) {
    properties[NOTION_COLUMN.RESEARCHER] = {
      relation: [{ id: data.researcherMemberPageId }],
    };
  }
  if (data.projectPageId) {
    properties[NOTION_COLUMN.PROJECT_RELATION] = {
      relation: [{ id: data.projectPageId }],
    };
  }

  const response = await fetchNotion<{ id: string }>("/v1/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dbId.trim() },
      properties,
    }),
  });

  return response.id;
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Observation (pre/post survey + notable observations) sync.
//
// This runs after the session has started (pre-survey) or finished
// (post-survey + 특이사항). The booking's Notion row was already created by
// createBookingPage during the post-booking pipeline, so the normal path is
// a PATCH against that existing page. If for some reason the booking page
// wasn't created (NOTION_API_KEY absent at booking time, or Notion was
// temporarily down), we fall back to creating a fresh page so researchers
// don't lose the observation data.
// ---------------------------------------------------------------------------
export interface ObservationNotionData {
  experimentTitle: string;
  projectName: string | null;
  publicCode: string | null;
  subjectNumber: number | null;
  sessionNumber: number;
  sessionDateIso: string;
  slotStartIso: string;
  slotEndIso: string;
  preSurveyDone: boolean;
  preSurveyInfo: string | null;
  postSurveyDone: boolean;
  postSurveyInfo: string | null;
  notableObservations: string | null;
  researcherName: string | null;
  // When provided, PATCH this existing page instead of creating a new one.
  bookingNotionPageId: string | null;
}

export async function upsertObservationPage(
  data: ObservationNotionData,
): Promise<string> {
  if (!process.env.NOTION_API_KEY) {
    throw new Error("NOTION_API_KEY not configured");
  }
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!dbId) throw new Error("NOTION_DATABASE_ID not configured");

  // Observation-only properties. Pre/Post completion is checkbox (not select);
  // the free-text 정보 / 특이사항 columns are rich_text so researchers can paste
  // multi-line notes.
  const observationProps: Record<string, unknown> = {
    [NOTION_COLUMN.PUBLIC_ID]: {
      rich_text: [{ text: { content: data.publicCode ?? "" } }],
    },
    [NOTION_COLUMN.PRE_SURVEY_DONE]: { checkbox: data.preSurveyDone },
    [NOTION_COLUMN.PRE_SURVEY_INFO]: {
      rich_text: [{ text: { content: data.preSurveyInfo ?? "" } }],
    },
    [NOTION_COLUMN.POST_SURVEY_DONE]: { checkbox: data.postSurveyDone },
    [NOTION_COLUMN.POST_SURVEY_INFO]: {
      rich_text: [{ text: { content: data.postSurveyInfo ?? "" } }],
    },
    [NOTION_COLUMN.NOTABLE_OBSERVATIONS]: {
      rich_text: [{ text: { content: data.notableObservations ?? "" } }],
    },
  };

  if (data.bookingNotionPageId) {
    await fetchNotion(`/v1/pages/${data.bookingNotionPageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: observationProps }),
    });
    return data.bookingNotionPageId;
  }

  // Safety fallback: create a new page with the same booking-level shape
  // plus the observation columns. In practice this branch is rare (only if
  // createBookingPage previously failed).
  const kstDate = data.sessionDateIso.slice(0, 10);
  const timeRange = `${formatTime(data.slotStartIso)} - ${formatTime(data.slotEndIso)}`;

  const properties: Record<string, unknown> = {
    [NOTION_COLUMN.TITLE]: {
      title: [{ text: { content: data.experimentTitle } }],
    },
    [NOTION_COLUMN.PROJECT]: {
      rich_text: [{ text: { content: data.projectName ?? "" } }],
    },
    [NOTION_COLUMN.DATE]: { date: { start: kstDate } },
    [NOTION_COLUMN.TIME]: {
      rich_text: [{ text: { content: timeRange } }],
    },
    [NOTION_COLUMN.SUBJECT_ID]: {
      rich_text: [
        {
          text: {
            content:
              data.subjectNumber != null ? `Sbj${data.subjectNumber}` : "",
          },
        },
      ],
    },
    [NOTION_COLUMN.SESSION_NUMBER]: { number: data.sessionNumber },
    // Fallback page: we don't have participant name handy here, and we must
    // avoid synthesising fake PII. Leave 참여자 blank; the 공개 ID below is
    // the canonical reference. Researchers can manually relink if needed.
    [NOTION_COLUMN.PARTICIPANT]: {
      rich_text: [{ text: { content: "" } }],
    },
    // 실험자 is a Relation column — we don't have a member page id in
    // this fallback path, so it stays empty.
    [NOTION_COLUMN.STATUS]: { select: { name: "완료" } },
    ...observationProps,
  };

  const response = await fetchNotion<{ id: string }>("/v1/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dbId.trim() },
      properties,
    }),
  });

  return response.id;
}
