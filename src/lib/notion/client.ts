import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

export async function createBookingPage(data: {
  experimentTitle: string;
  participantName: string;
  phone: string;
  email: string;
  sessionDate: string;
  sessionTime: string;
  status: string;
  fee: number;
}): Promise<string> {
  const response = await notion.pages.create({
    parent: { database_id: process.env.NOTION_DATABASE_ID! },
    properties: {
      실험명: { title: [{ text: { content: data.experimentTitle } }] },
      참여자: { rich_text: [{ text: { content: data.participantName } }] },
      연락처: { phone_number: data.phone },
      이메일: { email: data.email },
      일시: { date: { start: data.sessionDate } },
      시간: { rich_text: [{ text: { content: data.sessionTime } }] },
      상태: { select: { name: data.status } },
      참여비: { number: data.fee },
    },
  });

  return response.id;
}

export async function updateBookingPage(
  pageId: string,
  status: string
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      상태: { select: { name: status } },
    },
  });
}
