// BuildItUp backend — Cloudflare Worker (FREE version using Workers AI)
// No API key, no billing, no credit card. Uses Cloudflare's free built-in AI models.

const ALLOWED_ORIGINS = [
  "https://aryadeep2116.github.io",
  "https://builditup.dpdns.org",
];

function corsHeaders(request) {
  const origin = request && request.headers.get("Origin");
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// Simple fixed-window rate limiter using KV.
// Limits a given IP to `limit` requests per `windowSeconds`.
async function isRateLimited(env, ip, bucket, limit, windowSeconds) {
  const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `ratelimit:${bucket}:${ip}:${windowId}`;
  const current = await env.WAITLIST.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= limit) {
    return true;
  }

  await env.WAITLIST.put(key, String(count + 1), { expirationTtl: windowSeconds + 5 });
  return false;
}

// Generates a short, URL-safe random ID for shareable result links.
function generateId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Generates a 6-digit numeric OTP.
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Sends an email via Resend's API. Requires env.RESEND_API_KEY and env.RESEND_FROM
// (a sender address on a domain you've verified with Resend) to be configured as
// Cloudflare secrets/vars. Until those are set, this throws — callers should catch it.
async function sendOtpEmail(env, toEmail, name, otp) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
    throw new Error("Email not configured yet: set RESEND_API_KEY and RESEND_FROM secrets once you have a verified domain.");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [toEmail],
      subject: `Your BuildItUp login code: ${otp}`,
      text: `Hi ${name || "there"},\n\nYour BuildItUp login code is: ${otp}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend API error: ${res.status} ${detail.slice(0, 200)}`);
  }
}

// Looks up a session token and returns { email, name } or null if invalid/expired.
async function getSession(env, token) {
  if (!token || typeof token !== "string") return null;
  const stored = await env.WAITLIST.get(`session:${token}`);
  if (!stored) return null;
  try { return JSON.parse(stored); } catch (e) { return null; }
}

// --- CREDITS SYSTEM ---
// Free plan gets 360 credits per 30-day cycle. Generating the 4 project ideas
// costs 120 credits; generating one detailed guide costs 200. That leaves a
// little headroom (40) per cycle. Premium credits/features are still TBD.
const FREE_PLAN_CREDITS = 360;
const PREMIUM_PLAN_CREDITS = 1000; // placeholder — revisit once premium plan is defined
const IDEA_GEN_COST = 120;
const GUIDE_GEN_COST = 200;
const CREDIT_CYCLE_MS = 30 * 24 * 60 * 60 * 1000;

async function getUser(env, email) {
  const stored = await env.WAITLIST.get(`user:${email.toLowerCase()}`);
  return stored ? JSON.parse(stored) : null;
}
async function saveUser(env, userRecord) {
  await env.WAITLIST.put(`user:${userRecord.email}`, JSON.stringify(userRecord));
}

// Resets a user's credits if their 30-day cycle has elapsed (or if they've
// never had one, e.g. accounts created before credits existed). Mutates and
// returns the record; caller is responsible for saving it back.
function refreshCredits(userRecord) {
  const now = Date.now();
  const resetDue = !userRecord.creditsResetAt || now >= new Date(userRecord.creditsResetAt).getTime();
  if (resetDue) {
    userRecord.credits = userRecord.plan === "premium" ? PREMIUM_PLAN_CREDITS : FREE_PLAN_CREDITS;
    userRecord.creditsResetAt = new Date(now + CREDIT_CYCLE_MS).toISOString();
  }
  if (!userRecord.plan) userRecord.plan = "free";
  if (!Array.isArray(userRecord.usedGuides)) userRecord.usedGuides = [];
  return userRecord;
}

// --- PASSWORD HASHING (PBKDF2 via Web Crypto, no external deps) ---
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}
async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}

// Parses an AI JSON response, handling both pre-parsed objects and raw text
// (with markdown fences, stray preamble, or trailing commas to clean up).
function parseAiJson(aiResponse) {
  if (aiResponse.response && typeof aiResponse.response === "object") {
    return aiResponse.response;
  }
  const text = aiResponse.response || "";
  let clean = text.replace(/```json|```/g, "").trim();
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  clean = clean.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(clean);
  } catch (e) {
    const repaired = clean.replace(/,(\s*[\]}])/g, "$1");
    return JSON.parse(repaired);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(request) });
    }


    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    try {
      const body = await request.json();

      // --- JSON response helper (DRY) ---
function jsonResp(request, body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}

// --- EMAIL HELPER (Resend API + console.log fallback) ---
async function sendEmail(env, to, template, data) {
  const templates = {
    verify: {
      subject: 'Verify your BuildItUp email',
      text: `Hi ${data.name},\n\nWelcome to BuildItUp. Verify your email to unlock the full tool:\n\n${data.link}\n\nThis link expires in 24 hours.\n\n— BuildItUp`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
        <p>Hi ${data.name},</p>
        <p>Welcome to BuildItUp. Verify your email to unlock the full tool:</p>
        <p><a href="${data.link}">${data.link}</a></p>
        <p style="color:#666;font-size:13px;">This link expires in 24 hours.</p>
        <p style="color:#666;font-size:13px;">— BuildItUp</p>
      </div>`,
    },
    magic: {
      subject: 'Your BuildItUp sign-in link',
      text: `Hi ${data.name},\n\nUse this link to sign in to BuildItUp:\n\n${data.link}\n\nThis link expires in 15 minutes. If you didn't request this, you can ignore this email.\n\n— BuildItUp`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
        <p>Hi ${data.name},</p>
        <p>Use this link to sign in to BuildItUp:</p>
        <p><a href="${data.link}">${data.link}</a></p>
        <p style="color:#666;font-size:13px;">This link expires in 15 minutes. If you didn't request this, you can ignore this email.</p>
        <p style="color:#666;font-size:13px;">— BuildItUp</p>
      </div>`,
    },
    reset: {
      subject: 'Reset your BuildItUp password',
      text: `Hi ${data.name},\n\nUse this link to set a new password for your BuildItUp account:\n\n${data.link}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email.\n\n— BuildItUp`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
        <p>Hi ${data.name},</p>
        <p>Use this link to set a new password for your BuildItUp account:</p>
        <p><a href="${data.link}">${data.link}</a></p>
        <p style="color:#666;font-size:13px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
        <p style="color:#666;font-size:13px;">— BuildItUp</p>
      </div>`,
    },
  };
  const tpl = templates[template];
  if (!tpl) return false;
  // Try Resend first (free tier: 100/day). Falls back to console.log if not configured.
  if (env.RESEND_API_KEY && env.RESEND_FROM) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.RESEND_FROM,
          to: [to],
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
        }),
      });
      if (res.ok) return true;
      const detail = await res.text();
      console.log('Resend send failed:', res.status, detail.slice(0, 200));
    } catch (e) {
      console.log('Resend send threw:', e.message);
    }
  }
  // Fallback: log so dev can see the link
  console.log('--- [EMAIL FALLBACK] ---');
  console.log('to:', to);
  console.log('subject:', tpl.subject);
  console.log('data:', JSON.stringify(data));
  console.log('--- /EMAIL FALLBACK ---');
  return false;
}

// --- WAITLIST: save an email + context to KV ---
      if (body.action === "waitlist") {
        if (await isRateLimited(env, ip, "waitlist", 5, 3600)) {
          return new Response(JSON.stringify({ error: "Too many requests. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const { email, role, gap, dreamTarget, branch, skills } = body;
        if (!email || !email.includes("@") || email.length > 200) {
          return new Response(JSON.stringify({ error: "Valid email required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const entry = {
          email: String(email).slice(0, 200),
          role: String(role || "").slice(0, 200),
          gap: String(gap || "").slice(0, 500),
          dreamTarget: String(dreamTarget || "").slice(0, 200),
          branch: String(branch || "").slice(0, 200),
          skills: String(skills || "").slice(0, 500),
          ts: new Date().toISOString(),
        };
        const key = `waitlist:${Date.now()}:${email}`;
        await env.WAITLIST.put(key, JSON.stringify(entry));

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- TRACK: log a simple analytics event (landing view, CTA click, etc.) ---
      if (body.action === "track") {
        if (await isRateLimited(env, ip, "track", 60, 3600)) {
          return new Response(JSON.stringify({ error: "Too many requests." }), {
            status: 429,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const { type } = body;
        if (!type || typeof type !== "string" || type.length > 50) {
          return new Response(JSON.stringify({ error: "type required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const key = `event:${type}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        await env.WAITLIST.put(key, JSON.stringify({ type, ts: new Date().toISOString() }));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- SIGNUP: create an account with email + password ---
      if (body.action === "signup") {
        if (await isRateLimited(env, ip, "signup", 10, 3600)) {
          return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const { name, email, password } = body;
        if (!name || !name.trim()) {
          return new Response(JSON.stringify({ error: "Name required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        if (!email || !email.includes("@") || email.length > 200) {
          return new Response(JSON.stringify({ error: "Valid email required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        if (!password || password.length < 8) {
          return new Response(JSON.stringify({ error: "Password must be at least 8 characters" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const userKey = `user:${email.toLowerCase()}`;
        const existing = await env.WAITLIST.get(userKey);
        if (existing) {
          return new Response(JSON.stringify({ error: "An account with this email already exists. Log in instead." }), {
            status: 409,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const { hash, salt } = await hashPassword(password);
        const userRecord = {
          name: String(name).slice(0, 100),
          email: email.toLowerCase(),
          hash,
          salt,
          ts: new Date().toISOString(),
          plan: "free",
          credits: FREE_PLAN_CREDITS,
          creditsResetAt: new Date(Date.now() + CREDIT_CYCLE_MS).toISOString(),
          usedGuides: [],
        };
        await env.WAITLIST.put(userKey, JSON.stringify(userRecord));

        const token = generateId();
        await env.WAITLIST.put(`session:${token}`, JSON.stringify({ email: userRecord.email, name: userRecord.name }), { expirationTtl: 60 * 60 * 24 * 30 });

        // Generate a verification token (single-use, 24h TTL)
        const verifyToken = generateId();
        await env.WAITLIST.put(`verify:${verifyToken}`, JSON.stringify({ email: userRecord.email }), { expirationTtl: 60 * 60 * 24 });
        // Send the verification email (best-effort)
        await sendEmail(env, userRecord.email, 'verify', {
          name: userRecord.name,
          link: `${env.PUBLIC_URL || 'https://builditup.dpdns.org'}/app.html?verify=${verifyToken}`
        }).catch(() => {});

        return new Response(JSON.stringify({ ok: true, token, name: userRecord.name, email: userRecord.email, emailVerified: false }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- LOGIN: verify email + password ---
      if (body.action === "login") {
        if (await isRateLimited(env, ip, "login", 15, 3600)) {
          return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const { email, password } = body;
        if (!email || !password) {
          return new Response(JSON.stringify({ error: "Email and password required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const userKey = `user:${email.toLowerCase()}`;
        const stored = await env.WAITLIST.get(userKey);
        if (!stored) {
          return new Response(JSON.stringify({ error: "Invalid email or password." }), {
            status: 401,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const userRecord = JSON.parse(stored);
        const { hash } = await hashPassword(password, userRecord.salt);
        if (hash !== userRecord.hash) {
          return new Response(JSON.stringify({ error: "Invalid email or password." }), {
            status: 401,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const token = generateId();
        await env.WAITLIST.put(`session:${token}`, JSON.stringify({ email: userRecord.email, name: userRecord.name }), { expirationTtl: 60 * 60 * 24 * 30 });

        return new Response(JSON.stringify({ ok: true, token, name: userRecord.name, email: userRecord.email, emailVerified: userRecord.emailVerified !== false }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- REQUEST_OTP: generate a 6-digit code and email it ---
      if (body.action === "request_otp") {
        if (await isRateLimited(env, ip, "request_otp", 5, 3600)) {
          return new Response(JSON.stringify({ error: "Too many code requests. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const { name, email } = body;
        if (!email || !email.includes("@") || email.length > 200) {
          return new Response(JSON.stringify({ error: "Valid email required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        if (!name || !name.trim()) {
          return new Response(JSON.stringify({ error: "Name required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        // Per-email limit too, so one IP can't spam many addresses and one address
        // can't be spammed via a different IP.
        if (await isRateLimited(env, email.toLowerCase(), "request_otp_email", 5, 3600)) {
          return new Response(JSON.stringify({ error: "Too many code requests for this email. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const otp = generateOtp();
        const safeName = String(name).slice(0, 100);
        await env.WAITLIST.put(
          `otp:${email.toLowerCase()}`,
          JSON.stringify({ otp, name: safeName, ts: new Date().toISOString() }),
          { expirationTtl: 600 } // 10 minutes
        );

        try {
          await sendOtpEmail(env, email, safeName, otp);
        } catch (e) {
          return new Response(JSON.stringify({ error: "Could not send email.", detail: String(e.message || e) }), {
            status: 500,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- VERIFY_OTP: check the code, issue a session token ---
      if (body.action === "verify_otp") {
        if (await isRateLimited(env, ip, "verify_otp", 20, 3600)) {
          return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const { email, otp } = body;
        if (!email || !otp) {
          return new Response(JSON.stringify({ error: "Email and code required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const key = `otp:${email.toLowerCase()}`;
        const stored = await env.WAITLIST.get(key);
        if (!stored) {
          return new Response(JSON.stringify({ error: "Code expired or not found. Request a new one." }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const record = JSON.parse(stored);
        if (String(otp).trim() !== record.otp) {
          return new Response(JSON.stringify({ error: "Incorrect code." }), {
            status: 401,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        await env.WAITLIST.delete(key); // one-time use

        const token = generateId();
        await env.WAITLIST.put(
          `session:${token}`,
          JSON.stringify({ email: email.toLowerCase(), name: record.name }),
          { expirationTtl: 60 * 60 * 24 * 30 } // 30 days
        );

        return new Response(JSON.stringify({ ok: true, token, name: record.name, email: email.toLowerCase() }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- VALIDATE_SESSION: check a stored token is still good (auto-login) ---
      if (body.action === "validate_session") {
        const session = await getSession(env, body.token);
        if (!session) {
          return new Response(JSON.stringify({ error: "Session expired or invalid." }), {
            status: 401,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const userRecord = JSON.parse(await env.WAITLIST.get(`user:${session.email}`) || 'null');
        return new Response(JSON.stringify({ ok: true, ...session, emailVerified: userRecord ? userRecord.emailVerified !== false : true }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- GET_DASHBOARD: everything the dashboard page needs in one call ---
      if (body.action === "get_dashboard") {
        const session = await getSession(env, body.token);
        if (!session) {
          return new Response(JSON.stringify({ error: "Not logged in." }), {
            status: 401,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        let userRecord = await getUser(env, session.email);
        if (!userRecord) {
          return new Response(JSON.stringify({ error: "Account not found." }), {
            status: 404,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const beforeReset = userRecord.creditsResetAt;
        userRecord = refreshCredits(userRecord);
        if (userRecord.creditsResetAt !== beforeReset) {
          await saveUser(env, userRecord); // persist a reset that just happened
        }

        // Overview: every idea-set they've generated/saved.
        const indexKey = `user_results:${session.email}`;
        const stored = await env.WAITLIST.get(indexKey);
        const ids = stored ? JSON.parse(stored) : [];
        const results = await Promise.all(
          ids.map(async (id) => {
            const r = await env.WAITLIST.get(`result:${id}`);
            if (!r) return null;
            const parsed = JSON.parse(r);
            return { id: parsed.id, greeting: parsed.greeting, ts: parsed.ts, roleTitle: (parsed.inputs && parsed.inputs.role) || "" };
          })
        );

        // The one project they've used this cycle's credit on (most recent, if any).
        const latestUsed = userRecord.usedGuides.length ? userRecord.usedGuides[userRecord.usedGuides.length - 1] : null;
        let latestGuide = null;
        if (latestUsed) {
          const g = await env.WAITLIST.get(`guide:${latestUsed.resultId}:${latestUsed.ideaKey}`);
          if (g) latestGuide = JSON.parse(g);
        }

        return new Response(JSON.stringify({
          ok: true,
          name: userRecord.name,
          email: userRecord.email,
          plan: userRecord.plan,
          premiumMode: userRecord.premiumMode || null,
          premiumUntil: userRecord.premiumUntil || null,
          cancelled: !!userRecord.cancelledAt,
          credits: userRecord.credits,
          creditsResetAt: userRecord.creditsResetAt,
          emailVerified: userRecord.emailVerified !== false,
          results: results.filter(Boolean).reverse(),
          latestGuide,
        }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- GET_USER_RESULTS: list all saved results tied to the logged-in user ---
      if (body.action === "get_user_results") {
        const session = await getSession(env, body.token);
        if (!session) {
          return new Response(JSON.stringify({ error: "Not logged in." }), {
            status: 401,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const indexKey = `user_results:${session.email}`;
        const stored = await env.WAITLIST.get(indexKey);
        const ids = stored ? JSON.parse(stored) : [];

        const results = await Promise.all(
          ids.map(async (id) => {
            const r = await env.WAITLIST.get(`result:${id}`);
            if (!r) return null;
            const parsed = JSON.parse(r);
            return { id: parsed.id, greeting: parsed.greeting, ts: parsed.ts, roleTitle: (parsed.inputs && parsed.inputs.role) || "" };
          })
        );

        return new Response(JSON.stringify({ ok: true, results: results.filter(Boolean).reverse() }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- GENERATE_GUIDE: elaborate step-by-step plan for one chosen project (login required) ---
      if (body.action === "generate_guide") {
        const session = await getSession(env, body.token);
        if (!session) {
          return new Response(JSON.stringify({ error: "Log in to unlock the full step-by-step guide." }), {
            status: 401,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        if (await isRateLimited(env, session.email, "generate_guide", 15, 3600)) {
          return new Response(JSON.stringify({ error: "Too many guide requests. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const { resultId, ideaKey } = body; // ideaKey: "flagship" or "0".."3"
        if (!resultId || !ideaKey) {
          return new Response(JSON.stringify({ error: "resultId and ideaKey required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const guideKey = `guide:${resultId}:${ideaKey}`;

        // Return the cached guide if we've already generated one — saves AI calls
        // and, importantly, does NOT cost a credit (viewing is free, generating isn't).
        const existing = await env.WAITLIST.get(guideKey);
        if (existing) {
          return new Response(existing, { headers: { ...corsHeaders(request), "Content-Type": "application/json" } });
        }

        // This is a brand-new guide — check credits before spending an AI call.
        let userRecord = await getUser(env, session.email);
        if (!userRecord) {
          return new Response(JSON.stringify({ error: "Account not found." }), {
            status: 404,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        userRecord = refreshCredits(userRecord);
        if (userRecord.credits < GUIDE_GEN_COST) {
          await saveUser(env, userRecord); // persist any reset that just happened
          return new Response(JSON.stringify({
            error: `You need ${GUIDE_GEN_COST} credits for a detailed guide — you have ${userRecord.credits}.`,
            creditsResetAt: userRecord.creditsResetAt,
          }), {
            status: 402,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const resultStored = await env.WAITLIST.get(`result:${resultId}`);
        if (!resultStored) {
          return new Response(JSON.stringify({ error: "Original result not found." }), {
            status: 404,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const resultRecord = JSON.parse(resultStored);
        const project = ideaKey === "flagship" ? resultRecord.flagship : resultRecord.ideas[parseInt(ideaKey, 10)];
        if (!project) {
          return new Response(JSON.stringify({ error: "Project not found in this result." }), {
            status: 404,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const inputs = resultRecord.inputs || {};

        const guidePrompt = `You are a hands-on technical mentor writing a build guide for someone who has NEVER built this specific type of project before — assume zero prior knowledge of this exact stack, even if they have some general coding background. Do not skip foundational concepts. Someone who knows nothing about this kind of project should be able to follow this guide from the very first step and end up with something genuinely production-aware by the end.

Project: ${project.title}
Why it matters: ${project.hook || project.why || ""}
Target role: ${inputs.role || "not specified"}
Their current skills: ${inputs.skills || "not specified"}
Time available: ${inputs.time || "not specified"}

Write FOUR things:

1. ARCHITECTURE DIAGRAM DATA — model the actual system as a graph of components (nodes) and connections (edges), the way a real architecture diagram would show it (e.g. Browser → Frontend App → API Server → Database, plus any external services, caches, queues). This will be rendered as a visual diagram, so be concrete and specific to this exact project, not generic. 4-9 nodes is typical. Every edge needs a short label describing what flows across it (e.g. "HTTP request", "reads/writes rows", "auth token").

2. A plain-language architecture summary (2-4 sentences) explaining how those pieces work together, written so a total beginner understands WHY the system is shaped this way.

3. A skills breakdown ordered from foundational to advanced. Each skill needs a one-line reason tied to this specific project, and a "level" of either "foundational", "core", or "advanced" so the reader knows what's a prerequisite versus a stretch goal.

4. A phased, step-by-step build plan that genuinely starts from zero and ends at advanced/production-aware. Structure it as:
   - Early phases: absolute basics — environment setup, core concepts explained simply, a minimal working version.
   - Middle phases: building out the real features of this specific project.
   - Late phases: the advanced/production concerns — error handling, testing, security basics, deployment, and one "if you want to go further" stretch idea.
   Each step must be a specific, actionable task with enough explanation that a beginner understands not just WHAT to do but WHY (not "build the backend" but "set up an Express server with a /api/tasks route that returns JSON — this is the endpoint your frontend will call to list tasks").

Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact structure:
{
  "architecture_diagram": {
    "nodes": [
      { "id": "short_id", "label": "Human-readable name", "type": "client" }
    ],
    "edges": [
      { "from": "short_id", "to": "short_id", "label": "what flows across this connection" }
    ]
  },
  "architecture": "2-4 sentence plain-language summary of how the system fits together, beginner-friendly",
  "skills": [
    { "name": "skill name", "why": "1 sentence on why this specific project needs it", "level": "foundational" }
  ],
  "phases": [
    {
      "title": "short phase name",
      "description": "1 sentence on what this phase accomplishes",
      "steps": [
        { "title": "short step name", "detail": "2-3 sentences of specific, actionable guidance explaining what to do and why it matters" }
      ]
    }
  ]
}

Valid values for a node's "type" field: "client", "server", "database", "external", "storage", "queue", "other". Use whichever fits each component.`;

        let aiResponse;
        try {
          aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            messages: [
              { role: "system", content: "You are a helpful assistant that responds only with valid JSON, no markdown, no commentary." },
              { role: "user", content: guidePrompt },
            ],
            max_tokens: 3200,
            response_format: {
              type: "json_schema",
              json_schema: {
                type: "object",
                properties: {
                  architecture_diagram: {
                    type: "object",
                    properties: {
                      nodes: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: { id: { type: "string" }, label: { type: "string" }, type: { type: "string" } },
                          required: ["id", "label", "type"],
                        },
                      },
                      edges: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } },
                          required: ["from", "to", "label"],
                        },
                      },
                    },
                    required: ["nodes", "edges"],
                  },
                  architecture: { type: "string" },
                  skills: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { name: { type: "string" }, why: { type: "string" }, level: { type: "string" } },
                      required: ["name", "why", "level"],
                    },
                  },
                  phases: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        title: { type: "string" },
                        description: { type: "string" },
                        steps: {
                          type: "array",
                          items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title", "detail"] },
                        },
                      },
                      required: ["title", "description", "steps"],
                    },
                  },
                },
                required: ["architecture_diagram", "architecture", "skills", "phases"],
              },
            },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: "Could not generate guide right now.", detail: String(e.message || e) }), {
            status: 500,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const guideParsed = parseAiJson(aiResponse);
        const guideRecord = {
          resultId,
          ideaKey,
          projectTitle: project.title,
          architectureDiagram: guideParsed.architecture_diagram,
          architecture: guideParsed.architecture,
          skills: guideParsed.skills,
          phases: guideParsed.phases,
          progress: {}, // { "phaseIdx-stepIdx": true }
          email: session.email,
          ts: new Date().toISOString(),
        };
        await env.WAITLIST.put(guideKey, JSON.stringify(guideRecord), { expirationTtl: 60 * 60 * 24 * 180 });

        // Charge the credit and log this as the cycle's used guide.
        userRecord.credits -= GUIDE_GEN_COST;
        userRecord.usedGuides.push({ resultId, ideaKey, projectTitle: project.title, ts: guideRecord.ts });
        await saveUser(env, userRecord);

        return new Response(JSON.stringify(guideRecord), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- GET_GUIDE: fetch an already-generated guide (login required) ---
      if (body.action === "get_guide") {
        const session = await getSession(env, body.token);
        if (!session) {
          return new Response(JSON.stringify({ error: "Log in to view this guide." }), {
            status: 401,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const { resultId, ideaKey } = body;
        if (!resultId || !ideaKey) {
          return new Response(JSON.stringify({ error: "resultId and ideaKey required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const stored = await env.WAITLIST.get(`guide:${resultId}:${ideaKey}`);
        if (!stored) {
          return new Response(JSON.stringify({ exists: false }), {
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        return new Response(stored, { headers: { ...corsHeaders(request), "Content-Type": "application/json" } });
      }

      // --- UPDATE_GUIDE_PROGRESS: toggle a step checked state on a guide (login required) ---
      if (body.action === "update_guide_progress") {
        const session = await getSession(env, body.token);
        if (!session) {
          return new Response(JSON.stringify({ error: "Log in to track progress." }), {
            status: 401,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const { resultId, ideaKey, stepId, completed } = body;
        if (!resultId || !ideaKey || !stepId) {
          return new Response(JSON.stringify({ error: "resultId, ideaKey and stepId required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const guideKey = `guide:${resultId}:${ideaKey}`;
        const stored = await env.WAITLIST.get(guideKey);
        if (!stored) {
          return new Response(JSON.stringify({ error: "Guide not found." }), {
            status: 404,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const guideRecord = JSON.parse(stored);
        guideRecord.progress = guideRecord.progress || {};
        guideRecord.progress[stepId] = !!completed;
        await env.WAITLIST.put(guideKey, JSON.stringify(guideRecord), { expirationTtl: 60 * 60 * 24 * 180 });

        return new Response(JSON.stringify({ ok: true, progress: guideRecord.progress }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- SAVE_RESULT: persist a generated result set so it can be shared/bookmarked ---
      if (body.action === "save_result") {
        if (await isRateLimited(env, ip, "save_result", 20, 3600)) {
          return new Response(JSON.stringify({ error: "Too many requests. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const { ideas, flagship, greeting, inputs, token } = body;
        if (!ideas || !flagship) {
          return new Response(JSON.stringify({ error: "ideas and flagship required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        // If logged in, tie this result to their account so it shows up in "my projects".
        let ownerEmail = null;
        if (token) {
          const session = await getSession(env, token);
          if (session) ownerEmail = session.email;
        }

        const id = generateId();
        const record = {
          id,
          greeting: String(greeting || "").slice(0, 300),
          ideas,
          flagship,
          inputs: inputs || {},
          progress: {}, // { [skillIndex]: true }
          email: ownerEmail,
          ts: new Date().toISOString(),
        };
        await env.WAITLIST.put(`result:${id}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 180 }); // 180 days

        if (ownerEmail) {
          const indexKey = `user_results:${ownerEmail}`;
          const stored = await env.WAITLIST.get(indexKey);
          const ids = stored ? JSON.parse(stored) : [];
          ids.push(id);
          await env.WAITLIST.put(indexKey, JSON.stringify(ids.slice(-50)), { expirationTtl: 60 * 60 * 24 * 365 }); // keep last 50
        }

        return new Response(JSON.stringify({ ok: true, id }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- GET_RESULT: fetch a previously saved result by id ---
      if (body.action === "get_result") {
        const { id } = body;
        if (!id || typeof id !== "string" || id.length > 64) {
          return new Response(JSON.stringify({ error: "Valid id required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const stored = await env.WAITLIST.get(`result:${id}`);
        if (!stored) {
          return new Response(JSON.stringify({ error: "Result not found. It may have expired." }), {
            status: 404,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        return new Response(stored, {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- UPDATE_PROGRESS: toggle a skill/step checked state on a saved result ---
      if (body.action === "update_progress") {
        if (await isRateLimited(env, ip, "update_progress", 120, 3600)) {
          return new Response(JSON.stringify({ error: "Too many requests." }), {
            status: 429,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        const { id, stepIndex, completed } = body;
        if (!id || typeof id !== "string" || typeof stepIndex !== "number") {
          return new Response(JSON.stringify({ error: "id and stepIndex required" }), {
            status: 400,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const key = `result:${id}`;
        const stored = await env.WAITLIST.get(key);
        if (!stored) {
          return new Response(JSON.stringify({ error: "Result not found." }), {
            status: 404,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const record = JSON.parse(stored);
        record.progress = record.progress || {};
        record.progress[stepIndex] = !!completed;
        await env.WAITLIST.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 180 });

        return new Response(JSON.stringify({ ok: true, progress: record.progress }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- ADMIN: view all waitlist entries (simple password check) ---
      if (body.action === "admin_view_waitlist") {
        if (await isRateLimited(env, ip, "admin", 20, 3600)) {
          return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }

        if (body.password !== env.ADMIN_PASSWORD) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          });
        }
        const list = await env.WAITLIST.list({ prefix: "waitlist:" });
        const entries = await Promise.all(
          list.keys.map(async (k) => JSON.parse(await env.WAITLIST.get(k.name)))
        );
        entries.sort((a, b) => new Date(b.ts) - new Date(a.ts));

        const eventList = await env.WAITLIST.list({ prefix: "event:" });
        const events = await Promise.all(
          eventList.keys.map(async (k) => JSON.parse(await env.WAITLIST.get(k.name)))
        );
        const eventCounts = {};
        events.forEach((e) => {
          eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
        });

        return new Response(JSON.stringify({ entries, eventCounts }), {
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // --- RESEND VERIFICATION EMAIL ---
      if (body.action === "resend_verification") {
        if (await isRateLimited(env, ip, "resend_verification", 5, 3600)) {
          return jsonResp(request, { error: "Too many requests. Try again later." }, 429);
        }
        const sess = await env.WAITLIST.get(`session:${body.token}`);
        if (!sess) return jsonResp(request, { error: "Session expired. Log in again." }, 401);
        const { email } = JSON.parse(sess);
        const userRecord = JSON.parse(await env.WAITLIST.get(`user:${email}`));
        if (!userRecord) return jsonResp(request, { error: "Account not found." }, 404);
        if (userRecord.emailVerified !== false) return jsonResp(request, { ok: true, message: "Already verified." });
        const verifyToken = generateId();
        await env.WAITLIST.put(`verify:${verifyToken}`, JSON.stringify({ email }), { expirationTtl: 60 * 60 * 24 });
        await sendEmail(env, email, 'verify', {
          name: userRecord.name,
          link: `${env.PUBLIC_URL || 'https://builditup.dpdns.org'}/app.html?verify=${verifyToken}`
        });
        return jsonResp(request, { ok: true });
      }
  
      // --- CONFIRM VERIFICATION (via ?verify=TOKEN URL) ---
      if (body.action === "confirm_verification") {
        const { token } = body;
        const stored = await env.WAITLIST.get(`verify:${token}`);
        if (!stored) return jsonResp(request, { error: "Verification link expired or already used." }, 400);
        const { email } = JSON.parse(stored);
        const userRecord = JSON.parse(await env.WAITLIST.get(`user:${email}`));
        userRecord.emailVerified = true;
        userRecord.emailVerifiedAt = new Date().toISOString();
        await env.WAITLIST.put(`user:${email}`, JSON.stringify(userRecord));
        await env.WAITLIST.delete(`verify:${token}`);
        return jsonResp(request, { ok: true, email });
      }
  
      // --- REQUEST MAGIC LINK (passwordless login) ---
      if (body.action === "request_magic_link") {
        if (await isRateLimited(env, ip, "request_magic_link", 5, 3600)) {
          return jsonResp(request, { error: "Too many requests. Try again later." }, 429);
        }
        const { email } = body;
        if (!email || !email.includes("@")) return jsonResp(request, { error: "Valid email required" }, 400);
        const userRecord = await env.WAITLIST.get(`user:${email.toLowerCase()}`);
        // Always return success to avoid email enumeration
        if (userRecord) {
          const u = JSON.parse(userRecord);
          const magicToken = generateId();
          await env.WAITLIST.put(`magic:${magicToken}`, JSON.stringify({ email: u.email }), { expirationTtl: 60 * 15 });
          await sendEmail(env, u.email, 'magic', {
            name: u.name,
            link: `${env.PUBLIC_URL || 'https://builditup.dpdns.org'}/app.html?magic=${magicToken}`
          }).catch(() => {});
        }
        return jsonResp(request, { ok: true });
      }
  
      // --- CONFIRM MAGIC LINK ---
      if (body.action === "confirm_magic_link") {
        const { token } = body;
        const stored = await env.WAITLIST.get(`magic:${token}`);
        if (!stored) return jsonResp(request, { error: "Magic link expired or already used." }, 400);
        const { email } = JSON.parse(stored);
        await env.WAITLIST.delete(`magic:${token}`);
        const userRecord = JSON.parse(await env.WAITLIST.get(`user:${email}`));
        if (!userRecord) return jsonResp(request, { error: "Account no longer exists." }, 404);
        const sessionToken = generateId();
        await env.WAITLIST.put(`session:${sessionToken}`, JSON.stringify({ email: userRecord.email, name: userRecord.name }), { expirationTtl: 60 * 60 * 24 * 30 });
        return jsonResp(request, { ok: true, token: sessionToken, name: userRecord.name, email: userRecord.email, emailVerified: userRecord.emailVerified !== false });
      }
  
      // --- REQUEST PASSWORD RESET ---
      if (body.action === "request_password_reset") {
        if (await isRateLimited(env, ip, "request_password_reset", 5, 3600)) {
          return jsonResp(request, { error: "Too many requests. Try again later." }, 429);
        }
        const { email } = body;
        if (!email || !email.includes("@")) return jsonResp(request, { error: "Valid email required" }, 400);
        const userRecord = await env.WAITLIST.get(`user:${email.toLowerCase()}`);
        // Always return success to avoid email enumeration
        if (userRecord) {
          const u = JSON.parse(userRecord);
          const resetToken = generateId();
          await env.WAITLIST.put(`reset:${resetToken}`, JSON.stringify({ email: u.email }), { expirationTtl: 60 * 60 });
          await sendEmail(env, u.email, 'reset', {
            name: u.name,
            link: `${env.PUBLIC_URL || 'https://builditup.dpdns.org'}/app.html?reset=${resetToken}`
          }).catch(() => {});
        }
        return jsonResp(request, { ok: true });
      }
  
      // --- CONFIRM PASSWORD RESET ---
      if (body.action === "confirm_password_reset") {
        const { token, password } = body;
        if (!token) return jsonResp(request, { error: "Missing reset token." }, 400);
        if (!password || password.length < 8) return jsonResp(request, { error: "Password must be at least 8 characters." }, 400);
        const stored = await env.WAITLIST.get(`reset:${token}`);
        if (!stored) return jsonResp(request, { error: "Reset link expired or already used." }, 400);
        const { email } = JSON.parse(stored);
        const userRecord = JSON.parse(await env.WAITLIST.get(`user:${email}`));
        if (!userRecord) return jsonResp(request, { error: "Account no longer exists." }, 404);
        const { hash, salt } = await hashPassword(password);
        userRecord.hash = hash;
        userRecord.salt = salt;
        userRecord.passwordResetAt = new Date().toISOString();
        await env.WAITLIST.put(`user:${email}`, JSON.stringify(userRecord));
        await env.WAITLIST.delete(`reset:${token}`);
        // Auto-login: issue a session
        const sessionToken = generateId();
        await env.WAITLIST.put(`session:${sessionToken}`, JSON.stringify({ email: userRecord.email, name: userRecord.name }), { expirationTtl: 60 * 60 * 24 * 30 });
        return jsonResp(request, { ok: true, token: sessionToken, name: userRecord.name, email: userRecord.email, emailVerified: userRecord.emailVerified !== false });
      }
  
      // --- SUBMIT PAYMENT (user pastes UTR) ---
      if (body.action === "submit_payment") {
        if (await isRateLimited(env, ip, "submit_payment", 10, 3600)) {
          return jsonResp(request, { error: "Too many submissions. Try again later." }, 429);
        }
        const sess = await env.WAITLIST.get(`session:${body.token}`);
        if (!sess) return jsonResp(request, { error: "Log in to submit a payment." }, 401);
        const { email } = JSON.parse(sess);
        const { utr, mode } = body;
        if (!utr || !/^[0-9A-Za-z]{6,32}$/.test(utr)) return jsonResp(request, { error: "Invalid UTR. Must be 6-32 alphanumeric characters." }, 400);
        const amount = mode === "annual" ? 2499 : 299;
        const id = generateId();
        const payment = {
          id,
          email,
          utr: String(utr),
          mode: mode === "annual" ? "annual" : "monthly",
          amount,
          status: "pending",
          ts: new Date().toISOString(),
        };
        // Store the payment under user's key + a global key
        await env.WAITLIST.put(`payment:${email}:${id}`, JSON.stringify(payment), { expirationTtl: 60 * 60 * 24 * 400 });
        await env.WAITLIST.put(`payment-lookup:${utr.toLowerCase()}`, JSON.stringify({ id, email }), { expirationTtl: 60 * 60 * 24 * 90 });
        return jsonResp(request, { ok: true, id, message: "Payment submitted. We'll review and flip your account to Pro shortly." });
      }
  
      // --- CANCEL SUBSCRIPTION ---
      if (body.action === "cancel_subscription") {
        const sess = await env.WAITLIST.get(`session:${body.token}`);
        if (!sess) return jsonResp(request, { error: "Log in to cancel." }, 401);
        const { email } = JSON.parse(sess);
        const userRecord = JSON.parse(await env.WAITLIST.get(`user:${email}`));
        if (!userRecord) return jsonResp(request, { error: "Account not found." }, 404);
        if (userRecord.plan !== "premium") return jsonResp(request, { error: "Not on a paid plan." }, 400);
        userRecord.cancelledAt = new Date().toISOString();
        userRecord.plan = "free";
        userRecord.credits = FREE_PLAN_CREDITS;
        userRecord.creditsResetAt = new Date(Date.now() + CREDIT_CYCLE_MS).toISOString();
        await env.WAITLIST.put(`user:${email}`, JSON.stringify(userRecord));
        return jsonResp(request, { ok: true });
      }
  
      // --- GET BILLING STATUS ---
      if (body.action === "get_billing_status") {
        const sess = await env.WAITLIST.get(`session:${body.token}`);
        if (!sess) return jsonResp(request, { error: "Log in." }, 401);
        const { email } = JSON.parse(sess);
        const userRecord = JSON.parse(await env.WAITLIST.get(`user:${email}`));
        if (!userRecord) return jsonResp(request, { error: "Account not found." }, 404);
        return jsonResp(request, {
          ok: true,
          plan: userRecord.plan || "free",
          mode: userRecord.premiumMode || "monthly",
          credits: userRecord.credits,
          renewsAt: userRecord.premiumUntil || null,
          cancelled: !!userRecord.cancelledAt,
          cancelsAt: userRecord.cancelledAt || null,
          amount: (userRecord.premiumMode === "annual") ? 2499 : 299,
        });
      }
  
      // --- GET PAYMENT HISTORY ---
      if (body.action === "get_payment_history") {
        const sess = await env.WAITLIST.get(`session:${body.token}`);
        if (!sess) return jsonResp(request, { error: "Log in." }, 401);
        const { email } = JSON.parse(sess);
        // List all payment:<email>:* keys
        const list = await env.WAITLIST.list({ prefix: `payment:${email}:` });
        const payments = [];
        for (const k of list.keys) {
          const v = await env.WAITLIST.get(k.name);
          if (v) payments.push(JSON.parse(v));
        }
        // Newest first
        payments.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
        return jsonResp(request, { ok: true, payments });
      }

      // --- DEFAULT: generate project ideas (login + credits required) ---
      if (await isRateLimited(env, ip, "generate", 10, 3600)) {
        return new Response(JSON.stringify({ error: "Too many requests. Please try again in a bit." }), {
          status: 429,
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      const session = await getSession(env, body.token);
      if (!session) {
        return new Response(JSON.stringify({ error: "Log in to generate project ideas." }), {
          status: 401,
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      let userRecordForGen = await getUser(env, session.email);
      if (!userRecordForGen) {
        return new Response(JSON.stringify({ error: "Account not found." }), {
          status: 404,
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }
      userRecordForGen = refreshCredits(userRecordForGen);
      if (userRecordForGen.credits < IDEA_GEN_COST) {
        await saveUser(env, userRecordForGen);
        return new Response(JSON.stringify({
          error: `You need ${IDEA_GEN_COST} credits to generate ideas — you have ${userRecordForGen.credits}.`,
          creditsResetAt: userRecordForGen.creditsResetAt,
        }), {
          status: 402,
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      const { branch, role, skills, time, gap, dreamTarget } = body;

      if (!role) {
        return new Response(JSON.stringify({ error: "role is required" }), {
          status: 400,
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        });
      }

      // Cap input lengths to keep prompts sane and prevent abuse
      const safe = (v, max) => String(v || "not specified").slice(0, max);

      const prompt = `You are a career mentor helping an Indian student pick resume-worthy projects.

Background: ${safe(branch, 100)}
Target role: ${safe(role, 100)}
Existing skills: ${safe(skills, 200)}
Time available: ${safe(time, 50)}
What feels missing from their resume: ${safe(gap, 300)}
Dream company/target: ${safe(dreamTarget, 100)}

Give exactly 4 solid project ideas tailored to this. Avoid generic overused ideas (no "to-do list app", no "weather app", no basic calculator) unless genuinely justified. Prefer projects that show real judgement and would make an interviewer ask a follow-up question. Each idea's "why" should reference their specific stated gap or goal where relevant.

Then separately, describe ONE flagship project — more ambitious than the 4 above, the kind of project that would genuinely put this student ahead of most other candidates applying for the same role, closer to what someone at their dream company/target would respect. Also list the specific skills they'd need to learn to pull it off, ranked by priority.

Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact structure:
{
  "greeting": "one short warm sentence acknowledging their specific target role and background",
  "ideas": [
    {
      "title": "short project name",
      "why": "1-2 sentences on why this project specifically stands out for this target role, referencing their stated gap or goal if relevant",
      "stack": ["tech1", "tech2", "tech3"],
      "scope": "1 sentence on realistic scope given the time available",
      "resume_line": "one polished resume bullet point, action-verb led, with a plausible measurable outcome"
    }
  ],
  "flagship": {
    "title": "an ambitious, specific, impressive project name",
    "hook": "1 sentence on why this project specifically would set them apart from typical applicants for this exact role/company",
    "skills_to_learn": ["skill1", "skill2", "skill3", "skill4"]
  }
}`;

      // Workers AI — free, built into your Cloudflare account, no key needed.
      const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [
          { role: "system", content: "You are a helpful assistant that responds only with valid JSON, no markdown, no commentary." },
          { role: "user", content: prompt },
        ],
        max_tokens: 1800,
        response_format: {
          type: "json_schema",
          json_schema: {
            type: "object",
            properties: {
              greeting: { type: "string" },
              ideas: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    why: { type: "string" },
                    stack: { type: "array", items: { type: "string" } },
                    scope: { type: "string" },
                    resume_line: { type: "string" },
                  },
                  required: ["title", "why", "stack", "scope", "resume_line"],
                },
              },
              flagship: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  hook: { type: "string" },
                  skills_to_learn: { type: "array", items: { type: "string" } },
                },
                required: ["title", "hook", "skills_to_learn"],
              },
            },
            required: ["greeting", "ideas", "flagship"],
          },
        },
      });

      const parsed = parseAiJson(aiResponse);

      // Charge the credit cost now that generation succeeded.
      userRecordForGen.credits -= IDEA_GEN_COST;
      await saveUser(env, userRecordForGen);
      parsed.creditsRemaining = userRecordForGen.credits;
      parsed.creditsResetAt = userRecordForGen.creditsResetAt;

      return new Response(JSON.stringify(parsed), {
        headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: "Server error", detail: String(err) }), {
        status: 500,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      });
    }
  },
};
