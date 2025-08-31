export const runtime = 'nodejs';

import { Storage } from "@google-cloud/storage";

function parseGsUri(gsUri) {
  const m = /^gs:\/\/([^\/]+)\/(.+)$/.exec(gsUri || "");
  if (!m) return null;
  return { bucket: m[1], name: decodeURIComponent(m[2]) };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const gsUri = searchParams.get("gsUri") || searchParams.get("gcsUri");
    const ttlSec = Math.min(60 * 60, Math.max(60, Number(searchParams.get("ttlSec") || 600))); // 1–60 min
    if (!gsUri) {
      return new Response(JSON.stringify({ error: "Missing gsUri" }), { status: 400 });
    }
    const parsed = parseGsUri(gsUri);
    if (!parsed) {
      return new Response(JSON.stringify({ error: "Invalid gsUri" }), { status: 400 });
    }
    const storage = new Storage();
    const file = storage.bucket(parsed.bucket).file(parsed.name);
    const expires = Date.now() + ttlSec * 1000;
    const [url] = await file.getSignedUrl({ version: "v4", action: "read", expires });
    return new Response(JSON.stringify({ url, expires }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), { status: 500 });
  }
}

