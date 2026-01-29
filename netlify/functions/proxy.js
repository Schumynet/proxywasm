// Usa node-fetch v2 per compatibilità CommonJS
const fetch = require("node-fetch");

exports.handler = async function(event) {
  const url = event.queryStringParameters.url;
  if (!url) {
    console.error("[PROXY] ❌ Nessun URL fornito");
    return { statusCode: 400, body: "Missing url" };
  }

  try {
    console.log("[PROXY] ▶ Richiesta ricevuta per:", url);

    // Segui i redirect (alcuni link firmati rimandano ad altri endpoint)
    const response = await fetch(url, { redirect: "follow" });

    // Leggi il body come testo
    const text = await response.text();

    // Log dettagliati
    console.log("[PROXY] ✅ Fetch completato");
    console.log("[PROXY] Status:", response.status);
    console.log("[PROXY] Content-Type:", response.headers.get("content-type"));
    console.log("[PROXY] Lunghezza body:", text.length);
    console.log("[PROXY] Anteprima body:", text.substring(0, 200));

    // Restituisci al client
    return {
      statusCode: response.status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        // Forza Content-Type come manifest HLS
        "Content-Type": "application/vnd.apple.mpegurl"
      },
      body: text
    };
  } catch (err) {
    console.error("[PROXY] ❌ Errore:", err.message);
    return { statusCode: 500, body: "Proxy error: " + err.message };
  }
};
