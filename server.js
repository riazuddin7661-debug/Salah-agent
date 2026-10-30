// Salah Travel — passenger agent server (zero dependencies, plain Node.js).
//
// WHAT IT IS
//   A tiny server that sits between the Salah Travel app and OpenAI.
//   The app NEVER holds an AI key: customers talk to this server, and
//   only this server holds the key (in the OPENAI_API_KEY environment
//   variable). No key is ever written in this file, in chat, or in
//   the app. No passenger data is stored anywhere: every request is
//   handled in memory and forgotten.
//
// ENDPOINTS
//   GET  /health  -> { ok: true }  (deploy check)
//   POST /ask     { question, tickets[], lang } -> { reply }
//     question: passenger's question (max 1000 chars)
//     tickets:  ticket lines, the ONLY source of truth (max 40 lines)
//     lang:     "ur" (Roman Urdu, default) | "ps" (Roman Pashto) | "en"
//   POST /speak   { text } -> MP3 audio of the reply (OpenAI voice)
//   POST /hear    raw audio body (?lang=ur) -> { text } (Whisper)
//
// SAFETY
//   - Rate limit: 30 requests/minute per IP, anything more -> 429.
//   - Inputs are length-capped; oversized bodies are rejected.
//   - Error replies never include OpenAI's raw body or any key.
//   - The log records only method, path and status — never bodies.
//
// RUN
//   OPENAI_API_KEY=... PORT=3000 node server.js
//   (Railway / Fly.io / Render / any VPS: set the env var there.)

const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const VOICE = process.env.OPENAI_VOICE || "nova";

// ---------- small helpers ----------

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end(body);
}

function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooBig = false;
        req.on("data", (c) => {
            size += c.length;
            if (size > maxBytes) { tooBig = true; return; }
            chunks.push(c);
        });
        req.on("end", () => {
            if (tooBig) reject(new Error("too_big"));
            else resolve(Buffer.concat(chunks));
        });
        req.on("error", reject);
    });
}

// Per-IP rate limit: 30 requests per rolling 60 seconds.
const hits = new Map();
function rateLimited(ip) {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 5000) { // prune idle entries, memory hygiene
        for (const [k, v] of hits) if (now - v[v.length - 1] > 60000) hits.delete(k);
    }
    return list.length > 30;
}

function needKey(res) {
    if (!KEY) { sendJson(res, 503, { error: "ai_key_missing" }); return false; }
    return true;
}

function mapOpenAiError(status) {
    if (status === 401 || status === 403) return ["ai_key_invalid", 502];
    if (status === 429) return ["ai_busy", 502];
    return ["ai_failed", 502];
}

async function openAi(path, body, isJson) {
    const headers = { "Authorization": "Bearer " + KEY };
    if (isJson) headers["Content-Type"] = "application/json";
    const r = await fetch("https://api.openai.com/v1" + path, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(60000),
    });
    return r;
}

// ---------- endpoint handlers ----------

async function handleAsk(req, res) {
    let data;
    try {
        const raw = await readBody(req, 65536);
        data = JSON.parse(raw.toString("utf8"));
    } catch (e) {
        sendJson(res, 400, { error: e.message === "too_big" ? "too_big" : "bad_json" });
        return;
    }
    const q = typeof data.question === "string" ? data.question.trim() : "";
    if (!q || q.length > 1000) { sendJson(res, 400, { error: "bad_question" }); return; }
    const lines = Array.isArray(data.tickets) ? data.tickets : [];
    if (lines.length > 40 || lines.some((l) => typeof l !== "string" || l.length > 300)) {
        sendJson(res, 400, { error: "bad_tickets" });
        return;
    }
    if (!needKey(res)) return;

    const lang = data.lang === "ps" ? "ps" : data.lang === "en" ? "en" : "ur";
    const langLine = lang === "ps"
        ? "Reply in simple Roman Pashto, short sentences."
        : lang === "en"
        ? "Reply in simple English, short sentences."
        : "Reply in simple Roman Urdu, short sentences.";
    const system = [
        "You are the Salah Travel flight assistant. You help passengers",
        "who want to fly from Pakistan to Saudi Arabia, UAE, Qatar,",
        "Bahrain, Oman or Kuwait.",
        langLine,
        "RULES: Use ONLY the ticket lines below as your source of truth.",
        "Never invent a fare, time, baggage allowance, seat count or",
        "availability. If a detail is not in the ticket lines, say it",
        "is not confirmed and ask the passenger to confirm on WhatsApp.",
        "If the passenger wants to book or see full details, offer to",
        "share the details on WhatsApp. Never ask for personal data,",
        "and never repeat any name, number or document detail.",
        "Ticket lines:",
        lines.length ? lines.join("\n") : "(no tickets provided)",
    ].join(" ");

    let r;
    try {
        r = await openAi("/chat/completions", JSON.stringify({
            model: MODEL,
            max_tokens: 500,
            temperature: 0.3,
            messages: [
                { role: "system", content: system },
                { role: "user", content: q },
            ],
        }), true);
    } catch (e) {
        sendJson(res, 502, { error: "ai_failed" });
        return;
    }
    if (!r.ok) {
        const [err, code] = mapOpenAiError(r.status);
        sendJson(res, code, { error: err });
        return;
    }
    let out;
    try { out = await r.json(); } catch (e) { sendJson(res, 502, { error: "ai_failed" }); return; }
    const reply = out && out.choices && out.choices[0] && out.choices[0].message
        ? out.choices[0].message.content : "";
    if (!reply) { sendJson(res, 502, { error: "ai_failed" }); return; }
    sendJson(res, 200, { reply });
}

async function handleSpeak(req, res) {
    let data;
    try {
        const raw = await readBody(req, 16384);
        data = JSON.parse(raw.toString("utf8"));
    } catch (e) {
        sendJson(res, 400, { error: e.message === "too_big" ? "too_big" : "bad_json" });
        return;
    }
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text || text.length > 2000) { sendJson(res, 400, { error: "bad_text" }); return; }
    if (!needKey(res)) return;

    let r;
    try {
        r = await openAi("/audio/speech", JSON.stringify({
            model: "tts-1",
            voice: VOICE,
            input: text,
        }), true);
    } catch (e) {
        sendJson(res, 502, { error: "ai_failed" });
        return;
    }
    if (!r.ok) {
        const [err, code] = mapOpenAiError(r.status);
        sendJson(res, code, { error: err });
        return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
}

async function handleHear(req, res, url) {
    let audio;
    try {
        audio = await readBody(req, 10 * 1024 * 1024);
    } catch (e) {
        sendJson(res, 400, { error: e.message === "too_big" ? "too_big" : "bad_body" });
        return;
    }
    if (!audio || audio.length === 0) { sendJson(res, 400, { error: "bad_body" }); return; }
    if (!needKey(res)) return;

    const ct = (req.headers["content-type"] || "").toLowerCase();
    const ext = ct.includes("wav") ? "wav" : ct.includes("mp4") || ct.includes("m4a") ? "m4a"
        : ct.includes("ogg") ? "ogg" : "mp3";
    const lang = url.searchParams.get("lang") || "ur";
    const boundary = "----salah" + Date.now();
    const parts = [
        Buffer.from("--" + boundary + "\r\n"
            + "Content-Disposition: form-data; name=\"file\"; filename=\"audio." + ext + "\"\r\n"
            + "Content-Type: application/octet-stream\r\n\r\n"),
        audio,
        Buffer.from("\r\n--" + boundary + "\r\n"
            + "Content-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-1\r\n"
            + "--" + boundary + "\r\n"
            + "Content-Disposition: form-data; name=\"language\"\r\n\r\n" + lang + "\r\n"
            + "--" + boundary + "--\r\n"),
    ];
    let r;
    try {
        r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + KEY,
                "Content-Type": "multipart/form-data; boundary=" + boundary,
            },
            body: Buffer.concat(parts),
            signal: AbortSignal.timeout(60000),
        });
    } catch (e) {
        sendJson(res, 502, { error: "ai_failed" });
        return;
    }
    if (!r.ok) {
        const [err, code] = mapOpenAiError(r.status);
        sendJson(res, code, { error: err });
        return;
    }
    let out;
    try { out = await r.json(); } catch (e) { sendJson(res, 502, { error: "ai_failed" }); return; }
    sendJson(res, 200, { text: out.text || "" });
}

// ---------- server ----------

const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://local");
    // Log only method + path + status; never bodies, keys or IPs.
    const done = (code) => console.log(new Date().toISOString(), req.method, url.pathname, code);
    const origEnd = res.end.bind(res);
    res.end = (...a) => { done(res.statusCode); return origEnd(...a); };

    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        });
        res.end();
        return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "salah-agent" });
        return;
    }
    if (req.method === "POST" && (url.pathname === "/ask" || url.pathname === "/speak"
            || url.pathname === "/hear")) {
        const ip = req.socket.remoteAddress || "unknown";
        if (rateLimited(ip)) { sendJson(res, 429, { error: "too_many" }); return; }
        if (url.pathname === "/ask") handleAsk(req, res);
        else if (url.pathname === "/speak") handleSpeak(req, res);
        else handleHear(req, res, url);
        return;
    }
    sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, () => {
    console.log("salah-agent listening on " + PORT + (KEY ? " (key set)" : " (NO KEY - /ask /speak /hear will answer ai_key_missing)"));
});
