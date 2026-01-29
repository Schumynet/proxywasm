const fetch = require("node-fetch");

exports.handler = async function(event, context) {
  const url = event.queryStringParameters.url;
  if (!url) {
    return {
      statusCode: 400,
      body: "Missing url"
    };
  }

  try {
    const response = await fetch(url);
    const text = await response.text();

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain"
      },
      body: text
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: "Proxy error: " + err.message
    };
  }
};
