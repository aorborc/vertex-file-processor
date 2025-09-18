const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2/options");
const axios = require("axios");
const { Storage } = require("@google-cloud/storage");
const { Firestore } = require("@google-cloud/firestore");
const { GoogleAuth } = require("google-auth-library");
const crypto = require("crypto");

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

function normalizeVertexRequests({ requests, prompt, inlineDataBase64, inlineMimeType, gsUri, mimeType }) {
  const basePrompt = typeof prompt === "string" ? prompt : "";
  const hasExplicit = Array.isArray(requests) && requests.length > 0;
  const source = hasExplicit ? requests : [{ prompt: basePrompt, inlineDataBase64, inlineMimeType, gsUri, mimeType }];
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
      if (!inlineType) throw new Error(`callVertex request ${index} missing inlineMimeType`);
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
    throw new Error(`callVertex request ${index} missing gsUri+mimeType or inline data`);
  });
}

async function callVertex({ location, model, prompt, gsUri, mimeType, inlineDataBase64, inlineMimeType, requests, useBatch = true }) {
  const token = await getAccessToken();
  const normalizedModel = "gemini-2.5-flash";
  const fallbackCandidates = [
    normalizedModel,
    "gemini-2.5-flash",
    "gemini-2.0-flash-001",
    "gemini-1.5-flash-002",
  ];
  const modelsToTry = Array.from(new Set(fallbackCandidates.filter(Boolean)));
  const project = projectId();
  if (!project) throw new Error("Unable to determine Google Cloud project id");
  const resolvedLocation = location || process.env.VERTEX_LOCATION || defaultRegion;
  const normalizedRequests = normalizeVertexRequests({ requests, prompt, inlineDataBase64, inlineMimeType, gsUri, mimeType });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

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
          throw new Error("callVertex missing input: either inlineDataBase64+inlineMimeType or gsUri+mimeType");
        }

        const body = { contents: [{ role: "user", parts }] };
        const generationConfig = { ...(req.generationConfig || {}) };
        const thinkingConfigProto = {
          ...(generationConfig.thinking_config || {}),
          include_thoughts: false,
          thinking_budget: 0,
        };
        generationConfig.thinking_config = thinkingConfigProto;
        generationConfig.thinkingConfig = {
          ...(generationConfig.thinkingConfig || {}),
          includeThoughts: false,
          thinkingBudget: 0,
        };
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

    const baseUrl = `https://${resolvedLocation}-aiplatform.googleapis.com/v1/projects/${project}/locations/${resolvedLocation}/publishers/google/models/${m}`;

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

// Firestore helpers (support named DB with fallback to default on NOT_FOUND)
function getFirestoreClient(named) {
  try {
    if (named) return new Firestore({ databaseId: named });
    return new Firestore();
  } catch (e) {
    console.error("Firestore init error:", e?.message || e);
    return null;
  }
}
function hashId(str) { return crypto.createHash("sha256").update(String(str)).digest("hex"); }
async function readCache(coll, id) {
  const named = process.env.FIRESTORE_DATABASE_ID;
  const clients = [getFirestoreClient(named), !named ? null : getFirestoreClient(undefined)];
  for (const client of clients) {
    if (!client) continue;
    try {
      const d = await client.collection(coll).doc(id).get();
      if (d.exists) return d.data();
      return null; // doc not found is fine
    } catch (e) {
      // 5 NOT_FOUND indicates DB not found; try fallback
      if (String(e?.code) === '5' || /NOT_FOUND/i.test(String(e?.message || ''))) {
        console.warn(`Firestore readCache ${coll}/${id} NOT_FOUND on ${(client._settings && client._settings.databaseId) || 'default'}; trying fallback`);
        continue;
      }
      console.warn(`Firestore readCache ${coll}/${id} error:`, e?.message || e);
      return null;
    }
  }
  return null;
}
async function writeCache(coll, id, data) {
  const named = process.env.FIRESTORE_DATABASE_ID;
  const clients = [getFirestoreClient(named), !named ? null : getFirestoreClient(undefined)];
  for (const client of clients) {
    if (!client) continue;
    try {
      await client.collection(coll).doc(id).set({ ...data, updatedAt: new Date().toISOString() });
      return true;
    } catch (e) {
      if (String(e?.code) === '5' || /NOT_FOUND/i.test(String(e?.message || ''))) {
        console.warn(`Firestore writeCache ${coll}/${id} NOT_FOUND on ${(client._settings && client._settings.databaseId) || 'default'}; trying fallback`);
        continue;
      }
      console.warn(`Firestore writeCache ${coll}/${id} error:`, e?.message || e);
      return false;
    }
  }
  return false;
}

// Use the dedicated SA if provided, otherwise default runtime SA.
const saEmail = process.env.FUNCTION_SERVICE_ACCOUNT || (projectId() ? `vertex-runner@${projectId()}.iam.gserviceaccount.com` : undefined);

// Provide environmentVariables so the deployed function always has explicit values.
const defaultEnv = {
  VERTEX_LOCATION: process.env.VERTEX_LOCATION || defaultRegion,
  VERTEX_MODEL: process.env.VERTEX_MODEL || "gemini-2.5-flash",
  VERTEX_INPUT: process.env.VERTEX_INPUT || "gcs", // gcs | inline
  FIRESTORE_DATABASE_ID: process.env.FIRESTORE_DATABASE_ID || "sw-vertex-processor",
};

exports.processFile = onRequest({ cors: true, serviceAccount: saEmail, environmentVariables: defaultEnv }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const { fileUrl, prompt } = body;
    const resetRaw = (req.query && req.query.reset) || (body && body.reset);
    const reset = String(resetRaw).toLowerCase() === 'true' || resetRaw === 1 || resetRaw === '1';
    if (reset) console.log('Reset flag ignored: vertex response caching disabled');
    if (!fileUrl) return res.status(400).json({ error: "Missing fileUrl" });
    const isGs = typeof fileUrl === "string" && fileUrl.startsWith("gs://");
    if (!isGs && !validateUrl(fileUrl)) return res.status(400).json({ error: "Invalid fileUrl (must be http/https or gs://)" });
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "Missing prompt" });

    const bkt = bucketName();
    if (!bkt) return res.status(500).json({ error: "Bucket not configured" });

    const locationRaw = (body && body.location) || (req.query && req.query.location);
    const location = typeof locationRaw === "string" && locationRaw.trim() ? locationRaw.trim() : (process.env.VERTEX_LOCATION || defaultRegion);
    const model = "gemini-2.5-flash";
    const useBatchRaw = body?.useBatch ?? (req.query && req.query.useBatch);
    const useBatch = (() => {
      if (useBatchRaw == null) return true;
      const normalized = String(useBatchRaw).trim().toLowerCase();
      return !(normalized === "false" || normalized === "0" || normalized === "no");
    })();

    const storage = new Storage();
    let gsUri;
    let contentType;
    let bufferForInline = null;
    if (isGs) {
      gsUri = fileUrl;
      contentType = guessMimeTypeFromUrl(gsUri);
    } else {
      const urlDocId = hashId(fileUrl);
      const urlCached = await readCache('urlCache', urlDocId);
      if (urlCached && urlCached.gsUri) {
        gsUri = urlCached.gsUri;
        contentType = urlCached.contentType || guessMimeTypeFromUrl(gsUri);
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
        await writeCache('urlCache', urlDocId, { sourceUrl: fileUrl, gsUri, contentType, size: bufferForInline?.length || null, createdAt: new Date().toISOString() });
      }
    }

    let modelJson = null;
    let modelJsonWithConfidence = null;
    let vertex;
    let usageInfo = null;

    // Decide input mode: gcs or inline
    const inputMode = (process.env.VERTEX_INPUT || "gcs").toLowerCase();
    const inlineBase64 = bufferForInline ? bufferForInline.toString("base64") : null;

    if (!vertex) {
      try {
        if (inputMode === "inline" && inlineBase64) {
          vertex = await callVertex({
            location,
            model,
            prompt,
            inlineDataBase64: inlineBase64,
            inlineMimeType: contentType && contentType.includes("pdf") ? "application/pdf" : (guessMimeTypeFromUrl(gsUri) || "application/octet-stream"),
            useBatch,
          });
        } else {
          vertex = await callVertex({
            location,
            model,
            prompt,
            gsUri,
            mimeType: contentType && contentType.includes("pdf") ? "application/pdf" : (guessMimeTypeFromUrl(gsUri) || "application/octet-stream"),
            useBatch,
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
              useBatch,
            });
          } catch (e2) {
            return res.status(500).json({ error: String(e2?.message || e2) });
          }
        } else {
          return res.status(500).json({ error: msg });
        }
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
          ["description", "indent_qty", "dispatch_qty", "received_qty", "quantity", "unit_price", "amount"].forEach((f) => {
            const key = `${f}_confidence`;
            if (li[key] == null && baseConf != null && (f in li)) li[key] = baseConf;
          });
          return li;
        });
      }
      return out;
    }

    function extractUsageFromVertex(v) {
      if (!v || typeof v !== 'object') return null;
      const src = (v.usageMetadata && typeof v.usageMetadata === 'object') ? v.usageMetadata : (v.usage && typeof v.usage === 'object' ? v.usage : null);
      if (!src) return null;

      const normalizeKey = (key) => String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      const flat = {};
      for (const [key, value] of Object.entries(src)) {
        flat[normalizeKey(key)] = value;
      }
      const pickNumber = (...candidates) => {
        for (const candidate of candidates) {
          const normalized = normalizeKey(candidate);
          if (Object.prototype.hasOwnProperty.call(flat, normalized)) {
            const val = flat[normalized];
            if (typeof val === 'number' && Number.isFinite(val)) return val;
          }
        }
        return null;
      };

      const usage = {
        promptTokens: pickNumber('promptTokenCount', 'promptTokens', 'inputTokenCount', 'inputTokens'),
        inputTokens: pickNumber('inputTokenCount', 'inputTokens', 'promptTokenCount', 'promptTokens'),
        candidatesTokens: pickNumber('candidatesTokenCount', 'candidatesTokens', 'completionTokenCount', 'completionTokens', 'outputTokenCount', 'outputTokens', 'responseTokens'),
        outputTokens: pickNumber('outputTokenCount', 'outputTokens', 'candidatesTokenCount', 'candidatesTokens', 'completionTokenCount', 'completionTokens', 'responseTokens'),
        totalTokens: pickNumber('totalTokenCount', 'totalTokens'),
        thinkingTokens: pickNumber('thinkingTokenCount', 'thinkingTokens', 'thoughtTokenCount', 'thoughtTokens', 'reasoningTokenCount', 'reasoningTokens'),
        cachedContentTokens: pickNumber('cachedContentTokenCount', 'cachedContentTokens', 'cachedTokens'),
        inputImageTokens: pickNumber('inputImageTokenCount', 'inputImageTokens', 'imageTokenCount', 'imageTokens'),
        outputImageTokens: pickNumber('outputImageTokenCount', 'outputImageTokens'),
        inputAudioTokens: pickNumber('inputAudioTokenCount', 'audioInputTokens'),
        outputAudioTokens: pickNumber('outputAudioTokenCount', 'audioOutputTokens'),
        inputVideoTokens: pickNumber('inputVideoTokenCount', 'videoInputTokens'),
        outputVideoTokens: pickNumber('outputVideoTokenCount', 'videoOutputTokens'),
        billableTokens: pickNumber('billableTokenCount', 'billableTokens'),
        billableCharacters: pickNumber('billableCharacterCount', 'billableCharacters'),
      };

      if (usage.totalTokens == null) {
        const sumParts = [usage.promptTokens, usage.candidatesTokens, usage.thinkingTokens].filter((val) => typeof val === 'number' && Number.isFinite(val));
        if (sumParts.length) usage.totalTokens = sumParts.reduce((acc, val) => acc + val, 0);
      }

      const result = { rawUsage: src };
      for (const [key, value] of Object.entries(usage)) {
        if (value != null) result[key] = value;
      }
      return result;
    }

    if (!usageInfo) usageInfo = extractUsageFromVertex(vertex) || null;

    if (!modelJsonWithConfidence) {
      const modelText = extractTextFromVertex(vertex);
      try {
        console.log('Vertex text (preview)', (modelText || '').slice(0, 800));
      } catch {}
      modelJson = parseJsonLoose(modelText);
      try {
        const mjPreview = JSON.stringify(modelJson || {}).slice(0, 1500);
        console.log('Vertex JSON (preview)', mjPreview);
      } catch {}
      modelJsonWithConfidence = withFieldConf(modelJson);
    }

    // Build payload for Zoho Creator Publish API (add record)
    // Endpoint pattern:
    // https://{dc}/creator/v2.1/publish/{owner}/{app}/form/{form}?privatelink=...
    function getZohoBaseFromEnv() {
      const explicit = process.env.ZC_CREATOR_BASE || process.env.ZC_DC_BASE || "";
      if (explicit) return explicit.replace(/\/$/, "");
      const reportUrl = process.env.ZC_FILES_REPORT_URL || "";
      try {
        if (reportUrl) {
          const u = new URL(reportUrl);
          return `${u.protocol}//${u.hostname}`;
        }
      } catch {}
      return "https://www.zohoapis.in"; // sensible default for .in DC
    }

    const owner = process.env.ZC_OWNER_NAME || "deloittettipl";
    const app = process.env.ZC_APP_LINK_NAME || "trade-invoice-platform";
    const form = process.env.ZC_FORM_LINK_NAME || "Google_AI_SCAN_Response";
    const privatelink = process.env.ZC_PRIVATE_LINK || (process.env.ZC_FILES_REPORT_URL ? (new URL(process.env.ZC_FILES_REPORT_URL).searchParams.get("privatelink")) : "");
    const base = getZohoBaseFromEnv();
    // Hardcode privatelink as requested
    const hardCodedPrivateLink = "qQG7EaTbdZp5WYvTxmRYbAt25BNtg1feme3X4kP8601wsUCwzXuPRVjWkJpNNwXxrD3gdaPUdwZ2FJeARzT8FyaJrUsfzCvFVRpF";
    const effectivePrivateLink = hardCodedPrivateLink || privatelink;
    const zohoUrl = `${base}/creator/v2.1/publish/${owner}/${app}/form/${encodeURIComponent(form)}?privatelink=${encodeURIComponent(effectivePrivateLink)}`;

    // Prepare data maps for flexible matching (flatten common wrappers)
    const extracted = modelJsonWithConfidence || {};
    try {
      const ek = extracted && typeof extracted === 'object' ? Object.keys(extracted) : [];
      console.log('Extracted JSON keys/count', { count: ek.length, keys: ek.slice(0, 12) });
    } catch {}
    function normKey(k) { return String(k || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
    const normMap = {};   // values
    const confMap = {};   // confidences
    function addToMap(obj, map) {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) map[normKey(k)] = v;
    }
    addToMap(extracted, normMap);
    if (extracted && typeof extracted === 'object') {
      if (extracted.fields && typeof extracted.fields === 'object') addToMap(extracted.fields, normMap);
      if (extracted.field_confidence && typeof extracted.field_confidence === 'object') addToMap(extracted.field_confidence, confMap);
      if (extracted.fields_confidence && typeof extracted.fields_confidence === 'object') addToMap(extracted.fields_confidence, confMap);
    }
    function firstExisting(keys, map = normMap) {
      for (const k of keys) {
        const nk = normKey(k);
        if (Object.prototype.hasOwnProperty.call(map, nk)) return map[nk];
      }
      return null;
    }

    const baseFields = [
      'Invoice_Number',
      'Invoice_Date',
      'Seller_GSTIN',
      'Seller_PAN',
      'Seller_Name',
      'Buyer_GSTIN',
      'Buyer_Name',
      'Buyer_PAN',
      'Ship_to_GSTIN',
      'Ship_to_Name',
      'Sub_Total_Amount',
      'Discount_Amount',
      'CGST_Amount',
      'SGST_Amount',
      'IGST_Amount',
      'CESS_Amount',
      'Additional_Cess_Amount',
      'Total_Tax_Amount',
      'IRN_Details',
    ];

    const synonyms = {
      Invoice_Number: ['invoice_number', 'invoice_no', 'invoiceid', 'invoice_id', 'inv_no'],
      Invoice_Date: ['invoice_date', 'date_of_invoice', 'inv_date', 'invoice_dt', 'date'],
      Seller_GSTIN: ['seller_gstin', 'supplier_gstin', 'seller_gst', 'supplier_gst'],
      Seller_PAN: ['seller_pan', 'supplier_pan'],
      Seller_Name: ['seller_name', 'supplier_name'],
      Buyer_GSTIN: ['buyer_gstin', 'recipient_gstin', 'bill_to_gstin'],
      Buyer_Name: ['buyer_name', 'recipient_name', 'bill_to_name'],
      Buyer_PAN: ['buyer_pan', 'recipient_pan'],
      Ship_to_GSTIN: ['ship_to_gstin', 'shipping_gstin', 'consignee_gstin'],
      Ship_to_Name: ['ship_to_name', 'shipping_name', 'consignee_name'],
      Sub_Total_Amount: ['sub_total_amount', 'subtotal_amount', 'sub_total', 'taxable_value', 'taxable_amount'],
      Discount_Amount: ['discount_amount', 'discount'],
      CGST_Amount: ['cgst_amount', 'cgst'],
      SGST_Amount: ['sgst_amount', 'sgst'],
      IGST_Amount: ['igst_amount', 'igst'],
      CESS_Amount: ['cess_amount', 'cess'],
      Additional_Cess_Amount: ['additional_cess_amount', 'additionalcessamount', 'cess_additional_amount'],
      Total_Tax_Amount: ['total_tax_amount', 'total_tax'],
      IRN_Details: ['irn_details', 'irn', 'ack_no', 'irn_number'],
    };

    function valueFor(fieldName) {
      const syn = synonyms[fieldName] || [];
      return firstExisting([fieldName, ...syn]);
    }
    function confidenceFor(fieldName) {
      const baseSyn = synonyms[fieldName] || [];
      // Prefer explicit *_confidence keys if present in flattened values map
      const cands1 = [
        `${fieldName}_Confidence`,
        `${fieldName}_confidence`,
        `${fieldName}Confidence`,
        ...baseSyn.map((s) => `${s}_confidence`),
      ];
      const v1 = firstExisting(cands1, normMap);
      if (v1 != null) return v1;
      // Otherwise look up confidence by base field key in confMap
      const cands2 = [fieldName, ...baseSyn];
      const v2 = firstExisting(cands2, confMap);
      return v2;
    }

    const payloadData = {};
    // Map 19 fields
    for (const f of baseFields) {
      payloadData[f] = valueFor(f);
    }
    // Map the 19 confidence fields with exact names as provided
    const confidenceFields = [
      'Invoice_Number_Confidence',
      'Invoice_Date_Confidence',
      'Seller_GST_Confidence',
      'Seller_PAN_Confidence',
      'Seller_Name_Confidence',
      'Buyer_GSTIN_Confidence',
      'Buyer_Name_Confidence',
      'Buyer_PAN_Confidence',
      'Ship_to_GSTIN_Confidence',
      'Ship_to_Name_Confidence',
      'Sub_Total_Amount_Confidence',
      'Discount_Amount_Confidence',
      'CGST_Amount_Confidence',
      'SGST_Amount_Confidence',
      'IGST_Amount_Confidence',
      'CESS_Amount_Confidence',
      'Additional_cess_Amount_Confidence',
      'Total_Tax_Amount_Confidence',
      'IRN_Details_Confidence',
    ];

    function baseNameFromConfidence(cf) {
      // Turn e.g. Seller_GST_Confidence -> Seller_GSTIN (best-effort),
      // or Additional_cess_Amount_Confidence -> Additional_Cess_Amount
      if (cf === 'Seller_GST_Confidence') return 'Seller_GSTIN';
      if (cf === 'Additional_cess_Amount_Confidence') return 'Additional_Cess_Amount';
      return cf.replace(/_Confidence$/i, '');
    }
    for (const cf of confidenceFields) {
      const baseField = baseNameFromConfidence(cf);
      payloadData[cf] = confidenceFor(baseField);
    }

    // Normalize dates to Zoho's expected dd-MM-yyyy format
    try {
      const raw = payloadData.Invoice_Date;
      if (typeof raw === 'string' && raw.trim()) {
        const s = raw.trim();
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); // YYYY-MM-DD
        if (m) {
          payloadData.Invoice_Date = `${m[3]}-${m[2]}-${m[1]}`; // DD-MM-YYYY
        } else {
          const d = new Date(s);
          if (!isNaN(d.getTime())) {
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const yyyy = d.getFullYear();
            payloadData.Invoice_Date = `${dd}-${mm}-${yyyy}`;
          }
        }
        console.log('Invoice_Date normalized for Zoho', { input: raw, output: payloadData.Invoice_Date });
      }
    } catch {}

    // Extract Zoho File_ID from fileUrl and include as number
    function extractZohoFileId(urlStr) {
      try {
        const u = new URL(urlStr);
        // Accept creatorapp.zohopublic.* or creatorapp.zoho.* domains
        if (!/creatorapp\.(zohopublic|zoho)\./i.test(u.hostname)) return null;
        // Expect path: /file/{owner}/{app}/{form}/{recordId}/upload_invoice/download/{privatelink}
        const m = u.pathname.match(/\/file\/[^/]+\/[^/]+\/[^/]+\/(\d+)\//);
        return m ? m[1] : null;
      } catch { return null; }
    }
    const fileId = extractZohoFileId(fileUrl);
    if (!fileId) {
      return res.status(400).json({ error: 'Unable to extract File_ID from fileUrl. Ensure it is a Zoho public file download URL.' });
    }
    // Do NOT coerce to Number to avoid precision loss for 17-18 digit IDs
    const fileIdIsSafe = Number.isSafeInteger(Number(fileId));
    console.log('Parsed Zoho File_ID', { fileId, fileIdIsSafe, len: String(fileId).length });
    payloadData.File_ID = String(fileId);

    // Debug logging (non-sensitive)
    try {
      const payloadKeys = Object.keys(payloadData);
      const sample = {};
      for (const k of ['Invoice_Number','Invoice_Date','Seller_GSTIN','Buyer_GSTIN','Total_Tax_Amount','IRN_Details','File_ID']) {
        if (k in payloadData) sample[k] = payloadData[k];
      }
      console.log('Zoho payload keys/count', { count: payloadKeys.length, keys: payloadKeys.slice(0, 10) });
      console.log('Zoho payload sample', sample);
    } catch (e) { /* ignore logging errors */ }

    // Optionally attach gsUri if the form supports it; controlled via env flag
    if (String(process.env.ZC_INCLUDE_GCS_URI || 'false').toLowerCase() === 'true') {
      payloadData.gcs_uri = gsUri;
    }

    try {
      try {
        const payloadPreview = JSON.stringify(payloadData);
        console.log('Zoho payload (full)', payloadPreview);
      } catch {}
      const zres = await axios.post(zohoUrl, { data: payloadData }, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'vertex-file-processor/1.0 (+https://github.com/aorborc/vertex-file-processor)'
        },
        timeout: 60_000,
        validateStatus: () => true, // pass through Zoho status
      });
      try {
        console.log('Zoho response status', zres.status);
        const preview = typeof zres.data === 'string' ? zres.data.slice(0, 500) : JSON.stringify(zres.data).slice(0, 500);
        console.log('Zoho response body (preview)', preview);
      } catch {}
      if (usageInfo) {
        if (zres && zres.data && typeof zres.data === 'object' && !Array.isArray(zres.data)) {
          return res.status(zres.status || 200).json({ ...zres.data, vertexUsage: usageInfo });
        }
        return res.status(zres.status || 200).json({ zoho: zres.data, vertexUsage: usageInfo });
      }
      return res.status(zres.status || 200).json(zres.data);
    } catch (e) {
      const status = e?.response?.status || 500;
      const data = e?.response?.data || { error: String(e?.message || e) };
      if (usageInfo) {
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          return res.status(status).json({ ...data, vertexUsage: usageInfo });
        }
        return res.status(status).json({ zoho: data, vertexUsage: usageInfo });
      }
      return res.status(status).json(data);
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
});

// Signed URL function (ADC). GET ?gsUri=gs://bucket/path.pdf&ttlSec=900
exports.signedUrl = onRequest({ cors: true, serviceAccount: saEmail, environmentVariables: { FIRESTORE_DATABASE_ID: process.env.FIRESTORE_DATABASE_ID || "sw-vertex-processor" } }, async (req, res) => {
  try {
    const gsUri = req.query.gsUri || req.query.gcsUri;
    // GCS V4 signed URLs support a maximum of 7 days (604800s)
    const MAX_TTL = 7 * 24 * 60 * 60; // 604800 seconds
    const ttlSec = Math.min(MAX_TTL, Math.max(60, Number(req.query.ttlSec || 600)));
    if (!gsUri || typeof gsUri !== 'string' || !gsUri.startsWith('gs://'))
      return res.status(400).json({ error: 'Missing or invalid gsUri' });
    const m = /^gs:\/\/([^\/]+)\/(.+)$/.exec(gsUri);
    if (!m) return res.status(400).json({ error: 'Invalid gsUri' });
    const [_, bucket, name] = m;
    // cache check
    const cacheId = hashId(gsUri);
    const cached = await readCache('signedUrlCache', cacheId);
    const now = Date.now();
    if (cached && cached.url && cached.expires && (cached.expires - now) > 60 * 1000) {
      return res.status(200).json({ url: cached.url, expires: cached.expires, cached: true, cachedAt: cached.updatedAt || cached.createdAt || null });
    }

    const storage = new Storage();
    const file = storage.bucket(bucket).file(name);
    const expires = Date.now() + ttlSec * 1000;
    const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires });
    await writeCache('signedUrlCache', cacheId, { gsUri, url, expires, createdAt: new Date().toISOString() });
    return res.status(200).json({ url, expires, cached: false });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});
