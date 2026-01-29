// proxy.js - Cloudflare Worker style
// Setta SCRAPINGBEE_KEY come secret/environment variable nel tuo runtime

const SCRAPINGBEE_KEY = typeof SCRAPINGBEE_KEY !== "undefined" ? SCRAPINGBEE_KEY : ""; // bind secret in Worker

function scrapingBeeUrl(target) {
  const base = "https://app.scrapingbee.com/api/v1/";
  const params = new URLSearchParams({
    api_key: SCRAPINGBEE_KEY,
    url: target,
    render_js: "true"
  });
  return `${base}?${params.toString()}`;
}

function looksLikeVixsrcPage(url) {
  return /vixsrc\.to\/(movie|tv)\//i.test(url);
}

function isM3u8Url(url) {
  return /\.m3u8($|\?)/i.test(url);
}

function isLikelyManifestText(text) {
  return typeof text === "string" && text.indexOf("#EXTM3U") !== -1;
}

function resolveRelative(line, base) {
  try {
    if (/^https?:\/\//i.test(line)) return line;
    return new URL(line, base).toString();
  } catch (e) {
    return line;
  }
}

async function fetchAndReturnBinary(target) {
  const res = await fetch(target, { redirect: "follow" });
  const ct = res.headers.get("content-type") || "application/octet-stream";
  const buf = await res.arrayBuffer();
  return new Response(buf, {
    status: res.status,
    headers: {
      "Content-Type": ct,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    }
  });
}

addEventListener("fetch", event => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  try {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) return new Response("Missing url", { status: 400 });

    console.log("[PROXY] Request for:", target);

    // 1) Page extraction for vixsrc pages
    if (looksLikeVixsrcPage(target)) {
      if (!SCRAPINGBEE_KEY) {
        return new Response("Missing scraping service key", { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
      }

      const sbUrl = scrapingBeeUrl(target);
      console.log("[PROXY] Using scraping service:", sbUrl);
      const sbRes = await fetch(sbUrl, { method: "GET" });
      if (!sbRes.ok) {
        console.log("[PROXY] Scraping service error:", sbRes.status);
        return new Response("Scraping service error", { status: 502, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const html = await sbRes.text();

      // try to extract token/expires/url/canPlayFHD
      const mainRe = /token['"]?\s*[:=]\s*['"]?([A-Za-z0-9_\-]+)['"]?.{0,300}expires['"]?\s*[:=]\s*['"]?(\d{9,})['"]?.{0,600}url\s*[:=]\s*['"]([^'"]+)['"].{0,200}canPlayFHD\s*[:=]\s*(true|false)/is;
      const m = html.match(mainRe);
      if (m) {
        const token = m[1], expires = m[2], rawUrl = m[3], canFhd = m[4] === "true";
        const u = new URL(rawUrl);
        u.searchParams.set("token", token);
        u.searchParams.set("expires", expires);
        if (canFhd) u.searchParams.set("h", "1");
        const m3u8 = u.toString();
        console.log("[PROXY] Extracted m3u8:", m3u8);
        return new Response(JSON.stringify({ m3u8 }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // fallback: direct playlist link
      const full = html.match(/(https?:\/\/[^\s'"]+\/playlist\/[0-9]+\?[^\s'"]+)/i);
      if (full) {
        console.log("[PROXY] Found direct playlist:", full[1]);
        return new Response(JSON.stringify({ m3u8: full[1] }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // cloudflare challenge detection
      if (/Attention Required|Checking your browser before accessing|cf-chl-bypass/i.test(html)) {
        console.log("[PROXY] Cloudflare challenge detected");
        return new Response("Cloudflare challenge detected; scraping service returned challenge page", { status: 403, headers: { "Access-Control-Allow-Origin": "*" } });
      }

      console.log("[PROXY] Params not found in page");
      return new Response("Params not found in page", { status: 422, headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // 2) Manifest rewriting for .m3u8
    if (isM3u8Url(target)) {
      console.log("[PROXY] Fetching manifest:", target);
      const res = await fetch(target, { redirect: "follow" });
      const ct = res.headers.get("content-type") || "";
      const text = await res.text();

      if (!isLikelyManifestText(text) && !ct.includes("mpegurl") && !ct.includes("vnd.apple")) {
        console.log("[PROXY] Not a manifest, returning as text");
        return new Response(text, { status: res.status, headers: { "Content-Type": ct || "text/plain", "Access-Control-Allow-Origin": "*" } });
      }

      let base;
      try {
        const u = new URL(target);
        base = u.href.substring(0, u.href.lastIndexOf("/") + 1);
      } catch (e) {
        base = target;
      }

      const lines = text.split(/\r?\n/);
      const rewritten = lines.map(line => {
        if (!line || line.trim().startsWith("#")) {
          if (/EXT-X-KEY/i.test(line) && /URI=/i.test(line)) {
            return line.replace(/URI="([^"]+)"/i, (m, p1) => {
              const resolved = resolveRelative(p1, base);
              return `URI="${`/proxy?url=${encodeURIComponent(resolved)}`}"`;
            });
          }
          return line;
        }
        const resolved = resolveRelative(line.trim(), base);
        const prox = `/proxy?url=${encodeURIComponent(resolved)}`;
        return prox;
      }).join("\n");

      console.log("[PROXY] Returning rewritten manifest, length:", rewritten.length);
      return new Response(rewritten, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // 3) Binary resource proxy
    console.log("[PROXY] Fetching binary resource:", target);
    return await fetchAndReturnBinary(target);

  } catch (err) {
    console.error("[PROXY] Error:", err && err.message ? err.message : err);
    return new Response("Proxy error: " + (err && err.message ? err.message : String(err)), { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}
