// server.js — VETA local dev server (full parity with worker.js)
// Endpoints:
//   POST /api/analyze            → direct analysis (recruiter pastes resume)
//   POST /api/submit             → candidate submits application → in-memory store
//   GET  /api/queue?role=        → list submissions for a role
//   POST /api/analyze-submission → analyze a queued submission by id
//   POST /api/update-status      → advance / decline a candidate
//   POST /api/notify             → send email via Gmail SMTP
//   POST /api/check-email        → poll Gmail inbox for new resume submissions

import express from "express";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { SYSTEM_PROMPT, JSON_INSTRUCTION } from "./system_prompt.js";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;
const MODEL   = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json({ limit: "15mb" }));
app.use(express.static("public"));

// ── In-memory KV store (mirrors Cloudflare Workers KV for local dev) ─────────
const STORE = new Map();

function kvGet(key) { return STORE.get(key) ?? null; }
function kvPut(key, value) { STORE.set(key, value); }

// ── Shared analysis core ──────────────────────────────────────────────────────
async function runAnalysis({ jobProfile, resumeText, resumePdf }) {
  if (!API_KEY || API_KEY.includes("your-key-here")) {
    return { error: "No API key found. Add ANTHROPIC_API_KEY to your .env file." };
  }

  const ctx = [
    "=== JOB CONTEXT PROFILE ===",
    `Company: ${jobProfile.company       || "(not given)"}`,
    `What the company does: ${jobProfile.about         || "(not given)"}`,
    `Role being hired: ${jobProfile.role           || "(not given)"}`,
    `What this person will actually do in a typical week: ${jobProfile.weeklyWork     || "(not given)"}`,
    `Must-have skills: ${jobProfile.mustHaves}`,
    `Nice-to-haves: ${jobProfile.niceToHaves    || "(none listed)"}`,
    `Culture words: ${jobProfile.cultureWords   || "(none listed)"}`,
    `Why this role is open: ${jobProfile.whyOpen        || "(not given)"}`,
  ];

  const content = resumePdf
    ? [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: resumePdf } },
        { type: "text", text: [...ctx, "", JSON_INSTRUCTION].join("\n") },
      ]
    : [...ctx, "", "=== RESUME ===", resumeText, "", JSON_INSTRUCTION].join("\n");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type":      "application/json",
      "x-api-key":         API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 4000,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content }],
    }),
  });

  const data = await response.json();
  if (!response.ok) return { error: data?.error?.message || `API returned ${response.status}` };

  const text  = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return { analysis: JSON.parse(clean), model: data.model, usage: data.usage };
  } catch {
    return { raw: text, model: data.model, usage: data.usage };
  }
}

function roleSlug(role) {
  return (role || "general").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ── POST /api/analyze ─────────────────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { jobProfile, resumeText, resumePdf } = req.body || {};
  if (!resumePdf && (!resumeText || resumeText.trim().length < 40))
    return res.status(400).json({ error: "Paste a resume or upload a PDF — it looks empty." });
  if (!jobProfile?.mustHaves)
    return res.status(400).json({ error: "Fill out the Job Context Profile first." });
  try {
    const result = await runAnalysis({ jobProfile, resumeText, resumePdf });
    if (result.error) return res.status(502).json(result);
    return res.json(result);
  } catch (err) {
    console.error("Analyze error:", err);
    return res.status(502).json({ error: "Could not reach the Anthropic API." });
  }
});

// ── POST /api/submit ──────────────────────────────────────────────────────────
app.post("/api/submit", (req, res) => {
  const { name, email, role, company, resumePdf, resumeText } = req.body || {};
  if (!name?.trim())  return res.status(400).json({ error: "Name is required." });
  if (!email?.trim()) return res.status(400).json({ error: "Email is required." });
  if (!resumePdf && !resumeText?.trim()) return res.status(400).json({ error: "Resume is required." });

  const id       = crypto.randomUUID();
  const slug     = roleSlug(role);
  const submission = {
    id,
    name:        name.trim(),
    email:       email.trim(),
    role:        role    || "General",
    company:     company || "",
    resumePdf:   resumePdf   || null,
    resumeText:  resumeText  || null,
    submittedAt: Date.now(),
    status:      "pending",
    analysis:    null,
  };

  kvPut(`submission:${id}`, JSON.stringify(submission));

  const indexKey = `index:${slug}`;
  const existing = kvGet(indexKey);
  const ids = existing ? JSON.parse(existing) : [];
  ids.unshift(id);
  kvPut(indexKey, JSON.stringify(ids.slice(0, 500)));

  console.log(`New submission: ${name} <${email}> for "${role}"`);
  return res.json({ success: true, id });
});

// ── GET /api/queue?role= ──────────────────────────────────────────────────────
app.get("/api/queue", async (req, res) => {
  const role = req.query.role || "general";
  const slug = roleSlug(role);

  const existing = kvGet(`index:${slug}`);
  const ids      = existing ? JSON.parse(existing) : [];

  const submissions = ids.slice(0, 50).map(id => {
    const raw = kvGet(`submission:${id}`);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return {
      id:          s.id,
      name:        s.name,
      email:       s.email,
      submittedAt: s.submittedAt,
      status:      s.status,
      hasAnalysis: !!s.analysis,
      score:       s.analysis?.total      || null,
      bottomLine:  s.analysis?.bottom_line || null,
    };
  }).filter(Boolean);

  return res.json({ role, total: submissions.length, submissions });
});

// ── POST /api/analyze-submission ─────────────────────────────────────────────
app.post("/api/analyze-submission", async (req, res) => {
  const { id, jobProfile } = req.body || {};
  if (!id)                   return res.status(400).json({ error: "Submission id required." });
  if (!jobProfile?.mustHaves) return res.status(400).json({ error: "Job profile (with must-haves) required." });

  const raw = kvGet(`submission:${id}`);
  if (!raw) return res.status(404).json({ error: "Submission not found." });

  const sub = JSON.parse(raw);
  sub.status = "analyzing";
  kvPut(`submission:${id}`, JSON.stringify(sub));

  try {
    const result = await runAnalysis({
      jobProfile,
      resumePdf:  sub.resumePdf,
      resumeText: sub.resumeText,
    });

    if (result.error) {
      sub.status = "pending";
      kvPut(`submission:${id}`, JSON.stringify(sub));
      return res.status(502).json(result);
    }

    if (result.analysis) {
      sub.analysis = result.analysis;
      sub.status   = "reviewed";
    } else {
      sub.status = "pending";
    }
    kvPut(`submission:${id}`, JSON.stringify(sub));
    return res.json(result);
  } catch (err) {
    sub.status = "pending";
    kvPut(`submission:${id}`, JSON.stringify(sub));
    return res.status(502).json({ error: "Could not reach the Anthropic API." });
  }
});

// ── POST /api/update-status ───────────────────────────────────────────────────
app.post("/api/update-status", (req, res) => {
  const { id, status } = req.body || {};
  if (!id || !status) return res.status(400).json({ error: "id and status required." });

  const raw = kvGet(`submission:${id}`);
  if (!raw) return res.status(404).json({ error: "Submission not found." });

  const sub = JSON.parse(raw);
  sub.status = status;
  kvPut(`submission:${id}`, JSON.stringify(sub));
  return res.json({ success: true });
});

// ── POST /api/notify — send email via Gmail SMTP ─────────────────────────────
// Requires GMAIL_USER and GMAIL_APP_PASSWORD in .env
// App Password setup: myaccount.google.com → Security → 2-Step Verification → App passwords
app.post("/api/notify", async (req, res) => {
  const { to, subject, html, text } = req.body || {};
  if (!to || !subject) return res.status(400).json({ error: "to and subject are required." });

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    return res.status(500).json({
      error: "Gmail not configured. Add GMAIL_USER and GMAIL_APP_PASSWORD to your .env file.",
    });
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });

  try {
    await transporter.sendMail({
      from: `VETA <${gmailUser}>`,
      to,
      subject,
      html,
      text,
    });
    console.log(`Email sent to ${to}`);
    return res.json({ success: true });
  } catch (err) {
    console.error("Gmail send failed:", err.message);
    return res.status(502).json({ error: "Could not send email: " + err.message });
  }
});

// ── POST /api/check-email — poll Gmail inbox for new resume submissions ────────
// Looks for unread emails, extracts name/email/resume, creates submissions.
// Body: { role, company } — the role to tag incoming resumes against
// Uses the same GMAIL_USER + GMAIL_APP_PASSWORD from .env (IMAP access).
app.post("/api/check-email", async (req, res) => {
  const { role = "General", company = "" } = req.body || {};
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass || gmailPass.includes("your-16-char")) {
    return res.status(500).json({ error: "Gmail not configured. Add GMAIL_USER and GMAIL_APP_PASSWORD to .env." });
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: gmailUser, pass: gmailPass },
    logger: false,
  });

  const newSubmissions = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // Fetch unread messages from last 7 days
      const since = new Date();
      since.setDate(since.getDate() - 7);

      const messages = [];
      for await (const msg of client.fetch(
        { seen: false, since },
        { source: true, envelope: true, uid: true }
      )) {
        messages.push({ uid: msg.uid, source: msg.source, envelope: msg.envelope });
      }

      for (const { uid, source } of messages) {
        const parsed = await simpleParser(source);

        // Extract sender name and email
        const fromAddr = parsed.from?.value?.[0];
        const senderEmail = fromAddr?.address || "";
        const senderName  = fromAddr?.name     || senderEmail.split("@")[0] || "Unknown";

        // Skip emails from VETA itself (our own notifications)
        if (senderEmail === gmailUser) continue;

        // Look for a PDF attachment first, then fall back to email body text
        const pdfAttachment = (parsed.attachments || []).find(a =>
          a.contentType === "application/pdf" || a.filename?.toLowerCase().endsWith(".pdf")
        );

        let resumePdf  = null;
        let resumeText = null;

        if (pdfAttachment) {
          resumePdf = pdfAttachment.content.toString("base64");
        } else {
          // Use the email body as resume text (candidates sometimes paste inline)
          const bodyText = parsed.text || "";
          if (bodyText.trim().length < 40) {
            // Mark as read and skip — no usable resume content
            await client.messageFlagsAdd({ uid }, ["\\Seen"]);
            continue;
          }
          resumeText = bodyText;
        }

        // Create a submission (same structure as /api/submit)
        const id       = crypto.randomUUID();
        const slug     = (role || "general").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const emailSubject = parsed.subject || "(no subject)";

        const submission = {
          id,
          name:        senderName,
          email:       senderEmail,
          role:        role    || "General",
          company:     company || "",
          resumePdf:   resumePdf  || null,
          resumeText:  resumeText || null,
          submittedAt: parsed.date ? new Date(parsed.date).getTime() : Date.now(),
          status:      "pending",
          analysis:    null,
          source:      "email",
          emailSubject,
        };

        kvPut(`submission:${id}`, JSON.stringify(submission));

        const indexKey = `index:${slug}`;
        const existing = kvGet(indexKey);
        const ids = existing ? JSON.parse(existing) : [];
        ids.unshift(id);
        kvPut(indexKey, JSON.stringify(ids.slice(0, 500)));

        // Mark the email as read so we don't pull it again
        await client.messageFlagsAdd({ uid }, ["\\Seen"]);

        newSubmissions.push({ id, name: senderName, email: senderEmail, hasResume: !!resumePdf ? "pdf" : "text" });
        console.log(`Inbox pull: ${senderName} <${senderEmail}> (${resumePdf ? "PDF" : "text"})`);
      }
    } finally {
      lock.release();
    }

    await client.logout();
    return res.json({ success: true, found: newSubmissions.length, submissions: newSubmissions });

  } catch (err) {
    console.error("Gmail IMAP error:", err.message);
    try { await client.logout(); } catch {}
    return res.status(502).json({ error: "Could not check inbox: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  VETA local server is running.`);
  console.log(`  Open http://localhost:${PORT}\n`);
  console.log(`  Model  : ${MODEL}`);
  console.log(`  Store  : in-memory (resets on restart)`);
  if (!API_KEY || API_KEY.includes("your-key-here")) {
    console.log(`  ⚠  No API key — add ANTHROPIC_API_KEY to .env`);
  }
  console.log("");
});
