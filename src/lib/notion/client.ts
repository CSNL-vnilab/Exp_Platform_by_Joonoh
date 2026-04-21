import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

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
  };

  const response = await notion.pages.create({
    parent: { database_id: dbId.trim() },
    properties: properties as Parameters<typeof notion.pages.create>[0]["properties"],
  });

  return response.id;
}

export async function updateBookingPage(
  pageId: string,
  status: string,
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      상태: { select: { name: status } },
    },
  });
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
