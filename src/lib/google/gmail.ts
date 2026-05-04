import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  cc?: string | string[];
  bcc?: string | string[];
  // C-P1-4: Reply-To header. When set, "Reply" in the recipient's
  // mail client targets this address (typically the responsible
  // researcher's contact_email) instead of the lab-wide GMAIL_USER
  // inbox the mail was sent FROM. Optional: callers without a
  // researcher contact can omit it and the From address is used.
  replyTo?: string;
}

export async function sendEmail(
  toOrOptions: string | SendEmailOptions,
  subject?: string,
  html?: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const opts: SendEmailOptions =
    typeof toOrOptions === "string"
      ? { to: toOrOptions, subject: subject ?? "", html: html ?? "" }
      : toOrOptions;
  try {
    const info = await transporter.sendMail({
      from: `"${process.env.NEXT_PUBLIC_LAB_NAME || "LAB"}" <${process.env.GMAIL_USER}>`,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      replyTo: opts.replyTo,
      subject: opts.subject,
      html: opts.html,
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: message };
  }
}
