// netlify/functions/proxy.js
// Netlify Function che esegue un vero proxyfetch server-side:
// - per pagine vixsrc: fetch server-side, estrazione token/expires/url/canPlayFHD, restituisce JSON { m3u8 }
// - per manifest .m3u8: fetch server-side, riscrive tutte le URL per far passare i segmenti dal proxy
// - per risorse binarie: fetch server-side e ritorna base64 (isBase64Encoded: true)

exports.handler = async function(event) {
  const params = event.queryStringParameters || {};
  const target = params.url;
  if (!target) {
    console.log("[PROXY] ❌ Missing url param");
    return { statusCode: 400, body: "Missing url" };
  }

  console.log("[PROXY] ▶ Proxyfetch request for:", target);

  try {
    // --- 1) Pagina vixsrc (movie/tv) -> estrai m3u8
    if (/vixsrc\.to\/(movie|tv)\//i.test(target)) {
      console.log("[PROXY] Fetching vixsrc page (server-side):", target);
      const pageRes = await fetch(target, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://vixsrc.to" },
        redirect: "follow"
      });

      const html = await pageRes.text();
      console.log("[PROXY] Page fetched, length:", html.length);

      // regex permissiva ispirata al tuo script Python
      const re = /token['"]?\s*[:=]\s*['"]?([^'"]+)['"].{0,300}expires['"]?\s*[:=]\s*['"]?(\d{9,})['"].{0,600}url\s*[:=]\s*['"]([^'"]+)['"].{0,200}canPlayFHD\s*[:=]\s*(true|false)/i;
      const m = html.match(re);
      if (m) {
        const token = m[1], expires = m[2], rawUrl = m[3], fhd = m[4] === "true";
        try {
          const u = new URL(rawUrl);
          u.searchParams.set("token", token);
          u.searchParams.set("expires", expires);
          if (fhd) u.searchParams.set("h", "1");
          const m3u8 = u.toString();
          console.log("[PROXY] ✅ Extracted m3u8 (server-side):", m3u8);
          return {
            statusCode: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ m3u8 })
          };
        } catch (e) {
          console.log("[PROXY] ❌ Invalid rawUrl:", rawUrl, e.message || e);
        }
      }

      // fallback: cerca playlist già completa nel HTML
      const m2 = html.match(/(https?:\/\/[^\s'"]+\/playlist\/[0-9]+\?[^\s'"]+)/i);
      if (m2) {
        console.log("[PROXY] ✅ Found direct playlist (server-side):", m2[1]);
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ m3u8: m2[1] })
        };
      }

      // se non troviamo i parametri, log dell'anteprima HTML per debug
      console.log("[PROXY] ❌ Params not found, HTML preview (300 chars):", html.substring(0, 300));
      return { statusCode: 422, headers: { "Access-Control-Allow-Origin": "*" }, body: "params not found" };
    }

    // --- 2) Manifest .m3u8 -> fetch server-side e riscrittura per proxare segmenti/chiavi
    if (/\.m3u8($|\?)/i.test(target)) {
      console.log("[PROXY] Fetching manifest (server-side):", target);
      const res = await fetch(target, { redirect: "follow" });
      const text = await res.text();
      console.log("[PROXY] Manifest fetched, length:", text.length);

      // se non è manifest, restituisci come testo
      if (!text.includes("#EXTM3U")) {
        console.log("[PROXY] ❌ Not a manifest, returning raw text");
        return {
          statusCode: res.status,
          headers: { "Content-Type": res.headers.get("content-type") || "text/plain", "Access-Control-Allow-Origin": "*" },
          body: text
        };
      }

      // base per risolvere relativi
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
          // gestisci EXT-X-KEY con URI="..."
          if (/EXT-X-KEY/i.test(line) && /URI=/i.test(line)) {
            return line.replace(/URI="([^"]+)"/i, (m, p1) => {
              const resolved = (() => { try { return new URL(p1, base).toString(); } catch { return p1; } })();
              return `URI="/.netlify/functions/proxy?url=${encodeURIComponent(resolved)}"`;
            });
          }
          return line;
        }
        // riga che contiene URL o percorso relativo
        const resolved = (() => { try { return new URL(line.trim(), base).toString(); } catch { return line.trim(); } })();
        return `/.netlify/functions/proxy?url=${encodeURIComponent(resolved)}`;
      }).join("\n");

      console.log("[PROXY] ✅ Manifest rewritten (server-side), length:", rewritten.length);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*" },
        body: rewritten
      };
    }

    // --- 3) Risorsa binaria -> fetch server-side e ritorna base64
    console.log("[PROXY] Fetching binary resource (server-side):", target);
    const binRes = await fetch(target, { redirect: "follow" });
    const arrayBuffer = await binRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = binRes.headers.get("content-type") || "application/octet-stream";
    console.log("[PROXY] ✅ Binary fetched (server-side), bytes:", buffer.length, "content-type:", contentType);

    return {
      statusCode: binRes.status,
      headers: { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" },
      isBase64Encoded: true,
      body: buffer.toString("base64")
    };

  } catch (err) {
    console.error("[PROXY] ❌ Error (server-side):", err && err.message ? err.message : err);
    return { statusCode: 500, headers: { "Access-Control-Allow-Origin": "*" }, body: "Proxy error: " + (err && err.message ? err.message : String(err)) };
  }
};
