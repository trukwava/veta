# Humane Hire

An Interview Intelligence Partner that reads resumes as stories — scoring people against a real job context and arming hiring managers with probing, human questions instead of ATS keyword filters.

Built with: Node + Express + one real API call to Claude (`claude-fable-5`).

## What's in here

```
humane-hire/
├── server.js          ← Express server; the ONE tool that calls the Anthropic API
├── system_prompt.js   ← your agent's brain (the 7-block reasoning engine)
├── public/
│   └── index.html     ← the whole UI (job profile → resume → dossier)
├── package.json
├── .env.example       ← copy to .env, add your key
└── README.md
```

## Setup (5 minutes)

Requires Node 18 or newer (`node --version` to check).

```bash
# 1. from inside the humane-hire folder:
npm install

# 2. create your env file
cp .env.example .env        # (Windows: copy .env.example .env)

# 3. open .env and paste your Anthropic API key
#    Get one at https://console.anthropic.com → Settings → API keys
#    (API keys are separate from a Claude.ai subscription — you may need
#     to add a small amount of credit to the console account.)

# 4. run it
npm start

# 5. open http://localhost:3000
```

## First test run (matches your testing checklist)

1. Fill "The Job" with your carpentry example — must-have: `C-style corners`.
2. Paste a resume that mentions carpentry AND AI building.
3. Confirm the dossier: (a) scores the direct match, (b) generates a probing
   question about the carpenter+AI combination, (c) if the resume has a gap,
   shows labeled story *hypotheses* plus one warm question — with no score penalty.

## Switching models

You said "use Fable until I can't" — that's one line in `.env`:

```
ANTHROPIC_MODEL=claude-fable-5      # most capable
ANTHROPIC_MODEL=claude-sonnet-4-6   # cheaper/faster fallback
```

No code changes needed.

## Where each bootcamp goal lives

- **"System prompt in your agent"** → `system_prompt.js` (passed as the `system` parameter in `server.js`)
- **"One tool calls a real API and returns real data"** → `POST /api/analyze` in `server.js` → `https://api.anthropic.com/v1/messages`

## Never do this

Do not move the API call into `index.html` / browser code. The key must stay
in `.env` on the server. Frontend code is visible to anyone; keys in it get
stolen and billed to you.

## Docs

- Anthropic API overview: https://docs.claude.com/en/api/overview
- Messages endpoint reference lives in the docs above — check it if a request errors.

## Ideas for session two

- PDF resume upload (the API accepts PDFs as base64 `document` blocks)
- Save/compare multiple candidates side by side (same rubric, same order)
- A "bias guardrail" test button that tries a forbidden filter and shows the refusal
