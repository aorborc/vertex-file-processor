export const runtime = 'nodejs';

import axios from "axios";
import { uploadBufferToGCS, callVertexGenerateContent } from "@/lib/google";

function validateUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function guessMimeTypeFromUrl(url) {
  const ext = (url.split("?")[0].split(".").pop() || "").toLowerCase();
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { fileUrl, prompt } = body || {};
    const isGs = typeof fileUrl === 'string' && fileUrl.startsWith('gs://');
    if (!fileUrl || (!isGs && !validateUrl(fileUrl))) {
      return new Response(JSON.stringify({ error: "Invalid or missing fileUrl (must be http/https or gs://)" }), { status: 400 });
    }
    if (!prompt || typeof prompt !== "string") {
      return new Response(JSON.stringify({ error: "Missing prompt" }), { status: 400 });
    }

    const bucketName = process.env.GCS_BUCKET;
    if (!bucketName) {
      return new Response(JSON.stringify({ error: "Server missing GCS_BUCKET env" }), { status: 500 });
    }

    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
    const locationRaw = body?.location;
    const location = typeof locationRaw === 'string' && locationRaw.trim() ? locationRaw.trim() : (process.env.VERTEX_LOCATION || "us-central1");
    const model = "gemini-2.5-flash";
    const useBatchRaw = body?.useBatch;
    const useBatch = (() => {
      if (useBatchRaw == null) return true;
      const normalized = String(useBatchRaw).trim().toLowerCase();
      return !(normalized === 'false' || normalized === '0' || normalized === 'no');
    })();
    if (!projectId) {
      return new Response(JSON.stringify({ error: "Server missing GOOGLE_CLOUD_PROJECT env" }), { status: 500 });
    }

    let gsUri;
    let contentType;
    if (isGs) {
      gsUri = fileUrl;
      contentType = guessMimeTypeFromUrl(gsUri);
    } else {
      const mimeFromUrl = guessMimeTypeFromUrl(fileUrl);
      const response = await axios.get(fileUrl, { responseType: "arraybuffer", timeout: 60_000 });
      const buffer = Buffer.from(response.data);
      contentType = response.headers["content-type"] || mimeFromUrl;

      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const ext = contentType.includes("pdf") ? "pdf" : (mimeFromUrl.endsWith("pdf") ? "pdf" : "bin");
      const destination = `uploads/${ts}-${rand}.${ext}`;

      gsUri = await uploadBufferToGCS({
        bucketName,
        destination,
        buffer,
        contentType,
      });
    }

    const vertex = await callVertexGenerateContent({
      projectId,
      location,
      model,
      gsUri,
      prompt,
      mimeType: contentType.includes("pdf") ? "application/pdf" : guessMimeTypeFromUrl(gsUri),
      useBatch,
    });

    return new Response(JSON.stringify({ success: true, gcsUri: gsUri, vertex }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err?.message || "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
