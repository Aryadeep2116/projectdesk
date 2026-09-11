# ProjectDesk

Find your next resume-worthy project — personalized to your target role, skills, and goals. Free AI-powered project recommendations, plus a premium flagship project + skill roadmap for students who want to go further.

**Live site:** https://Aryadeep2116.github.io/projectdesk/

## How it works

- `index.html` — the main frontend. Static HTML/CSS/JS, no build step, no framework.
- `admin.html` — private dashboard to view waitlist signups, accounts, login activity, and to top up credits for a specific account (password protected). Not linked from the main site.
- `worker/worker.js` — Cloudflare Worker backend. Handles:
  - Generating personalized project ideas via Cloudflare Workers AI (free, no API key needed)
  - Storing premium waitlist signups in Cloudflare KV

## Architecture

```
Browser (GitHub Pages)
   │
   ├── POST /  { role, skills, ... }        → generates project ideas
   └── POST /  { action: "waitlist", ... }   → saves signup to KV
   │
   ▼
Cloudflare Worker (projectdesk-api)
   │
   ├── Workers AI  → @cf/meta/llama-3.3-70b-instruct-fp8-fast
   └── KV Namespace → WAITLIST
```

## Setup

1. Deploy `worker/worker.js` as a Cloudflare Worker
2. Add bindings: `AI` (Workers AI) and `WAITLIST` (KV Namespace)
3. Add secret: `ADMIN_PASSWORD`
4. Update `WORKER_URL` constant in `index.html` and `admin.html` to your deployed Worker URL
5. Push to GitHub, enable GitHub Pages (Settings → Pages → main branch → root)

> Redeploy the Worker whenever `worker/worker.js` changes — the static pages and the API have to be in sync. The admin panel's **Credit boosts** section, for example, calls an `admin_set_credits` action that only exists in the current Worker.

## Credits

Every account gets a plan allowance each 30-day cycle (360 free, 1000 premium); generating ideas costs 120 and a detailed guide costs 200. The admin panel's **Credit boosts** tab can add credits to one specific account — the extra is stored as `bonusCredits` on that user and is added on top of the plan allowance on every reset, so the boost keeps working in later cycles. Use *Set balance to* to correct a mistake or take credits back.

## Stack

- Frontend: vanilla HTML/CSS/JS, no dependencies
- Backend: Cloudflare Workers (serverless, free tier)
- AI: Cloudflare Workers AI (free tier)
- Storage: Cloudflare KV (free tier)
- Hosting: GitHub Pages (free)

## Roadmap

- [ ] Rate limiting on the Worker to prevent abuse
- [ ] Real payment integration for Premium tier
- [ ] Course content for flagship project skill roadmaps
