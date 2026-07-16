// worker.js — VETA on Cloudflare Workers
// Routes:
//   POST /api/analyze            → direct analysis (recruiter pastes resume)
//   POST /api/submit             → candidate submits application → KV
//   GET  /api/queue?role=        → list submissions for a role
//   POST /api/analyze-submission → analyze a queued submission by id
//   POST /api/update-status      → advance / decline a candidate
//   POST /api/notify             → send email via Resend

import { SYSTEM_PROMPT, JSON_INSTRUCTION } from "./system_prompt.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;
    const m    = request.method;

    if (path === "/api/analyze"            && m === "POST") return handleAnalyze(request, env);
    if (path === "/api/submit"             && m === "POST") return handleSubmit(request, env);
    if (path === "/api/queue"              && m === "GET")  return handleQueue(request, env);
    if (path === "/api/analyze-submission" && m === "POST") return handleAnalyzeSubmission(request, env);
    if (path === "/api/update-status"      && m === "POST") return handleUpdateStatus(request, env);
    if (path === "/api/notify"             && m === "POST") return handleNotify(request, env);

    return env.ASSETS.fetch(request);
  },
};

// ── shared analysis core ─────────────────────────────────────────────────────
async function runAnalysis({ jobProfile, resumeText, resumePdf }, env) {
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

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type":      "application/json",
      "x-api-key":         env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 4000,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content }],
    }),
  });

  const data = await r.json();
  if (!r.ok) return { error: data?.error?.message || `Anthropic ${r.status}` };

  const text  = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return { analysis: JSON.parse(clean), model: data.model, usage: data.usage };
  } catch {
    return { raw: text, model: data.model, usage: data.usage };
  }
}

// ── POST /api/analyze ─────────────────────────────────────────────────────────
async function handleAnalyze(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY not configured." }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  const { jobProfile, resumeText, resumePdf } = body;
  if (!resumePdf && (!resumeText || resumeText.trim().length < 40))
    return json({ error: "Paste a resume or upload a PDF — it looks empty." }, 400);
  if (!jobProfile?.mustHaves)
    return json({ error: "Fill out the Job Context Profile first." }, 400);
  return json(await runAnalysis({ jobProfile, resumeText, resumePdf }, env));
}

// ── POST /api/submit ──────────────────────────────────────────────────────────
async function handleSubmit(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  const { name, email, role, company, resumePdf, resumeText } = body;
  if (!name?.trim())  return json({ error: "Name is required." }, 400);
  if (!email?.trim()) return json({ error: "Email is required." }, 400);
  if (!resumePdf && !resumeText?.trim()) return json({ error: "Resume is required." }, 400);

  const id       = crypto.randomUUID();
  const roleSlug = (role || "general").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const submission = {
    id,
    name: name.trim(), email: email.trim(),
    role: role || "General", company: company || "",
    resumePdf:  resumePdf  || null,
    resumeText: resumeText || null,
    submittedAt: Date.now(),
    status: "pending",
    analysis: null,
  };

  await env.STORE.put(`submission:${id}`, JSON.stringify(submission));

  // Update role index (newest first, capped at 500)
  const indexKey = `index:${roleSlug}`;
  const existing = await env.STORE.get(indexKey);
  const ids = existing ? JSON.parse(existing) : [];
  ids.unshift(id);
  await env.STORE.put(indexKey, JSON.stringify(ids.slice(0, 500)));

  return json({ success: true, id });
}

// ── GET /api/queue?role= ──────────────────────────────────────────────────────
async function handleQueue(request, env) {
  const url      = new URL(request.url);
  const role     = url.searchParams.get("role") || "general";
  const roleSlug = role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const existing = await env.STORE.get(`index:${roleSlug}`);
  const ids      = existing ? JSON.parse(existing) : [];

  const submissions = (await Promise.all(
    ids.slice(0, 50).map(async id => {
      const raw = await env.STORE.get(`submission:${id}`);
      if (!raw) return null;
      const s = JSON.parse(raw);
      // Never return the raw resume in the list — too heavy
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
    })
  )).filter(Boolean);

  return json({ role, total: submissions.length, submissions });
}

// ── POST /api/analyze-submission ─────────────────────────────────────────────
async function handleAnalyzeSubmission(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY not configured." }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  const { id, jobProfile } = body;
  if (!id)                  return json({ error: "Submission id required." }, 400);
  if (!jobProfile?.mustHaves) return json({ error: "Job profile (with must-haves) required." }, 400);

  const raw = await env.STORE.get(`submission:${id}`);
  if (!raw) return json({ error: "Submission not found." }, 404);

  const sub = JSON.parse(raw);
  sub.status = "analyzing";
  await env.STORE.put(`submission:${id}`, JSON.stringify(sub));

  const result = await runAnalysis({
    jobProfile,
    resumePdf:  sub.resumePdf,
    resumeText: sub.resumeText,
  }, env);

  if (result.analysis) {
    sub.analysis = result.analysis;
    sub.status   = "reviewed";
  } else {
    sub.status = "pending"; // reset on failure
  }
  await env.STORE.put(`submission:${id}`, JSON.stringify(sub));

  return json(result);
}

// ── POST /api/update-status ───────────────────────────────────────────────────
async function handleUpdateStatus(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  const { id, status } = body;
  if (!id || !status) return json({ error: "id and status required." }, 400);

  const raw = await env.STORE.get(`submission:${id}`);
  if (!raw) return json({ error: "Submission not found." }, 404);

  const sub = JSON.parse(raw);
  sub.status = status;
  await env.STORE.put(`submission:${id}`, JSON.stringify(sub));
  return json({ success: true });
}

// ── POST /api/notify ──────────────────────────────────────────────────────────
async function handleNotify(request, env) {
  if (!env.RESEND_API_KEY)
    return json({ error: "RESEND_API_KEY not set. Get a free key at resend.com." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  const { to, subject, html, text } = body;
  if (!to || !subject) return json({ error: "to and subject are required." }, 400);

  const from = env.RESEND_FROM || "VETA <onboarding@resend.dev>";
  const r    = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body:    JSON.stringify({ from, to: [to], subject, html, text }),
  });

  const d = await r.json();
  if (!r.ok) return json({ error: d.message || "Email delivery failed." }, 502);
  return json({ success: true, id: d.id });
}
