/**
 * Cloudflare Worker: static Trace UI + Vectorizer.AI API proxy.
 * Secrets: VECTORIZER_API_ID, VECTORIZER_API_SECRET
 * Optional var: VECTORIZER_MODE = production | test
 */

const VECTORIZE_URL = "https://vectorizer.ai/api/v1/vectorize";
const MAX_BYTES = 12 * 1024 * 1024;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleVectorize(request, env) {
  const id = env.VECTORIZER_API_ID;
  const secret = env.VECTORIZER_API_SECRET;
  if (!id || !secret) {
    return json(503, {
      error:
        "Vectorizer.AI is not configured. Set VECTORIZER_API_ID and VECTORIZER_API_SECRET in Cloudflare Worker secrets.",
    });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: "Expected multipart form upload." });
  }

  const image = form.get("image");
  if (!image || typeof image === "string") {
    return json(400, { error: "Missing image file." });
  }
  if (image.size > MAX_BYTES) {
    return json(413, { error: "Image too large (max 12 MB)." });
  }

  const mode = (form.get("mode") || env.VECTORIZER_MODE || "production").toString();
  const allowed = new Set(["production", "preview", "test", "test_preview"]);
  if (!allowed.has(mode)) {
    return json(400, { error: "Invalid mode." });
  }

  const outbound = new FormData();
  outbound.append("image", image, image.name || "upload.png");
  outbound.append("mode", mode);
  outbound.append("output.file_format", "svg");

  const auth = btoa(`${id}:${secret}`);
  let upstream;
  try {
    upstream = await fetch(VECTORIZE_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      body: outbound,
    });
  } catch (err) {
    return json(502, { error: "Could not reach Vectorizer.AI.", detail: String(err) });
  }

  const creditsCharged = upstream.headers.get("X-Credits-Charged") || "";
  const creditsCalculated = upstream.headers.get("X-Credits-Calculated") || "";
  const imageToken = upstream.headers.get("X-Image-Token") || "";

  if (!upstream.ok) {
    const detail = await upstream.text();
    return json(upstream.status, {
      error: "Vectorizer.AI request failed.",
      detail: detail.slice(0, 2000),
    });
  }

  const svg = await upstream.text();
  return new Response(svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-store",
      "x-credits-charged": creditsCharged,
      "x-credits-calculated": creditsCalculated,
      ...(imageToken ? { "x-image-token": imageToken } : {}),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/vectorize") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "content-type",
            "access-control-max-age": "86400",
          },
        });
      }
      if (request.method !== "POST") {
        return json(405, { error: "POST only." });
      }
      return handleVectorize(request, env);
    }

    if (url.pathname === "/api/health") {
      return json(200, {
        ok: true,
        configured: Boolean(env.VECTORIZER_API_ID && env.VECTORIZER_API_SECRET),
        mode: env.VECTORIZER_MODE || "production",
      });
    }

    return env.ASSETS.fetch(request);
  },
};
