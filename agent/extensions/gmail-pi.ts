/**
 * gmail-pi — Pi global extension for Gmail via IMAP/SMTP (App Password).
 *
 * Requires GMAIL_APP_PASSWORD env var set to a Gmail App Password.
 *
 * Tools (LLM-callable):
 *   gmail_send   — send an email
 *   gmail_inbox  — list recent inbox messages
 *   gmail_read   — read a specific email by sequence number
 *   gmail_search — search emails by Gmail IMAP query
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 587;
const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;

interface AccountConfig { name: string; email: string; appPassword: string; }

interface GmailMultiConfig {
  accounts: Record<string, { email: string; appPassword: string }>;
  defaultAccount?: string;
}

let _multiConfig: GmailMultiConfig | null = null;

function loadConfig(): GmailMultiConfig {
  if (_multiConfig) return _multiConfig;
  const cfgPath = join(homedir(), ".pi", "agent", "gmail-config.json");
  const raw = readFileSync(cfgPath, "utf-8");
  const parsed = JSON.parse(raw);

  // Detect old flat format {email, appPassword} — auto-wrap
  if (parsed.email && parsed.appPassword && !parsed.accounts) {
    _multiConfig = {
      accounts: { default: { email: parsed.email, appPassword: parsed.appPassword } },
      defaultAccount: "default",
    };
    return _multiConfig;
  }

  // New multi-account format
  if (parsed.accounts && typeof parsed.accounts === "object") {
    _multiConfig = {
      accounts: parsed.accounts,
      defaultAccount: parsed.defaultAccount || Object.keys(parsed.accounts)[0] || undefined,
    };
    return _multiConfig;
  }

  throw new Error("Invalid gmail-config.json format. Expected {accounts: {...}, defaultAccount: \"...\"} or {email, appPassword}.");
}

function getAccountConfig(accountName?: string): AccountConfig {
  const cfg = loadConfig();
  const name = accountName || cfg.defaultAccount;
  if (!name) {
    throw new Error("No Gmail account configured and no defaultAccount set.");
  }
  const entry = cfg.accounts[name];
  if (!entry) {
    const available = Object.keys(cfg.accounts).join(", ") || "(none)";
    throw new Error(`Gmail account "${name}" not found. Available accounts: ${available}.`);
  }
  return { name, email: entry.email, appPassword: entry.appPassword };
}

function getAccountNames(): string[] {
  try { return Object.keys(loadConfig().accounts); } catch { return []; }
}

/** Safe check — returns list of configured account names or empty array. */
function getConfigSafely(): string[] {
  return getAccountNames();
}

function text(t: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: t }],
    details: isError ? { error: true } : {},
  };
}

/** Create an SMTP transporter for sending. */
function createTransporter(cfg: AccountConfig) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false, // STARTTLS
    auth: { user: cfg.email, pass: cfg.appPassword },
  });
}

/** Create an IMAP client for reading. */
function createImapClient(cfg: AccountConfig) {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: cfg.email, pass: cfg.appPassword },
  });
}

/** Format an email date. */
function fmtDate(d: Date | string | undefined): string {
  if (!d) return "?";
  if (typeof d === "string") return d;
  return d.toISOString();
}

export default function gmailPi(pi: ExtensionAPI) {
  // ------------------------------------------------------------------- tools

  pi.registerTool({
    name: "gmail_send",
    label: "Gmail Send",
    description: "Send an email via Gmail. Provide `to`, `subject`, and `body` (plain text).",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient email address." }),
      subject: Type.String({ description: "Email subject line." }),
      body: Type.String({ description: "Email body (plain text)." }),
      account: Type.Optional(Type.String({ description: "Optional account name from gmail-config.json. Uses default if omitted." })),
    }),
    async execute(_id, params) {
      try {
        const cfg = getAccountConfig(params.account);
        const transporter = createTransporter(cfg);
        await transporter.sendMail({
          from: cfg.email,
          to: params.to,
          subject: params.subject,
          text: params.body,
        });
        transporter.close();
        return text(`Email sent to ${params.to}: "${params.subject}"`);
      } catch (err) {
        return text(`gmail_send failed: ${(err as Error).message}`, true);
      }
    },
  });

  pi.registerTool({
    name: "gmail_inbox",
    label: "Gmail Inbox",
    description: "List recent inbox emails. Returns sender, subject, date, and seq number. Use `limit` to control count (default 10, max 50).",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max results (default 10, max 50)." })),
      account: Type.Optional(Type.String({ description: "Optional account name from gmail-config.json. Uses default if omitted." })),
    }),
    async execute(_id, params) {
      const cfg = getAccountConfig(params.account);
      const client = createImapClient(cfg);
      try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        try {
          const limit = params.limit ?? 10;
          const count = Math.min(client.mailbox.exists, limit);
          if (count === 0) return text("Inbox is empty.");

          const start = Math.max(1, client.mailbox.exists - count + 1);
          const messages: string[] = [];
          for await (const msg of client.fetch(`${start}:*`, {
            envelope: true,
            source: false,
            bodyStructure: false,
          })) {
            const env = msg.envelope;
            const from = env.from?.[0]?.address ?? "unknown";
            const subject = env.subject ?? "(no subject)";
            const date = fmtDate(env.date);
            messages.push(`${msg.seq}. ${from} — ${subject} (${date})`);
          }
          return text(
            `Inbox (${client.mailbox.exists} total, showing last ${count}):\n${messages.reverse().join("\n")}`,
          );
        } finally {
          lock.release();
        }
      } catch (err) {
        return text(`gmail_inbox failed: ${(err as Error).message}`, true);
      } finally {
        client.close();
      }
    },
  });

  pi.registerTool({
    name: "gmail_read",
    label: "Gmail Read",
    description: "Read a specific email by its sequence number (from gmail_inbox). Returns full headers and body.",
    parameters: Type.Object({
      seq: Type.Integer({ minimum: 1, description: "Email sequence number from inbox listing." }),
      account: Type.Optional(Type.String({ description: "Optional account name from gmail-config.json. Uses default if omitted." })),
    }),
    async execute(_id, params) {
      const cfg = getAccountConfig(params.account);
      const client = createImapClient(cfg);
      try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        try {
          const msgs = await client.fetchOne(`${params.seq}`, {
            envelope: true,
            source: true,
            bodyStructure: false,
          }, { uid: false });
          if (!msgs) return text(`No message at seq ${params.seq}.`, true);

          const env = msgs.envelope;
          const from = env.from?.[0]?.address ?? "unknown";
          const fromName = env.from?.[0]?.name ?? "";
          const subject = env.subject ?? "(no subject)";
          const date = fmtDate(env.date);
          const to = env.to?.map((a) => a.address).join(", ") ?? "";
          const source = msgs.source?.toString() || "(no body)";

          // Split raw source to isolate email body from transport headers
          let rawBody = source;
          const boundaryIndex = source.indexOf("\r\n\r\n");
          if (boundaryIndex !== -1) {
            rawBody = source.substring(boundaryIndex + 4);
          } else {
            const boundaryIndexNL = source.indexOf("\n\n");
            if (boundaryIndexNL !== -1) {
              rawBody = source.substring(boundaryIndexNL + 2);
            }
          }

          const header = `From: ${fromName} <${from}>\nTo: ${to}\nDate: ${date}\nSubject: ${subject}`;
          const body = rawBody
            .replace(/<[^>]+>/g, "") // strip HTML tags
            .replace(/\n{3,}/g, "\n\n") // collapse blank lines
            .trim()
            .substring(0, 4000);

          return text(`${header}\n\n${body}`);
        } finally {
          lock.release();
        }
      } catch (err) {
        return text(`gmail_read failed: ${(err as Error).message}`, true);
      } finally {
        client.close();
      }
    },
  });

  pi.registerTool({
    name: "gmail_search",
    label: "Gmail Search",
    description: "Search inbox emails using Gmail IMAP search syntax. Examples: 'FROM john', 'SUBJECT meeting', 'KEYWORD report', 'SINCE 01-Jun-2024'. Returns matching messages with seq numbers.",
    parameters: Type.Object({
      query: Type.String({ description: "IMAP search query (FROM, SUBJECT, KEYWORD, SINCE, BEFORE, etc)." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max results (default 20, max 50)." })),
      account: Type.Optional(Type.String({ description: "Optional account name from gmail-config.json. Uses default if omitted." })),
    }),
    async execute(_id, params) {
      const cfg = getAccountConfig(params.account);
      const client = createImapClient(cfg);
      try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        try {
          const limit = params.limit ?? 20;
          const searchObj: Record<string, string> = {};
          const parts = params.query.match(/(FROM|SUBJECT|KEYWORD|SINCE|BEFORE|TO|CC|BCC|HEADER|TEXT|UNSEEN|SEEN|FLAGGED)\s+(.+)/i);
          if (parts) {
            const key = parts[1].toLowerCase();
            const value = parts[2].replace(/^["']|["']$/g, "");
            searchObj[key] = value;
          } else {
            // Treat as raw keyword/free text search
            searchObj.keyword = params.query;
          }
          const rawResults = await client.search(searchObj);
          const results = Array.isArray(rawResults) ? rawResults : Array.from(rawResults);

          if (results.length === 0) return text(`No emails matching "${params.query}".`);

          const toFetch = results.slice(-limit);
          const messages: string[] = [];
          for await (const msg of client.fetch(toFetch, {
            envelope: true,
            source: false,
            bodyStructure: false,
          })) {
            const env = msg.envelope;
            const from = env.from?.[0]?.address ?? "unknown";
            const subject = env.subject ?? "(no subject)";
            const date = fmtDate(env.date);
            messages.push(`${msg.seq}. ${from} — ${subject} (${date})`);
          }
          return text(
            `Found ${results.length} match(es) for "${params.query}" (showing up to ${limit}):\n${messages.reverse().join("\n")}`,
          );
        } finally {
          lock.release();
        }
      } catch (err) {
        return text(`gmail_search failed: ${(err as Error).message}`, true);
      } finally {
        client.close();
      }
    },
  });

  // Startup check
  pi.on("session_start", async (_event, ctx) => {
    const names = getConfigSafely();
    if (names.length === 0) {
      ctx.ui.notify(
        "gmail-pi: Gmail credentials not configured. Create ~/.pi/agent/gmail-config.json with {accounts: {...}, defaultAccount: \"...\"}.",
        "info",
      );
    } else {
      ctx.ui.notify(
        `gmail-pi: ${names.length} Gmail account(s) configured: ${names.join(", ")}.`,
        "info",
      );
    }
  });
}
