/* ============================================================
   VivoX Universal Proxy — Vercel Node.js
   ============================================================ */

const MASKED = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "VLC/3.0.20 LibVLC/3.0.20",
  "ExoPlayer/2.19.1",
  "Lavf/58.76.100",
];

function refererCandidates(host) {
  const base = host.replace(/^[a-z0-9\-]+\./, "");
  return [...new Set([
    "",
    `https://${host}/`,
    `https://${host}`,
    `https://www.${host}/`,
    `https://${base}/`,
    `https://www.${base}/`,
    `https://${base}`,
  ])];
}

function buildHeaders(ua, referer, origin, extra) {
  const h = {
    "User-Agent": ua,
    "Accept": "*/*",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
  };
  if (referer) h["Referer"] = referer;
  if (origin)  h["Origin"]  = origin;
  if (extra) Object.assign(h, extra);
  return h;
}

function attemptPlan(host, customRef, customOrg) {
  const refs = customRef ? [customRef, "", ...refererCandidates(host)] : refererCandidates(host);
  const plans = [];
  for (const ua of USER_AGENTS) {
    for (const ref of refs) {
      const org = customOrg || (ref ? new URL(ref).origin : "");
      plans.push({ ua, ref, org });
    }
  }
  const seen = new Set();
  return plans.filter(p => {
    const k = `${p.ua}|${p.ref}|${p.org}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function isMasked(u) {
  const p = u.split("?")[0].toLowerCase();
  return MASKED.some(e => p.endsWith(e));
}
function isManifest(u) {
  const l = u.toLowerCase(), p = l.split("?")[0];
  return p.includes(".m3u8") || l.includes("ext=m3u8")
    || p.endsWith("/mono.m3u8") || p.includes("master") || p.includes("playlist");
}
function makeAbs(u, bo, bd) {
  u = u.trim();
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return bo + u;
  return bo + bd + u;
}

async function fetchWithRetry(target, customRef, customOrg, extraHeaders, method, reqHeaders) {
  const host = new URL(target).host;
  const plans = attemptPlan(host, customRef, customOrg);
  let lastStatus = 0;

  for (const plan of plans) {
    try {
      const headers = buildHeaders(plan.ua, plan.ref, plan.org, extraHeaders || undefined);
      if (reqHeaders.range)  headers["Range"]  = reqHeaders.range;
      if (reqHeaders.cookie) headers["Cookie"] = reqHeaders.cookie;

      const res = await fetch(target, { method, headers, redirect: "follow" });
      if (res.status >= 200 && res.status < 400) return { res, plan, status: res.status };
      lastStatus = res.status;
    } catch (e) { /* sıradaki */ }
  }
  return { res: null, plan: null, status: lastStatus };
}

function rewriteManifest(text, target, proxyOrigin, usedRef, usedOrg) {
  const b = new URL(target);
  const bo = `${b.protocol}//${b.host}`;
  const bd = b.pathname.substring(0, b.pathname.lastIndexOf("/") + 1);
  const proxy = `${proxyOrigin}/`;
  const qsRef = usedRef ? `&referer=${encodeURIComponent(usedRef)}` : "";
  const qsOrg = usedOrg ? `&origin=${encodeURIComponent(usedOrg)}` : "";
  const out = [];

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { out.push(line); continue; }

    if (t.startsWith("#")) {
      if (t.includes('URI="')) {
        out.push(t.replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = makeAbs(uri, bo, bd);
          return `URI="${proxy}?action=ts&url=${encodeURIComponent(abs)}${qsRef}${qsOrg}"`;
        }));
      } else {
        out.push(t);
      }
      continue;
    }

    const abs = makeAbs(t, bo, bd);
    const act = (isMasked(abs) || !isManifest(abs)) ? "ts" : "hls";
    out.push(`${proxy}?action=${act}&url=${encodeURIComponent(abs)}${qsRef}${qsOrg}`);
  }
  return out.join("\n");
}

module.exports = async function handler(req, res) {
  const u = new URL(req.url, `https://${req.headers.host}`);
  const action = u.searchParams.get("action") || "";
  const target = u.searchParams.get("url") || "";
  const customRef = u.searchParams.get("referer") || "";
  const customOrg = u.searchParams.get("origin")  || "";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

  if (req.method === "OPTIONS") return res.status(204).end();

  if (action === "health") return res.status(200).send("OK");
  if (!target) return res.status(400).send("Missing ?url=");

  const reqHeaders = {
    range:  req.headers.range,
    cookie: req.headers.cookie,
  };

  if (action === "hls") {
    const { res: up, status, plan } = await fetchWithRetry(target, customRef, customOrg, null, "GET", reqHeaders);
    if (!up) return res.status(status || 502).send(`Tüm denemeler başarısız. Son durum: ${status}`);

    const text = await up.text();
    if (!text.trimStart().startsWith("#EXTM3U")) {
      res.setHeader("Content-Type", up.headers.get("content-type") || "application/octet-stream");
      return res.status(200).send(text);
    }

    const rewritten = rewriteManifest(text, target, `https://${req.headers.host}`, plan.ref, plan.org);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Proxy-Referer", plan.ref || "(none)");
    res.setHeader("X-Proxy-Origin", plan.org || "(none)");
    return res.status(200).send(rewritten);
  }

  if (action === "ts") {
    const method = req.method === "HEAD" ? "HEAD" : "GET";
    const extra = { "Accept": "video/mp2t, application/octet-stream, */*" };
    const { res: up, status } = await fetchWithRetry(target, customRef, customOrg, extra, method, reqHeaders);

    if (!up) return res.status(status || 502).send(`Tüm denemeler başarısız. Son durum: ${status}`);

    let ct = up.headers.get("content-type") || "video/mp2t";
    if (target.toLowerCase().includes(".key")) ct = "application/octet-stream";

    res.setHeader("Content-Type", ct);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=5");
    const cl = up.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const cr = up.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);

    const buffer = Buffer.from(await up.arrayBuffer());
    return res.status(up.status).send(buffer);
  }

  if (action === "probe") {
    const host = new URL(target).host;
    const plans = attemptPlan(host, customRef, customOrg);
    const results = [];
    for (const plan of plans.slice(0, 40)) {
      try {
        const headers = buildHeaders(plan.ua, plan.ref, plan.org);
        const r = await fetch(target, { headers, redirect: "follow" });
        results.push({
          ua: plan.ua.slice(0, 40),
          ref: plan.ref || "(none)",
          org: plan.org || "(none)",
          status: r.status,
          ok: r.ok,
        });
        if (r.ok) break;
      } catch (e) {
        results.push({ ref: plan.ref, error: String(e) });
      }
    }
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(results);
  }

  return res.status(404).send("Unknown action");
};
