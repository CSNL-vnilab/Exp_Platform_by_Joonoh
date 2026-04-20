import { createHmac, randomBytes } from "crypto";

const SOLAPI_BASE = "https://api.solapi.com";

function generateAuth() {
  const date = new Date().toISOString();
  const salt = randomBytes(16).toString("hex");
  const signature = createHmac("sha256", process.env.SOLAPI_API_SECRET!)
    .update(date + salt)
    .digest("hex");

  return `HMAC-SHA256 apiKey=${process.env.SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

export async function sendSMS(
  to: string,
  text: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const response = await fetch(`${SOLAPI_BASE}/messages/v4/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: generateAuth(),
      },
      body: JSON.stringify({
        message: {
          to: to.replace(/-/g, ""),
          from: process.env.SOLAPI_SENDER_PHONE,
          text,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.errorMessage || "SMS 전송 실패" };
    }

    return { success: true, messageId: data.groupId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: message };
  }
}
