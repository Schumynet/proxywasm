// netlify/functions/proxy.js
// Netlify Function "proxy" - file intero
//
// Funzionalità:
// - Se target è una pagina vixsrc (movie/tv) prova a estrarre token/expires/url/canPlayFHD
//   * Usa cloudscraper se è installato (risolve challenge JS/Cloudflare nella maggior parte dei casi)
//   * Altrimenti prova con fetch normale (meno affidabile)
// - Se target è un .m3u8 riscrive tutte le URL (variant playlists, segmenti, EXT-X-KEY) in modo che
//   tutte le risorse passino di nuovo dal proxy
// - Per risorse binarie (.ts, key, immagini, ecc.) fa proxyfetch server-side e ritorna base64
// - Log dettagliati per debug (console.log)
// - Restituisce JSON con preview HTML quando non trova i parametri (utile per capire challenge)

const EXTRACTOR_USE_CLOUDSCRAPER = true; // imposta a false se non vuoi usare cloudscraper
let cloudscraper = null;
if (EXTRACTOR_USE_CLOUDSCRAPER) {
  try {
    cloudscraper = require("cloudscraper");
    console.log("[PROXY] cloudscraper disponibile, lo userò per fetch delle pagine vixsrc");
  } catch (e) {
    console.log("[PROXY] cloudscraper non trovato, userò fetch normale. Per installarlo: npm i cloudscraper");
    cloudscraper = null;
  }
}

exports.handler = async function (event) {
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
      console.log("[PROXY] Handling vixsrc page:", target);

      // funzione helper per fetch della pagina (cloudscraper se disponibile)
      async function fetchPage(url) {
        if (cloudscraper) {
          try {
            // cloudscraper.get restituisce il body come stringa
            const html = await cloudscraper.get(url, {
              headers: { Referer: "https://vixsrc.to", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
              timeout: 30000
            });
            return { ok: true, text: html };
          } catch (err) {
            console.log("[PROXY] cloudscraper fetch error:", String(err).substring(0, 300));
            return { ok: false, error: String(err) };
          }
        } else {
          // fallback: fetch globale (Node 18+ in Netlify)
          try {
            const r = await fetch(url, { headers: { Referer: "https://vixsrc.to", "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
            const text = await r.text();
            return { ok: r.ok, status: r.status, text };
          } catch (err) {
            console.log("[PROXY] fetch error:", String(err).substring(0, 300));
            return { ok: false, error: String(err) };
          }
        }
      }

      const pageFetch = await fetchPage(target);
      if (!pageFetch.ok) {
        const errMsg = pageFetch.error || `status ${pageFetch.status}`;
        console.log("[PROXY] ❌ Page fetch failed:", errMsg);
        return { statusCode: 502, body: "Page fetch failed: " + errMsg };
      }

      const html = pageFetch.text || "";
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
          console.log("[PROXY] ✅ Extracted m3u8:", m3u8);
          return {
            statusCode: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ m3u8 })
          };
        } catch (e) {
          console.log("[PROXY] ❌ Invalid rawUrl:", rawUrl, e && e.message ? e.message : e);
        }
      }

      // fallback: cerca playlist già completa nel HTML
      const m2 = html.match(/(https?:\/\/[^\s'"]+\/playlist\/[0-9]+\?[^\s'"]+)/i);
      if (m2) {
        console.log("[PROXY] ✅ Found direct playlist:", m2[1]);
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ m3u8: m2[1] })
        };
      }

      // Non trovato: restituisci preview HTML per debug (utile per capire se è challenge Cloudflare)
      console.log("[PROXY] ❌ Params not found, HTML preview (300 chars):", html.substring(0, 300));
      return {
        statusCode: 422,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "params_not_found", page_length: html.length, html_preview: html.substring(0, 2000) })
      };
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

      console.log("[PROXY] ✅ Manifest rewritten, length:", rewritten.length);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*" },
        body: rewritten
      };
    }

    // --- 3) Risorsa binaria -> fetch server-side e ritorna base64 (Netlify Function richiede base64 per body binari)
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
