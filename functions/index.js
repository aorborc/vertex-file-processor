const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2/options");
const axios = require("axios");
const { Storage } = require("@google-cloud/storage");
const { GoogleAuth } = require("google-auth-library");

// Global defaults
const defaultRegion = process.env.VERTEX_LOCATION || "us-central1";
setGlobalOptions({ region: defaultRegion, timeoutSeconds: 300, memory: "1GiB" });

function projectId() {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    (process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG).projectId : undefined)
  );
}

function bucketName() {
  // Prefer Firebase config bucket if available; this is the actual GCS bucket id
  // and may be either "<project>.appspot.com" or "<project>.firebasestorage.app".
  const cfg = process.env.FIREBASE_CONFIG ? JSON.parse(process.env.FIREBASE_CONFIG) : {};
  const fbBucket = cfg.storageBucket;
  return process.env.GCS_BUCKET || fbBucket || (projectId() ? `${projectId()}.appspot.com` : undefined);
}

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

async function getAccessToken() {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token || !token.token) throw new Error("Failed to obtain Google access token");
  return token.token;
}

async function callVertex({ location, model, prompt, gsUri, mimeType, inlineDataBase64, inlineMimeType }) {
  const token = await getAccessToken();
  const preferred = model || "gemini-2.5-pro";
  const fallbacks = ["gemini-2.5-flash", "gemini-2.0-flash-001", "gemini-1.5-pro-002", "gemini-1.5-flash-002"];
  const modelsToTry = [preferred, ...fallbacks.filter((m) => m !== preferred)];

  let lastErr;
  for (const m of modelsToTry) {
    const parts = [
      { text: prompt || "" },
    ];
    if (inlineDataBase64 && inlineMimeType) {
      parts.push({ inlineData: { mimeType: inlineMimeType, data: inlineDataBase64 } });
    } else if (gsUri && mimeType) {
      parts.push({ fileData: { fileUri: gsUri, mimeType } });
    } else {
      throw new Error("callVertex missing input: either inlineDataBase64+inlineMimeType or gsUri+mimeType");
    }

    const body = { contents: [{ role: "user", parts }] };
    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId()}/locations/${location}/publishers/google/models/${m}:generateContent`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) return data;
    const msg = data?.error?.message || `Vertex request failed with ${res.status}`;
    if (res.status === 404 || /not found/i.test(msg)) {
      lastErr = new Error(`Model ${m} unavailable: ${msg}`);
      continue;
    }
    throw new Error(msg);
  }
  throw lastErr || new Error("All model attempts failed");
}

// Use the dedicated SA if provided, otherwise default runtime SA.
const saEmail = process.env.FUNCTION_SERVICE_ACCOUNT || (projectId() ? `vertex-runner@${projectId()}.iam.gserviceaccount.com` : undefined);

// Provide environmentVariables so the deployed function always has explicit values.
const defaultEnv = {
  VERTEX_LOCATION: process.env.VERTEX_LOCATION || defaultRegion,
  VERTEX_MODEL: process.env.VERTEX_MODEL || "gemini-2.5-pro",
  VERTEX_INPUT: process.env.VERTEX_INPUT || "gcs", // gcs | inline
};

exports.processFile = onRequest({ cors: true, serviceAccount: saEmail, environmentVariables: defaultEnv }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { fileUrl, prompt } = req.body || {};
    if (!fileUrl) return res.status(400).json({ error: "Missing fileUrl" });
    const isGs = typeof fileUrl === "string" && fileUrl.startsWith("gs://");
    if (!isGs && !validateUrl(fileUrl)) return res.status(400).json({ error: "Invalid fileUrl (must be http/https or gs://)" });
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "Missing prompt" });

    const bkt = bucketName();
    if (!bkt) return res.status(500).json({ error: "Bucket not configured" });

    const location = process.env.VERTEX_LOCATION || defaultRegion;
    const model = process.env.VERTEX_MODEL || "gemini-2.5-pro";

    const storage = new Storage();
    let gsUri;
    let contentType;
    let bufferForInline = null;
    if (isGs) {
      gsUri = fileUrl;
      contentType = guessMimeTypeFromUrl(gsUri);
    } else {
      const mimeFromUrl = guessMimeTypeFromUrl(fileUrl);
      const response = await axios.get(fileUrl, { responseType: "arraybuffer", timeout: 60_000 });
      bufferForInline = Buffer.from(response.data);
      contentType = response.headers["content-type"] || mimeFromUrl;

      const bucket = storage.bucket(bkt);
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const ext = contentType.includes("pdf") ? "pdf" : (mimeFromUrl.endsWith("pdf") ? "pdf" : "bin");
      const destination = `uploads/${ts}-${rand}.${ext}`;
      const file = bucket.file(destination);
      try {
        await file.save(bufferForInline, { contentType });
      } catch (e) {
        return res.status(500).json({ error: `Failed to write to bucket ${bkt}: ${e?.message || e}` });
      }
      gsUri = `gs://${bkt}/${destination}`;
    }

    // Decide input mode: gcs or inline
    const inputMode = (process.env.VERTEX_INPUT || "gcs").toLowerCase();
    const inlineBase64 = bufferForInline ? bufferForInline.toString("base64") : null;

    let vertex;
    try {
      if (inputMode === "inline" && inlineBase64) {
        vertex = await callVertex({
          location,
          model,
          prompt,
          inlineDataBase64: inlineBase64,
          inlineMimeType: contentType && contentType.includes("pdf") ? "application/pdf" : (guessMimeTypeFromUrl(gsUri) || "application/octet-stream"),
        });
      } else {
        vertex = await callVertex({
          location,
          model,
          prompt,
          gsUri,
          mimeType: contentType && contentType.includes("pdf") ? "application/pdf" : (guessMimeTypeFromUrl(gsUri) || "application/octet-stream"),
        });
      }
    } catch (e) {
      const msg = String(e?.message || e);
      // Fallback to inline if service agent isn't ready or lacks access
      if (inlineBase64 && /Service agents are being provisioned|Permission|not\s*found/i.test(msg)) {
        try {
          vertex = await callVertex({
            location,
            model,
            prompt,
            inlineDataBase64: inlineBase64,
            inlineMimeType: contentType && contentType.includes("pdf") ? "application/pdf" : (guessMimeTypeFromUrl(gsUri) || "application/octet-stream"),
          });
        } catch (e2) {
          return res.status(500).json({ error: String(e2?.message || e2) });
        }
      } else {
        return res.status(500).json({ error: msg });
      }
    }

    // Parse model output into JSON and add *_confidence fields
    function extractTextFromVertex(v) {
      try {
        const parts = v?.candidates?.[0]?.content?.parts || [];
        const textPart = parts.find((p) => typeof p.text === "string");
        return textPart?.text || null;
      } catch { return null; }
    }
    function parseJsonLoose(s) {
      if (!s || typeof s !== "string") return null;
      const cleaned = s.replace(/^```json\n?|```$/gi, "").replace(/^```\n?|```$/gi, "");
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      const core = start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;
      try { return JSON.parse(core); } catch { return null; }
    }
    function withFieldConf(data) {
      if (!data || typeof data !== "object") return null;
      const out = { ...data };
      const conf = data.fields_confidence || data.field_confidence || {};
      // Top-level fields
      Object.keys(data).forEach((k) => {
        if (k === "fields_confidence" || k === "line_items") return;
        const key = `${k}_confidence`;
        if (out[key] == null && conf && Object.prototype.hasOwnProperty.call(conf, k)) {
          out[key] = conf[k];
        }
      });
      // Line items
      if (Array.isArray(data.line_items)) {
        out.line_items = data.line_items.map((item) => {
          if (!item || typeof item !== "object") return item;
          const li = { ...item };
          const baseConf = typeof item.confidence === "number" ? item.confidence : null;
          ["description", "quantity", "unit_price", "amount"].forEach((f) => {
            const key = `${f}_confidence`;
            if (li[key] == null && baseConf != null && (f in li)) li[key] = baseConf;
          });
          return li;
        });
      }
      return out;
    }

    const modelText = extractTextFromVertex(vertex);
    const modelJson = parseJsonLoose(modelText);
    const modelJsonWithConfidence = withFieldConf(modelJson);

    return res.status(200).json({
      success: true,
      gcsUri: gsUri,
      extracted: modelJsonWithConfidence || null,
      extractedRaw: modelJson || null,
      vertex,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
});
