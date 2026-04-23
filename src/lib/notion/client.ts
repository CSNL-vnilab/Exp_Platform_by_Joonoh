// Notion writes go through our rate-limit-aware wrapper instead of
// @notionhq/client so we can read X-RateLimit-Remaining / Retry-After
// headers and back off pre-emptively. The wrapper handles auth,
// Notion-Version, JSON body, and 429 retry with Retry-After respect.
import { fetchNotion } from "@/lib/notion/rate-limit";

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
    실험명: { title: [{ text: { content: data.experimentTitle } }] },
    프로젝트: {
      rich_text: [{ text: { content: data.projectName ?? "" } }],
    },
    실험날짜: { date: { start: kstDate } },
    시간: { rich_text: [{ text: { content: timeRange } }] },
    "피험자 ID": {
      rich_text: [
        { text: { content: data.subjectNumber != null ? `Sbj${data.subjectNumber}` : "" } },
      ],
    },
    회차: { number: data.sessionNumber },
    참여자: { rich_text: [{ text: { content: data.participantName } }] },
    상태: { select: { name: data.status } },
    // Pseudonymous lab-scoped code. Populated when Stream B's identity row
    // exists; otherwise left empty. This column is the preferred external
    // reference (see docs/notion-db-template.md §7 PII note).
    "공개 ID": {
      rich_text: [{ text: { content: data.publicCode ?? "" } }],
    },
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

export async function updateBookingPage(
  pageId: string,
  status: string,
): Promise<void> {
  await fetchNotion(`/v1/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: { 상태: { select: { name: status } } },
    }),
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
    실험명: {
      title: [{ text: { content: `[실험] ${data.experimentTitle}` } }],
    },
    프로젝트: {
      rich_text: [{ text: { content: data.projectName ?? "" } }],
    },
    실험날짜: { date: { start: data.startDate, end: data.endDate } },
    시간: {
      rich_text: [{ text: { content: `${data.startDate} ~ ${data.endDate}` } }],
    },
    "피험자 ID": { rich_text: [{ text: { content: "실험 마스터" } }] },
    회차: { number: 0 },
    참여자: {
      rich_text: [{ text: { content: data.researcherName ?? "" } }],
    },
    상태: { select: { name: data.status } },
    // Notion Text column accepts both URLs and raw paths, so we standardise on
    // rich_text rather than branching on url/text. This matches the documented
    // schema in docs/notion-db-template.md: the column must be configured as
    // Text (not URL) so server-path strings don't 400.
    "Code Directory": { rich_text: [{ text: { content: data.codeRepoUrl } }] },
    "Data Directory": { rich_text: [{ text: { content: data.dataPath } }] },
    Parameter: {
      rich_text: [{ text: { content: paramSummary || "(없음)" } }],
    },
    Notes: {
      rich_text: [
        {
          text: { content: checklistSummary ? `체크리스트:\n${checklistSummary}` : "" },
        },
      ],
    },
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
    "공개 ID": {
      rich_text: [{ text: { content: data.publicCode ?? "" } }],
    },
    "Pre-Survey 완료": { checkbox: data.preSurveyDone },
    "Pre-Survey 정보": {
      rich_text: [{ text: { content: data.preSurveyInfo ?? "" } }],
    },
    "Post-Survey 완료": { checkbox: data.postSurveyDone },
    "Post-Survey 정보": {
      rich_text: [{ text: { content: data.postSurveyInfo ?? "" } }],
    },
    특이사항: {
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
    실험명: { title: [{ text: { content: data.experimentTitle } }] },
    프로젝트: {
      rich_text: [{ text: { content: data.projectName ?? "" } }],
    },
    실험날짜: { date: { start: kstDate } },
    시간: { rich_text: [{ text: { content: timeRange } }] },
    "피험자 ID": {
      rich_text: [
        {
          text: {
            content:
              data.subjectNumber != null ? `Sbj${data.subjectNumber}` : "",
          },
        },
      ],
    },
    회차: { number: data.sessionNumber },
    // Fallback page: we don't have participant name handy here, and we must
    // avoid synthesising fake PII. Leave 참여자 blank; the 공개 ID below is
    // the canonical reference. Researchers can manually relink if needed.
    참여자: { rich_text: [{ text: { content: "" } }] },
    상태: { select: { name: "완료" } },
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
