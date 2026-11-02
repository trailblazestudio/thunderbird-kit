// Tracking for Thunderbird – server.
// Serves an invisible pixel and records opens. Stores no IP addresses – only
// time, city/country and mail client.

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
  c => c.charCodeAt(0)
);
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const SCAN_WINDOW_MS = 15000; // fetches right after sending are spam filters/scanners
const MAX_OPENS_PER_PIXEL = 500; // keeps a leaked pixel URL from filling the database
const MAX_BODY_BYTES = 4096;
const MAX_DAYS = 365;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Constant-time comparison, so response timing reveals nothing about the key.
function isAuthorized(req, env) {
  if (!env.API_KEY) {
    return false; // never "Bearer undefined" when the secret is missing
  }
  const enc = new TextEncoder();
  const given = enc.encode(req.headers.get("authorization") || "");
  const expected = enc.encode(`Bearer ${env.API_KEY}`);
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

async function readJson(req) {
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return null;
  }
  try {
    const text = await req.text();
    return text.length <= MAX_BODY_BYTES ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function classify(req) {
  const ua = req.headers.get("user-agent") || "";
  const cf = req.cf || {};
  if (/GoogleImageProxy/i.test(ua)) return { client: "Gmail", proxy: true, auto: false };
  if (/YahooMailProxy/i.test(ua)) return { client: "Yahoo Mail", proxy: true, auto: false };
  // Apple Mail Privacy Protection prefetches every image through Apple's network.
  if (cf.asn === 714 || /apple/i.test(String(cf.asOrganization || ""))) {
    return { client: "Apple Mail (prefetched)", proxy: true, auto: true };
  }
  const direct = [
    [/Microsoft Outlook|ms-office|Microsoft Office/i, "Outlook"],
    [/Thunderbird/i, "Thunderbird"],
    [/iPhone|iPad/i, "iPhone/iPad"],
    [/Android/i, "Android"],
    [/Macintosh/i, "Mac"],
    [/Windows/i, "Windows"],
  ];
  const match = direct.find(([re]) => re.test(ua));
  return { client: match ? match[1] : "Unknown", proxy: false, auto: false };
}

async function logOpen(env, token, req) {
  const pixel = await env.DB.prepare(
    "SELECT created_at, (SELECT COUNT(*) FROM opens WHERE token = ?1) AS opens FROM pixels WHERE token = ?1"
  )
    .bind(token)
    .first();
  if (!pixel || pixel.opens >= MAX_OPENS_PER_PIXEL) {
    return; // unknown pixel, or already plenty of opens
  }
  const now = Date.now();
  const c = classify(req);
  const cf = req.cf || {};
  // Proxies (Gmail/Yahoo) only fetch when the mail is opened – only direct fetches can be scanners.
  const auto = c.auto || (!c.proxy && now - pixel.created_at < SCAN_WINDOW_MS);
  await env.DB.prepare("INSERT INTO opens (token, ts, country, city, client, auto) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(token, now, c.proxy ? null : cf.country || null, c.proxy ? null : cf.city || null, c.client, auto ? 1 : 0)
    .run();
}

async function handleApi(req, env, url) {
  if (!isAuthorized(req, env)) {
    return json({ error: "unauthorized" }, 401);
  }
  const route = `${req.method} ${url.pathname}`;

  if (route === "POST /api/pixels") {
    const body = await readJson(req);
    if (!TOKEN.test(body?.token || "")) return json({ error: "bad request" }, 400);
    await env.DB.prepare("INSERT OR IGNORE INTO pixels (token, created_at) VALUES (?, ?)")
      .bind(body.token, Date.now())
      .run();
    return json({ ok: true });
  }

  // Links a pixel to the Message-ID of the sent message.
  if (route === "POST /api/link") {
    const body = await readJson(req);
    const { token, messageId } = body || {};
    if (!TOKEN.test(token || "") || typeof messageId !== "string" || !messageId || messageId.length > 500) {
      return json({ error: "bad request" }, 400);
    }
    await env.DB.prepare("UPDATE pixels SET message_id = ? WHERE token = ?").bind(messageId, token).run();
    return json({ ok: true });
  }

  // All tracked messages of the last N days with their opens.
  if (route === "GET /api/recent") {
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 90, 1), MAX_DAYS);
    const { results } = await env.DB.prepare(
      `SELECT p.message_id, p.created_at, o.ts, o.country, o.city, o.client, o.auto
         FROM pixels p LEFT JOIN opens o ON o.token = p.token
        WHERE p.created_at > ? AND p.message_id IS NOT NULL
        ORDER BY o.ts`
    )
      .bind(Date.now() - days * 86400000)
      .all();
    const out = Object.create(null); // Message-IDs are user data – no prototype keys
    for (const r of results) {
      const entry = (out[r.message_id] ??= { sentAt: r.created_at, opens: [] });
      if (r.ts) {
        entry.opens.push({ ts: r.ts, country: r.country, city: r.city, client: r.client, auto: !!r.auto });
      }
    }
    return json(out);
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    const pixel = url.pathname.match(/^\/o\/([^/.]+)\.png$/);
    if (pixel && req.method === "GET") {
      if (TOKEN.test(pixel[1])) {
        ctx.waitUntil(logOpen(env, pixel[1], req));
      }
      return new Response(PNG, {
        headers: {
          "content-type": "image/png",
          "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
          pragma: "no-cache",
          expires: "0",
        },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, env, url);
    }
    return new Response("Not found", { status: 404 });
  },
};
