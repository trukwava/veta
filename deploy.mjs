#!/usr/bin/env node
// deploy.mjs — deploy VETA to app.withzero.ai (Cloudflare Workers)
// Run: node deploy.mjs
// Cost: $0.20 USDC (paid via Zero wallet)
//
// Required before running:
//   1. ANTHROPIC_API_KEY in your .env file
//   2. RESEND_API_KEY (free at resend.com) — optional; email won't work without it
//   3. Zero CLI funded with at least $0.20 USDC

import { readFileSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));

// Load .env manually (dotenv isn't needed at deploy time)
let envVars = {};
try {
  const raw = readFileSync(join(__dir, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) envVars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {
  console.log("No .env file found — reading keys from process.env only.");
}

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || envVars.ANTHROPIC_API_KEY || "";
const RESEND_KEY    = process.env.RESEND_API_KEY    || envVars.RESEND_API_KEY    || "";

if (!ANTHROPIC_KEY || ANTHROPIC_KEY.includes("your-key-here")) {
  console.error("\n⚠  ANTHROPIC_API_KEY is missing or still a placeholder.");
  console.error("   Add it to .env or set it as an environment variable, then re-run.\n");
  process.exit(1);
}

if (!RESEND_KEY) {
  console.log("\nℹ  RESEND_API_KEY not found — email notifications will be disabled.");
  console.log("   Get a free key at https://resend.com and add it to .env.\n");
}

// Read source files
const workerSrc    = readFileSync(join(__dir, "worker.js"),        "utf8");
const promptSrc    = readFileSync(join(__dir, "system_prompt.js"),  "utf8");
const indexHtml    = readFileSync(join(__dir, "public/index.html"), "utf8");
const applyHtml    = readFileSync(join(__dir, "public/apply.html"), "utf8");
const indexBase64  = Buffer.from(indexHtml).toString("base64");
const applyBase64  = Buffer.from(applyHtml).toString("base64");

const secrets = { ANTHROPIC_API_KEY: ANTHROPIC_KEY };
if (RESEND_KEY) secrets.RESEND_API_KEY = RESEND_KEY;

const payload = {
  source: "prebuilt",
  slug: "veta-hire",
  mainModule: "worker.js",
  description: "VETA — reads resumes as stories, screens for real knowledge",
  modules: [
    { name: "worker.js",       type: "esm", content: workerSrc },
    { name: "system_prompt.js", type: "esm", content: promptSrc },
  ],
  assets: {
    files: [
      { path: "index.html", contentBase64: indexBase64 },
      { path: "apply.html", contentBase64: applyBase64 },
    ],
  },
  secrets,
};

console.log("Deploying VETA to app.withzero.ai...");
console.log(`  Worker modules : worker.js + system_prompt.js`);
console.log(`  Static assets  : index.html`);
console.log(`  Secrets set    : ${Object.keys(secrets).join(", ")}`);
console.log(`  Cost           : $0.20 USDC\n`);

const proc = spawn("zero", [
  "fetch",
  "https://app.withzero.ai/_admin/deploy",
  "--data-stdin",
  "--json",
]);

let stdout = "";
let stderr = "";

proc.stdout.on("data", (d) => (stdout += d));
proc.stderr.on("data", (d) => (stderr += d));
proc.stdin.write(JSON.stringify(payload));
proc.stdin.end();

proc.on("close", async (code) => {
  if (stderr) process.stderr.write(stderr);

  if (code !== 0) {
    console.error(`\n✗ Deploy failed (exit code ${code})`);
    process.exit(1);
  }

  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    console.error("\n✗ Could not parse deploy response:\n", stdout);
    process.exit(1);
  }

  // Transient infra failure — retry free using the credit already issued
  if (!result.ok && JSON.stringify(result.body).includes("timeout")) {
    console.log("\n⚠  Transient timeout on Zero's end — retrying free (payment already settled)...\n");
    const retryPayload = { ...payload, slug: payload.slug };
    const retry = spawn("zero", [
      "fetch",
      "https://app.withzero.ai/_admin/deploy/retry",
      "--data-stdin",
      "--json",
    ]);
    let rs = "";
    retry.stdout.on("data", (d) => (rs += d));
    retry.stdin.write(JSON.stringify(retryPayload));
    retry.stdin.end();
    retry.on("close", () => {
      try { result = JSON.parse(rs); } catch { /* fall through */ }
      if (result?.ok) {
        printSuccess(result.body);
      } else {
        console.error("✗ Retry also failed:");
        console.error(JSON.stringify(result?.body, null, 2));
        process.exit(1);
      }
    });
    return;
  }

  if (!result.ok) {
    console.error("\n✗ Deploy was not successful:");
    console.error(JSON.stringify(result.body, null, 2));
    process.exit(1);
  }

  printSuccess(result.body);
});

proc.on("error", (err) => {
  console.error("\n✗ Could not run zero CLI:", err.message);
  console.error("   Make sure zero is installed and funded.");
  process.exit(1);
});

function printSuccess(body) {
  console.log("\n✓ VETA is live!\n");
  console.log(`  URL      : ${body.url}`);
  console.log(`  Slug     : ${body.slug}`);
  console.log(`  Expires  : ${new Date(body.expires_at).toLocaleDateString()}`);
  console.log(`  Model    : claude-sonnet-4-6`);
  if (!RESEND_KEY) {
    console.log(`\n  Next: add RESEND_API_KEY to enable email notifications.`);
    console.log(`        Get a free key at https://resend.com`);
  }
  console.log("");
}
