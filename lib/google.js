import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";

// Prefer ADC on any GCP runtime (Cloud Functions/Run/GCE/GAE). Only use JSON locally.
const runningOnGcp = !!process.env.K_SERVICE || !!process.env.FUNCTION_TARGET || !!process.env.GAE_ENV || !!process.env.GCE_METADATA_HOST;
// Support inline JSON via either GOOGLE_APPLICATION_CREDENTIALS_JSON or (if it looks like JSON) GOOGLE_APPLICATIONS_CREDENTIALS
let rawJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "";
const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
if (!rawJson && gac && gac.trim().startsWith("{")) rawJson = gac;
let credentials;
try {
  credentials = rawJson && !runningOnGcp ? JSON.parse(rawJson) : undefined;
} catch (e) {
  credentials = undefined;
}

// Initialize Storage via ADC if no inline credentials were supplied
export const storage = credentials ? new Storage({ credentials }) : new Storage();

export async function getAccessTokenWithScopes(scopes = ["https://www.googleapis.com/auth/cloud-platform"]) {
  const auth = new GoogleAuth({
    credentials,
    scopes,
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token || !token.token) throw new Error("Failed to obtain Google access token");
  return token.token;
}

export async function getAccessToken() {
  return getAccessTokenWithScopes(["https://www.googleapis.com/auth/cloud-platform"]);
}

export function detectAuthMode() {
  if (runningOnGcp && !credentials) return "adc"; // runtime ADC
  if (!runningOnGcp && credentials) return "json"; // local key file
  if (!runningOnGcp && !credentials) return "adc-local"; // gcloud ADC or other
  return "unknown";
}

export async function getProjectId() {
  const auth = new GoogleAuth({ credentials });
  try {
    const pid = await auth.getProjectId();
    return pid || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || null;
  } catch {
    return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || null;
  }
}

export async function uploadBufferToGCS({ bucketName, destination, buffer, contentType }) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(destination);
  await file.save(buffer, { contentType });
  return `gs://${bucketName}/${destination}`;
}

const THINKING_MODEL_HINTS = [/gemini-2\.5-pro/i];

function modelSupportsThinking(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  return THINKING_MODEL_HINTS.some((expr) => expr.test(lower));
}

function normalizeVertexRequests({ requests, prompt, gsUri, mimeType, inlineDataBase64, inlineMimeType }) {
  const basePrompt = typeof prompt === "string" ? prompt : "";
  const hasExplicit = Array.isArray(requests) && requests.length > 0;
  const source = hasExplicit ? requests : [{ prompt: basePrompt, gsUri, mimeType, inlineDataBase64, inlineMimeType }];
  return source.map((entry, index) => {
    const e = entry || {};
    const entryPrompt = typeof e.prompt === "string" ? e.prompt : basePrompt;
    const inlineData = e.inlineDataBase64 || e.inlineData || (!hasExplicit ? inlineDataBase64 : undefined);
    const inlineType = e.inlineMimeType || e.inline_mime_type || (!hasExplicit ? inlineMimeType : undefined);
    const fileUri = e.gsUri || e.fileUri || e.file_uri || (!hasExplicit ? gsUri : undefined);
    const fileMime = e.mimeType || e.fileMimeType || e.file_mime_type || (!hasExplicit ? mimeType : undefined);
    const generationConfig = e.generationConfig || e.generation_config || null;
    const systemInstruction = e.systemInstruction || e.system_instruction || null;
    const tools = e.tools || null;
    const toolConfig = e.toolConfig || e.tool_config || null;
    const safetySettings = e.safetySettings || e.safety_settings || null;

    if (inlineData) {
      if (!inlineType) throw new Error(`callVertexGenerateContent request ${index} missing inlineMimeType`);
      return {
        prompt: entryPrompt,
        inlineDataBase64: inlineData,
        inlineMimeType: inlineType,
        generationConfig,
        systemInstruction,
        tools,
        toolConfig,
        safetySettings,
      };
    }
    if (fileUri && fileMime) {
      return {
        prompt: entryPrompt,
        gsUri: fileUri,
        mimeType: fileMime,
        generationConfig,
        systemInstruction,
        tools,
        toolConfig,
        safetySettings,
      };
    }
    throw new Error(`callVertexGenerateContent request ${index} missing gsUri+mimeType or inline data`);
  });
}

export async function callVertexGenerateContent({ projectId, location, model, gsUri, prompt, mimeType, inlineDataBase64, inlineMimeType, requests, useBatch = true }) {
  const token = await getAccessToken();
  const normalizedModel = typeof model === "string" && model.trim() ? model.trim() : (process.env.VERTEX_MODEL || "gemini-2.5-flash");
  const fallbackCandidates = [
    normalizedModel,
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash-001",
    "gemini-1.5-pro-002",
    "gemini-1.5-flash-002",
  ];
  const modelsToTry = Array.from(new Set(fallbackCandidates.filter(Boolean)));
  const resolvedLocation = location || process.env.VERTEX_LOCATION || "us-central1";
  const normalizedRequests = normalizeVertexRequests({ requests, prompt, gsUri, mimeType, inlineDataBase64, inlineMimeType });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  let lastErr;
  for (const m of modelsToTry) {
    let requestBodies;
    try {
      requestBodies = normalizedRequests.map((req) => {
        const parts = [{ text: req.prompt || "" }];
        if (req.inlineDataBase64 && req.inlineMimeType) {
          parts.push({ inlineData: { mimeType: req.inlineMimeType, data: req.inlineDataBase64 } });
        } else if (req.gsUri && req.mimeType) {
          parts.push({ fileData: { fileUri: req.gsUri, mimeType: req.mimeType } });
        } else {
          throw new Error("callVertexGenerateContent missing input: either inlineDataBase64+inlineMimeType or gsUri+mimeType");
        }

        const body = { contents: [{ role: "user", parts }] };
        const generationConfig = { ...(req.generationConfig || {}) };
        if (modelSupportsThinking(m)) {
          generationConfig.thinkingConfig = {
            ...(generationConfig.thinkingConfig || {}),
            includeThoughts: false,
          };
        }
        if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
        if (req.systemInstruction) body.systemInstruction = req.systemInstruction;
        if (req.tools) body.tools = req.tools;
        if (req.toolConfig) body.toolConfig = req.toolConfig;
        if (req.safetySettings) body.safetySettings = req.safetySettings;
        return body;
      });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    const baseUrl = `https://${resolvedLocation}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${resolvedLocation}/publishers/google/models/${m}`;

    if (useBatch !== false) {
      try {
        const batchEndpoint = `${baseUrl}:batchGenerateContent`;
        const res = await fetch(batchEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ requests: requestBodies }),
        });
        let data;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (res.ok) {
          const responses = Array.isArray(data?.responses) ? data.responses : [];
          if (requestBodies.length === 1) {
            return responses[0] || responses || data;
          }
          return responses;
        }
        const msg = data?.error?.message || `Vertex batch request failed with ${res.status}`;
        if (res.status === 404 || res.status === 400 || /not found/i.test(msg) || /unimplemented/i.test(msg)) {
          lastErr = new Error(`Model ${m} batch unavailable: ${msg}`);
        } else {
          throw new Error(msg);
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (useBatch === false) {
          lastErr = e;
          break;
        }
        lastErr = e;
        // fall back to per-request generateContent for this model
      }
    }

    const singleEndpoint = `${baseUrl}:generateContent`;
    if (requestBodies.length === 1) {
      const res = await fetch(singleEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBodies[0]),
      });
      let data;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.ok) return data;
      const msg = data?.error?.message || `Vertex request failed with ${res.status}`;
      if (res.status === 404 || /not found/i.test(msg)) {
        lastErr = new Error(`Model ${m} unavailable: ${msg}`);
        continue;
      }
      throw new Error(msg);
    }

    const responses = [];
    let retryWithNextModel = false;
    for (const body of requestBodies) {
      const res = await fetch(singleEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      let data;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.ok) {
        responses.push(data);
        continue;
      }
      const msg = data?.error?.message || `Vertex request failed with ${res.status}`;
      if (res.status === 404 || /not found/i.test(msg)) {
        lastErr = new Error(`Model ${m} unavailable: ${msg}`);
        retryWithNextModel = true;
        break;
      }
      throw new Error(msg);
    }
    if (retryWithNextModel) continue;
    return responses;
  }
  throw lastErr || new Error("All model attempts failed");
}
