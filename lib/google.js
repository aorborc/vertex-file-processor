import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";

// Prefer ADC on any GCP runtime (Cloud Functions/Run/GCE/GAE). Only use JSON locally.
const runningOnGcp = !!process.env.K_SERVICE || !!process.env.FUNCTION_TARGET || !!process.env.GAE_ENV || !!process.env.GCE_METADATA_HOST;
const credentialsJSON = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "";
let credentials;
try {
  credentials = credentialsJSON && !runningOnGcp ? JSON.parse(credentialsJSON) : undefined;
} catch (e) {
  credentials = undefined;
}

export const storage = new Storage({ credentials });

export async function getAccessToken() {
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token || !token.token) throw new Error("Failed to obtain Google access token");
  return token.token;
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

export async function callVertexGenerateContent({ projectId, location, model, gsUri, prompt, mimeType }) {
  const token = await getAccessToken();
  const preferred = model || "gemini-2.5-pro";
  const fallbacks = ["gemini-2.5-flash", "gemini-2.0-flash-001", "gemini-1.5-pro-002", "gemini-1.5-flash-002"];
  const modelsToTry = [preferred, ...fallbacks.filter((m) => m !== preferred)];

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt || "" },
          { fileData: { fileUri: gsUri, mimeType } },
        ],
      },
    ],
  };

  let lastErr;
  for (const m of modelsToTry) {
    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${m}:generateContent`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) return data;
    const msg = data?.error?.message || `Vertex request failed with ${res.status}`;
    // Try next model on not-found errors; otherwise bail
    if (res.status === 404 || /not found/i.test(msg)) {
      lastErr = new Error(`Model ${m} unavailable: ${msg}`);
      continue;
    }
    throw new Error(msg);
  }
  throw lastErr || new Error("All model attempts failed");
}
