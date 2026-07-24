// ProjectDesk backend — Cloudflare Worker (FREE version using Workers AI)
// No API key, no billing, no credit card. Uses Cloudflare's free built-in AI models.

const ALLOWED_ORIGIN = "https://aryadeep2116.github.io";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
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
      subject: `Your ProjectDesk login code: ${otp}`,
      text: `Hi ${name || "there"},\n\nYour ProjectDesk login code is: ${otp}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
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
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }


    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    try {
      const body = await request.json();

      // --- WAITLIST: save an email + context to KV ---
      if (body.action === "waitlist") {
        if (await isRateLimited(env, ip, "waitlist", 5, 3600)) {
          return new Response(JSON.stringify({ error: "Too many requests. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const { email, role, gap, dreamTarget, branch, skills } = body;
        if (!email || !email.includes("@") || email.length > 200) {
          return new Response(JSON.stringify({ error: "Valid email required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
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
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- TRACK: log a simple analytics event (landing view, CTA click, etc.) ---
      if (body.action === "track") {
        if (await isRateLimited(env, ip, "track", 60, 3600)) {
          return new Response(JSON.stringify({ error: "Too many requests." }), {
            status: 429,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const { type } = body;
        if (!type || typeof type !== "string" || type.length > 50) {
          return new Response(JSON.stringify({ error: "type required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const key = `event:${type}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        await env.WAITLIST.put(key, JSON.stringify({ type, ts: new Date().toISOString() }));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- SIGNUP: create an account with email + password ---
      if (body.action === "signup") {
        if (await isRateLimited(env, ip, "signup", 10, 3600)) {
          return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const { name, email, password } = body;
        if (!name || !name.trim()) {
          return new Response(JSON.stringify({ error: "Name required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        if (!email || !email.includes("@") || email.length > 200) {
          return new Response(JSON.stringify({ error: "Valid email required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        if (!password || password.length < 8) {
          return new Response(JSON.stringify({ error: "Password must be at least 8 characters" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const userKey = `user:${email.toLowerCase()}`;
        const existing = await env.WAITLIST.get(userKey);
        if (existing) {
          return new Response(JSON.stringify({ error: "An account with this email already exists. Log in instead." }), {
            status: 409,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const { hash, salt } = await hashPassword(password);
        const userRecord = { name: String(name).slice(0, 100), email: email.toLowerCase(), hash, salt, ts: new Date().toISOString() };
        await env.WAITLIST.put(userKey, JSON.stringify(userRecord));

        const token = generateId();
        await env.WAITLIST.put(`session:${token}`, JSON.stringify({ email: userRecord.email, name: userRecord.name }), { expirationTtl: 60 * 60 * 24 * 30 });

        return new Response(JSON.stringify({ ok: true, token, name: userRecord.name, email: userRecord.email }), {
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- LOGIN: verify email + password ---
      if (body.action === "login") {
        if (await isRateLimited(env, ip, "login", 15, 3600)) {
          return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const { email, password } = body;
        if (!email || !password) {
          return new Response(JSON.stringify({ error: "Email and password required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const userKey = `user:${email.toLowerCase()}`;
        const stored = await env.WAITLIST.get(userKey);
        if (!stored) {
          return new Response(JSON.stringify({ error: "Invalid email or password." }), {
            status: 401,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const userRecord = JSON.parse(stored);
        const { hash } = await hashPassword(password, userRecord.salt);
        if (hash !== userRecord.hash) {
          return new Response(JSON.stringify({ error: "Invalid email or password." }), {
            status: 401,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const token = generateId();
        await env.WAITLIST.put(`session:${token}`, JSON.stringify({ email: userRecord.email, name: userRecord.name }), { expirationTtl: 60 * 60 * 24 * 30 });

        return new Response(JSON.stringify({ ok: true, token, name: userRecord.name, email: userRecord.email }), {
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- REQUEST_OTP: generate a 6-digit code and email it ---
      if (body.action === "request_otp") {
        if (await isRateLimited(env, ip, "request_otp", 5, 3600)) {
          return new Response(JSON.stringify({ error: "Too many code requests. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const { name, email } = body;
        if (!email || !email.includes("@") || email.length > 200) {
          return new Response(JSON.stringify({ error: "Valid email required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        if (!name || !name.trim()) {
          return new Response(JSON.stringify({ error: "Name required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        // Per-email limit too, so one IP can't spam many addresses and one address
        // can't be spammed via a different IP.
        if (await isRateLimited(env, email.toLowerCase(), "request_otp_email", 5, 3600)) {
          return new Response(JSON.stringify({ error: "Too many code requests for this email. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
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
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- VERIFY_OTP: check the code, issue a session token ---
      if (body.action === "verify_otp") {
        if (await isRateLimited(env, ip, "verify_otp", 20, 3600)) {
          return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const { email, otp } = body;
        if (!email || !otp) {
          return new Response(JSON.stringify({ error: "Email and code required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const key = `otp:${email.toLowerCase()}`;
        const stored = await env.WAITLIST.get(key);
        if (!stored) {
          return new Response(JSON.stringify({ error: "Code expired or not found. Request a new one." }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const record = JSON.parse(stored);
        if (String(otp).trim() !== record.otp) {
          return new Response(JSON.stringify({ error: "Incorrect code." }), {
            status: 401,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
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
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- VALIDATE_SESSION: check a stored token is still good (auto-login) ---
      if (body.action === "validate_session") {
        const session = await getSession(env, body.token);
        if (!session) {
          return new Response(JSON.stringify({ error: "Session expired or invalid." }), {
            status: 401,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true, ...session }), {
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- GET_USER_RESULTS: list all saved results tied to the logged-in user ---
      if (body.action === "get_user_results") {
        const session = await getSession(env, body.token);
        if (!session) {
          return new Response(JSON.stringify({ error: "Not logged in." }), {
            status: 401,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
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
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- GENERATE_GUIDE: elaborate step-by-step plan for one chosen project (login required) ---
      if (body.action === "generate_guide") {
        const session = await getSession(env, body.token);
        if (!session) {
          return new Response(JSON.stringify({ error: "Log in to unlock the full step-by-step guide." }), {
            status: 401,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        if (await isRateLimited(env, session.email, "generate_guide", 15, 3600)) {
          return new Response(JSON.stringify({ error: "Too many guide requests. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const { resultId, ideaKey } = body; // ideaKey: "flagship" or "0".."3"
        if (!resultId || !ideaKey) {
          return new Response(JSON.stringify({ error: "resultId and ideaKey required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const guideKey = `guide:${resultId}:${ideaKey}`;

        // Return the cached guide if we've already generated one — saves AI calls.
        const existing = await env.WAITLIST.get(guideKey);
        if (existing) {
          return new Response(existing, { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
        }

        const resultStored = await env.WAITLIST.get(`result:${resultId}`);
        if (!resultStored) {
          return new Response(JSON.stringify({ error: "Original result not found." }), {
            status: 404,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const resultRecord = JSON.parse(resultStored);
        const project = ideaKey === "flagship" ? resultRecord.flagship : resultRecord.ideas[parseInt(ideaKey, 10)];
        if (!project) {
          return new Response(JSON.stringify({ error: "Project not found in this result." }), {
            status: 404,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const inputs = resultRecord.inputs || {};

        const guidePrompt = `You are a hands-on technical mentor. A student wants a complete, elaborate, step-by-step guide to actually build this project:

Project: ${project.title}
Why it matters: ${project.hook || project.why || ""}
Target role: ${inputs.role || "not specified"}
Their current skills: ${inputs.skills || "not specified"}
Time available: ${inputs.time || "not specified"}

Give a genuinely detailed build guide, not a vague outline. Include:
1. A short system/project architecture overview explaining the main components and how they connect.
2. A skills breakdown: what they need to learn, ordered by priority, each with a one-line reason why it's needed for this specific project.
3. A phased step-by-step plan (4-6 phases). Each phase has a title, a short description, and 3-6 concrete steps. Each step should be a specific, actionable task (not "build the backend" but "set up an Express server with a /api/tasks route that returns JSON").

Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact structure:
{
  "architecture": "2-4 sentences describing the overall system architecture and how the pieces fit together",
  "skills": [
    { "name": "skill name", "why": "1 sentence on why this specific project needs it" }
  ],
  "phases": [
    {
      "title": "short phase name",
      "description": "1 sentence on what this phase accomplishes",
      "steps": [
        { "title": "short step name", "detail": "1-2 sentences of specific, actionable guidance for this step" }
      ]
    }
  ]
}`;

        let aiResponse;
        try {
          aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            messages: [
              { role: "system", content: "You are a helpful assistant that responds only with valid JSON, no markdown, no commentary." },
              { role: "user", content: guidePrompt },
            ],
            max_tokens: 2200,
            response_format: {
              type: "json_schema",
              json_schema: {
                type: "object",
                properties: {
                  architecture: { type: "string" },
                  skills: {
                    type: "array",
                    items: { type: "object", properties: { name: { type: "string" }, why: { type: "string" } }, required: ["name", "why"] },
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
                required: ["architecture", "skills", "phases"],
              },
            },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: "Could not generate guide right now.", detail: String(e.message || e) }), {
            status: 500,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const guideParsed = parseAiJson(aiResponse);
        const guideRecord = {
          resultId,
          ideaKey,
          projectTitle: project.title,
          architecture: guideParsed.architecture,
          skills: guideParsed.skills,
          phases: guideParsed.phases,
          progress: {}, // { "phaseIdx-stepIdx": true }
          email: session.email,
          ts: new Date().toISOString(),
        };
        await env.WAITLIST.put(guideKey, JSON.stringify(guideRecord), { expirationTtl: 60 * 60 * 24 * 180 });

        return new Response(JSON.stringify(guideRecord), {
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- GET_GUIDE: fetch an already-generated guide (login required) ---
      if (body.action === "get_guide") {
        const session = await getSession(env, body.token);
        if (!session) {
          return new Response(JSON.stringify({ error: "Log in to view this guide." }), {
            status: 401,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const { resultId, ideaKey } = body;
        if (!resultId || !ideaKey) {
          return new Response(JSON.stringify({ error: "resultId and ideaKey required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const stored = await env.WAITLIST.get(`guide:${resultId}:${ideaKey}`);
        if (!stored) {
          return new Response(JSON.stringify({ exists: false }), {
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        return new Response(stored, { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }

      // --- UPDATE_GUIDE_PROGRESS: toggle a step checked state on a guide (login required) ---
      if (body.action === "update_guide_progress") {
        const session = await getSession(env, body.token);
        if (!session) {
          return new Response(JSON.stringify({ error: "Log in to track progress." }), {
            status: 401,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const { resultId, ideaKey, stepId, completed } = body;
        if (!resultId || !ideaKey || !stepId) {
          return new Response(JSON.stringify({ error: "resultId, ideaKey and stepId required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const guideKey = `guide:${resultId}:${ideaKey}`;
        const stored = await env.WAITLIST.get(guideKey);
        if (!stored) {
          return new Response(JSON.stringify({ error: "Guide not found." }), {
            status: 404,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const guideRecord = JSON.parse(stored);
        guideRecord.progress = guideRecord.progress || {};
        guideRecord.progress[stepId] = !!completed;
        await env.WAITLIST.put(guideKey, JSON.stringify(guideRecord), { expirationTtl: 60 * 60 * 24 * 180 });

        return new Response(JSON.stringify({ ok: true, progress: guideRecord.progress }), {
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- SAVE_RESULT: persist a generated result set so it can be shared/bookmarked ---
      if (body.action === "save_result") {
        if (await isRateLimited(env, ip, "save_result", 20, 3600)) {
          return new Response(JSON.stringify({ error: "Too many requests. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const { ideas, flagship, greeting, inputs, token } = body;
        if (!ideas || !flagship) {
          return new Response(JSON.stringify({ error: "ideas and flagship required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
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
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- GET_RESULT: fetch a previously saved result by id ---
      if (body.action === "get_result") {
        const { id } = body;
        if (!id || typeof id !== "string" || id.length > 64) {
          return new Response(JSON.stringify({ error: "Valid id required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const stored = await env.WAITLIST.get(`result:${id}`);
        if (!stored) {
          return new Response(JSON.stringify({ error: "Result not found. It may have expired." }), {
            status: 404,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        return new Response(stored, {
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- UPDATE_PROGRESS: toggle a skill/step checked state on a saved result ---
      if (body.action === "update_progress") {
        if (await isRateLimited(env, ip, "update_progress", 120, 3600)) {
          return new Response(JSON.stringify({ error: "Too many requests." }), {
            status: 429,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        const { id, stepIndex, completed } = body;
        if (!id || typeof id !== "string" || typeof stepIndex !== "number") {
          return new Response(JSON.stringify({ error: "id and stepIndex required" }), {
            status: 400,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const key = `result:${id}`;
        const stored = await env.WAITLIST.get(key);
        if (!stored) {
          return new Response(JSON.stringify({ error: "Result not found." }), {
            status: 404,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }
        const record = JSON.parse(stored);
        record.progress = record.progress || {};
        record.progress[stepIndex] = !!completed;
        await env.WAITLIST.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 180 });

        return new Response(JSON.stringify({ ok: true, progress: record.progress }), {
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- ADMIN: view all waitlist entries (simple password check) ---
      if (body.action === "admin_view_waitlist") {
        if (await isRateLimited(env, ip, "admin", 20, 3600)) {
          return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), {
            status: 429,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
          });
        }

        if (body.password !== env.ADMIN_PASSWORD) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { ...corsHeaders(), "Content-Type": "application/json" },
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
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      // --- DEFAULT: generate project ideas ---
      if (await isRateLimited(env, ip, "generate", 10, 3600)) {
        return new Response(JSON.stringify({ error: "Too many requests. Please try again in a bit." }), {
          status: 429,
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }

      const { branch, role, skills, time, gap, dreamTarget } = body;

      if (!role) {
        return new Response(JSON.stringify({ error: "role is required" }), {
          status: 400,
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
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

      return new Response(JSON.stringify(parsed), {
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Server error", detail: String(err) }), {
        status: 500,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }
  },
};