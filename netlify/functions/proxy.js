export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = url.searchParams.get("url");
  if (!target) {
    console.log("[PROXY] ❌ Missing url param");
    return new Response("Missing url", { status: 400 });
  }

  console.log("[PROXY] ▶ Request for:", target);

  try {
    // 1) Pagina vixsrc (movie/tv)
    if (/vixsrc\.to\/(movie|tv)\//i.test(target)) {
      console.log("[PROXY] Fetching vixsrc page:", target);
      const res = await fetch(target, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://vixsrc.to" },
        redirect: "follow"
      });
      const html = await res.text();
      console.log("[PROXY] Page fetched, length:", html.length);

      // Regex per token/expires/url/canPlayFHD
      const re = /token['"]?\s*[:=]\s*['"]?([^'"]+)['"].{0,200}expires['"]?\s*[:=]\s*['"]?(\d{9,})['"].{0,400}url\s*[:=]\s*['"]([^'"]+)['"].{0,200}canPlayFHD\s*[:=]\s*(true|false)/i;
      const m = html.match(re);
      if (m) {
        const token = m[1], expires = m[2], rawUrl = m[3], fhd = m[4] === "true";
        const u = new URL(rawUrl);
        u.searchParams.set("token", token);
        u.searchParams.set("expires", expires);
        if (fhd) u.searchParams.set("h", "1");
        console.log("[PROXY] ✅ Extracted m3u8:", u.toString());
        return new Response(JSON.stringify({ m3u8: u.toString() }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // Fallback: playlist già completa
      const m2 = html.match(/(https?:\/\/[^\s'"]+\/playlist\/[0-9]+\?[^\s'"]+)/i);
      if (m2) {
        console.log("[PROXY] ✅ Found direct playlist:", m2[1]);
        return new Response(JSON.stringify({ m3u8: m2[1] }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      console.log("[PROXY] ❌ Params not found, HTML preview:", html.substring(0, 300));
      return new Response("params not found", { status: 422 });
    }

    // 2) Manifest .m3u8
    if (/\.m3u8($|\?)/i.test(target)) {
      console.log("[PROXY] Fetching manifest:", target);
      const res = await fetch(target, { redirect: "follow" });
      const text = await res.text();
      console.log("[PROXY] Manifest fetched, length:", text.length);

      if (!text.includes("#EXTM3U")) {
        console.log("[PROXY] ❌ Not a manifest, returning as text");
        return new Response(text, { status: res.status, headers: { "Content-Type": "text/plain" } });
      }

      const base = target.substring(0, target.lastIndexOf("/") + 1);
      const lines = text.split(/\r?\n/).map(line => {
        if (!line || line.startsWith("#")) {
          if (/EXT-X-KEY/i.test(line) && /URI=/i.test(line)) {
            return line.replace(/URI="([^"]+)"/i, (m, p1) => {
              const resolved = new URL(p1, base).toString();
              return `URI="/proxy?url=${encodeURIComponent(resolved)}"`;
            });
          }
          return line;
        }
        const resolved = new URL(line, base).toString();
        return `/proxy?url=${encodeURIComponent(resolved)}`;
      });
      console.log("[PROXY] ✅ Manifest rewritten");
      return new Response(lines.join("\n"), {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 3) Risorsa binaria
    console.log("[PROXY] Fetching binary resource:", target);
    const res = await fetch(target, { redirect: "follow" });
    const buf = await res.arrayBuffer();
    const ct = res.headers.get("content-type") || "application/octet-stream";
    console.log("[PROXY] ✅ Binary fetched, bytes:", buf.byteLength);
    return new Response(buf, {
      status: res.status,
      headers: { "Content-Type": ct, "Access-Control-Allow-Origin": "*" }
    });

  } catch (err) {
    console.error("[PROXY] ❌ Error:", err);
    return new Response("Proxy error: " + err.message, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}
