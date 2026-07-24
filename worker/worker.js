// ProjectDesk backend — Cloudflare Worker (FREE version using Workers AI)
// No API key, no billing, no credit card. Uses Cloudflare's free built-in AI models.

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = await request.json();

      // --- WAITLIST: save an email + context to KV ---
      if (body.action === "waitlist") {
        const { email, role, gap, dreamTarget, branch, skills } = body;
        if (!email || !email.includes("@")) {
          return new Response(JSON.stringify({ error: "Valid email required" }), {
            status: 400,
            headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          });
        }
        const entry = { email, role, gap, dreamTarget, branch, skills, ts: new Date().toISOString() };
        const key = `waitlist:${Date.now()}:${email}`;
        await env.WAITLIST.put(key, JSON.stringify(entry));

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        });
      }

      // --- TRACK: log a simple analytics event (landing view, CTA click, etc.) ---
      if (body.action === "track") {
        const { type } = body;
        if (!type) {
          return new Response(JSON.stringify({ error: "type required" }), {
            status: 400,
            headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          });
        }
        const key = `event:${type}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        await env.WAITLIST.put(key, JSON.stringify({ type, ts: new Date().toISOString() }));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        });
      }

      // --- ADMIN: view all waitlist entries (simple password check) ---
      if (body.action === "admin_view_waitlist") {
        if (body.password !== env.ADMIN_PASSWORD) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
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
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        });
      }

      // --- DEFAULT: generate project ideas ---
      const { branch, role, skills, time, gap, dreamTarget } = body;

      if (!role) {
        return new Response(JSON.stringify({ error: "role is required" }), {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        });
      }

      const prompt = `You are a career mentor helping an Indian student pick resume-worthy projects.

Background: ${branch || "not specified"}
Target role: ${role}
Existing skills: ${skills || "not specified"}
Time available: ${time || "not specified"}
What feels missing from their resume: ${gap || "not specified"}
Dream company/target: ${dreamTarget || "not specified"}

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
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Server error", detail: String(err) }), {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      });
    }
  },
};
