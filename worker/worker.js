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

      let parsed;

      if (aiResponse.response && typeof aiResponse.response === "object") {
        // Structured JSON mode returned an actual object already
        parsed = aiResponse.response;
      } else {
        const text = aiResponse.response || "";
        let clean = text.replace(/```json|```/g, "").trim();

        // Isolate the JSON object in case the model adds stray text
        const firstBrace = clean.indexOf("{");
        const lastBrace = clean.lastIndexOf("}");
        clean = clean.slice(firstBrace, lastBrace + 1);

        try {
          parsed = JSON.parse(clean);
        } catch (e) {
          // Common model slip-ups: trailing commas before ] or }
          const repaired = clean.replace(/,(\s*[\]}])/g, "$1");
          parsed = JSON.parse(repaired);
        }
      }

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
