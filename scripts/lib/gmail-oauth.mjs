// Gmail OAuth send helper.
//
// Reads ~/.gmail-mcp/{gcp-oauth.keys.json,credentials.json} (created by
// `npx @gongrzhe/server-gmail-autoauth-mcp auth`) and sends a single
// MIME message via the Gmail API. We don't use nodemailer here because
// the OAuth flow we already have is the gongrzhe MCP one — reusing
// those tokens means the operator only authorises once.
//
// The token files are NEVER printed; we only pull `client_id`,
// `client_secret`, `refresh_token` into memory.
//
// Public surface:
//   sendGmailOAuth({ to, subject, html, fromName? }) → { id, threadId }

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { google } from "googleapis";

const HOME = homedir();
const KEYS_PATH = join(HOME, ".gmail-mcp", "gcp-oauth.keys.json");
const CREDS_PATH = join(HOME, ".gmail-mcp", "credentials.json");

let cachedClient = null;

async function getOAuthClient() {
  if (cachedClient) return cachedClient;

  const keysRaw = await readFile(KEYS_PATH, "utf8");
  const keys = JSON.parse(keysRaw);
  // gongrzhe writes either `installed` or `web` shape; try both.
  const block = keys.installed ?? keys.web ?? keys;
  const { client_id, client_secret, redirect_uris } = block;
  if (!client_id || !client_secret) {
    throw new Error(
      "gcp-oauth.keys.json missing client_id/client_secret. Re-run `npx @gongrzhe/server-gmail-autoauth-mcp auth`.",
    );
  }
  const redirect = (Array.isArray(redirect_uris) && redirect_uris[0]) || "http://localhost";

  const credsRaw = await readFile(CREDS_PATH, "utf8");
  const creds = JSON.parse(credsRaw);
  const refresh_token = creds.refresh_token ?? creds.refreshToken;
  if (!refresh_token) {
    throw new Error(
      "credentials.json missing refresh_token. Re-run `npx @gongrzhe/server-gmail-autoauth-mcp auth`.",
    );
  }

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect);
  oAuth2Client.setCredentials({ refresh_token });
  cachedClient = oAuth2Client;
  return oAuth2Client;
}

function buildRawMessage({ to, subject, html, fromName }) {
  // Escape Korean subject per RFC 2047 — base64-encode so non-ASCII
  // characters don't get mangled by intermediate relays.
  const subj = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const fromHeader = fromName
    ? `=?UTF-8?B?${Buffer.from(fromName, "utf8").toString("base64")}?= <${process.env.GMAIL_USER ?? ""}>`
    : (process.env.GMAIL_USER ?? "");
  const headers = [
    `To: ${to}`,
    `From: ${fromHeader}`,
    `Subject: ${subj}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].join("\r\n");
  const body = Buffer.from(html, "utf8").toString("base64");
  // Gmail API expects URL-safe base64 of the entire RFC 822 message.
  const raw = `${headers}\r\n\r\n${body}`;
  return Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendGmailOAuth({ to, subject, html, fromName }) {
  const auth = await getOAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildRawMessage({ to, subject, html, fromName });
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return { id: res.data.id, threadId: res.data.threadId };
}

export async function getOAuthSenderEmail() {
  const auth = await getOAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  return profile.data.emailAddress;
}
