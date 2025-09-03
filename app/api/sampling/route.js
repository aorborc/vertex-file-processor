export const runtime = 'nodejs';

import axios from "axios";
import { uploadBufferToGCS, callVertexGenerateContent, getProjectId } from "@/lib/google";
import { fetchZohoFiles, extractPrivateLink, parseZohoFilePath, buildZohoDownloadUrl } from "@/lib/zoho";
import { commitUpsert } from "@/lib/firestore-rest";

function guessMimeTypeFromUrl(url) {
  const ext = (url.split("?")[0].split(".").pop() || "").toLowerCase();
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

function buildPrompt() {
  // Expert prompt tailored to the requested schema and constraints
  const schema = {
    fields: {
      Invoice_Number: "",
      Invoice_Date: "",
      Seller_GSTIN: "",
      Seller_PAN: "",
      Seller_Name: "",
      Buyer_GSTIN: "",
      Buyer_Name: "",
      Buyer_PAN: "",
      Ship_to_GSTIN: "",
      Ship_to_Name: "",
      Sub_Total_Amount: 0,
      Discount_Amount: 0,
      CGST_Amount: 0,
      SGST_Amount: 0,
      IGST_Amount: 0,
      CESS_Amount: 0,
      Additional_Cess_Amount: 0,
      Total_Tax_Amount: 0,
      IRN_Details: "",
    },
    fields_confidence: {
      Invoice_Number: 0,
      Invoice_Date: 0,
      Seller_GSTIN: 0,
      Seller_PAN: 0,
      Seller_Name: 0,
      Buyer_GSTIN: 0,
      Buyer_Name: 0,
      Buyer_PAN: 0,
      Ship_to_GSTIN: 0,
      Ship_to_Name: 0,
      Sub_Total_Amount: 0,
      Discount_Amount: 0,
      CGST_Amount: 0,
      SGST_Amount: 0,
      IGST_Amount: 0,
      CESS_Amount: 0,
      Additional_Cess_Amount: 0,
      Total_Tax_Amount: 0,
      IRN_Details: 0,
    },
  };

  return [
    "You are an expert invoice parser for Indian GST invoices.",
    "Extract ONLY the following invoice-level fields from the provided document and return JSON only.",
    "Schema must be exactly:",
    JSON.stringify(schema, null, 2),
    "Instructions:",
    "- Return ONLY JSON, no prose, code fences, or comments.",
    "- Confidence scores must be floats between 0 and 1 for each field in fields_confidence.",
    "- Dates must be in YYYY-MM-DD format.",
    "- Amount fields must be numbers (not strings), in the invoice currency.",
    "- If a field is missing on the invoice, leave it as an empty string (for text fields) or 0 (for numeric).",
    "- Do NOT include any additional keys (no line_items, no extra metadata).",
  ].join("\n");
}

function extractTextFromVertex(v) {
  try {
    const parts = v?.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p) => typeof p.text === "string");
    return textPart?.text || null;
  } catch {
    return null;
  }
}
function parseJsonLoose(s) {
  if (!s || typeof s !== "string") return null;
  const cleaned = s.replace(/^```json\n?|```$/gi, "").replace(/^```\n?|```$/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const core = start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(core);
  } catch {
    return null;
  }
}
function calcAvgConfidence(doc) {
  const fc = doc?.fields_confidence || {};
  const vals = Object.values(fc).filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function processOne({ fileUrl, projectId, location, model, bucketName, recordId }) {
  // Download file and push to GCS
  const mimeFromUrl = guessMimeTypeFromUrl(fileUrl);
  const response = await axios.get(fileUrl, { responseType: "arraybuffer", timeout: 60_000 });
  const buffer = Buffer.from(response.data);
  const contentType = response.headers["content-type"] || mimeFromUrl;
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const ext = contentType.includes("pdf") ? "pdf" : (mimeFromUrl.endsWith("pdf") ? "pdf" : "bin");
  const destination = `uploads/sampling/${recordId || "doc"}-${ts}-${rand}.${ext}`;
  const gsUri = await uploadBufferToGCS({ bucketName, destination, buffer, contentType });

  // Call Vertex
  const prompt = buildPrompt();
  const vertex = await callVertexGenerateContent({
    projectId,
    location,
    model,
    gsUri,
    prompt,
    mimeType: contentType.includes("pdf") ? "application/pdf" : guessMimeTypeFromUrl(gsUri),
  });
  const text = extractTextFromVertex(vertex);
  const parsed = parseJsonLoose(text) || {};
  const avg = calcAvgConfidence(parsed);

  return { gsUri, vertex, parsed, avg };
}

export async function POST(request) {
  try {
    const reportUrlEnv = process.env.ZC_FILES_REPORT_URL || "";
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const zohoReportUrl = body?.reportUrl || reportUrlEnv;
    const countParam = body?.count;
    // const count = Math.min(200, Math.max(1, Number(countParam || 200)));
    const count = 4;

    if (!zohoReportUrl) {
      return new Response(JSON.stringify({ error: "Missing Zoho report URL. Set ZC_FILES_REPORT_URL env or pass in body.reportUrl" }), { status: 400 });
    }
    const privateLink = extractPrivateLink(zohoReportUrl) || process.env.ZC_PRIVATE_LINK;
    if (!privateLink) {
      return new Response(JSON.stringify({ error: "Missing Zoho privatelink. Ensure the report URL has ?privatelink=... or set ZC_PRIVATE_LINK env" }), { status: 400 });
    }

    const bucketName = process.env.GCS_BUCKET;
    if (!bucketName) return new Response(JSON.stringify({ error: "Server missing GCS_BUCKET env" }), { status: 500 });
    const projectId = (await getProjectId()) || process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.VERTEX_LOCATION || "us-central1";
    const model = process.env.VERTEX_MODEL || "gemini-2.5-pro";
    const dbId = process.env.FIRESTORE_DATABASE_ID || "(default)";

    const recordsRaw = await fetchZohoFiles({ reportUrl: zohoReportUrl, count: Math.max(count, 200) });
    // Prefer entries that have a valid upload_invoice filepath
    const eligible = [];
    for (const r of recordsRaw) {
      const fp = parseZohoFilePath(r?.upload_invoice);
      if (fp) eligible.push(r);
      if (eligible.length >= count) break;
    }
    if (!eligible.length) return new Response(JSON.stringify({ error: "Zoho report returned no eligible records with upload_invoice filepath" }), { status: 404 });

    // Light concurrency to keep load reasonable
    const concurrency = Math.max(1, Math.min(6, Number(process.env.SAMPLING_CONCURRENCY || 4)));
    const queue = [];
    const results = [];
    let active = 0;
    let idx = 0;

    const runNext = async () => {
      while (active < concurrency && idx < eligible.length) {
        const rec = eligible[idx++];
        active++;
        (async () => {
          try {
            const recordId = rec?.ID || rec?.id || String(idx);
            const fp = parseZohoFilePath(rec?.upload_invoice);
            const fileUrl = buildZohoDownloadUrl({ recordId, filePath: fp, privateLink });
            if (!fileUrl) throw new Error("Unable to construct Zoho file URL");
            const { gsUri, parsed, avg } = await processOne({ fileUrl, projectId, location, model, bucketName, recordId });
            const payload = {
              recordId,
              zohoFilePath: fp,
              zohoDownloadUrl: fileUrl,
              gcsUri: gsUri,
              extracted: parsed || null,
              avg_confidence_score: avg,
              createdAt: new Date().toISOString(),
            };
            await commitUpsert({ projectId, databaseId: dbId, collection: "Sampling", docId: String(recordId), data: payload });
            results.push({ recordId, avg_confidence_score: avg, zohoDownloadUrl: fileUrl });
          } catch (e) {
            results.push({ error: String(e?.message || e), recordId: rec?.ID || null });
          } finally {
            active--;
            runNext();
          }
        })();
      }
    };
    await runNext();
    // Wait for all to drain
    while (active > 0 || idx < eligible.length) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }

    const successes = results.filter((r) => !r.error);
    const errors = results.filter((r) => !!r.error);
    const avgOverall = successes.length ? successes.reduce((a, b) => a + (b.avg_confidence_score || 0), 0) / successes.length : 0;
    return new Response(JSON.stringify({
      success: true,
      processed: successes.length,
      failed: errors.length,
      avg_confidence_overall: avgOverall,
      results: successes,
      errors,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || "Unknown error", where: "sampling" }), { status: 500 });
  }
}

export async function GET(request) {
  // Convenience GET trigger: /api/sampling?count=4 or &reportUrl=...
  try {
    const url = new URL(request.url);
    const reportUrlEnv = process.env.ZC_FILES_REPORT_URL || "";
    const zohoReportUrl = url.searchParams.get("reportUrl") || reportUrlEnv;
    const count = Math.min(200, Math.max(1, Number(url.searchParams.get("count") || 200)));

    if (!zohoReportUrl) {
      return new Response(JSON.stringify({ error: "Missing Zoho report URL. Set ZC_FILES_REPORT_URL env or pass reportUrl query" }), { status: 400 });
    }
    const privateLink = extractPrivateLink(zohoReportUrl) || process.env.ZC_PRIVATE_LINK;
    if (!privateLink) {
      return new Response(JSON.stringify({ error: "Missing Zoho privatelink. Ensure reportUrl has ?privatelink=... or set ZC_PRIVATE_LINK env" }), { status: 400 });
    }

    const bucketName = process.env.GCS_BUCKET;
    if (!bucketName) return new Response(JSON.stringify({ error: "Server missing GCS_BUCKET env" }), { status: 500 });
    const projectId = (await getProjectId()) || process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.VERTEX_LOCATION || "us-central1";
    const model = process.env.VERTEX_MODEL || "gemini-2.5-pro";
    const dbId = process.env.FIRESTORE_DATABASE_ID || "(default)";

    const recordsRaw = await fetchZohoFiles({ reportUrl: zohoReportUrl, count: Math.max(count, 200) });
    const eligible = [];
    for (const r of recordsRaw) {
      const fp = parseZohoFilePath(r?.upload_invoice);
      if (fp) eligible.push(r);
      if (eligible.length >= count) break;
    }
    if (!eligible.length) return new Response(JSON.stringify({ error: "Zoho report returned no eligible records with upload_invoice filepath" }), { status: 404 });

    const concurrency = Math.max(1, Math.min(6, Number(process.env.SAMPLING_CONCURRENCY || 4)));
    const queue = [];
    const results = [];
    let active = 0;
    let idx = 0;

    const runNext = async () => {
      while (active < concurrency && idx < eligible.length) {
        const rec = eligible[idx++];
        active++;
        (async () => {
          try {
            const recordId = rec?.ID || rec?.id || String(idx);
            const fp = parseZohoFilePath(rec?.upload_invoice);
            const fileUrl = buildZohoDownloadUrl({ recordId, filePath: fp, privateLink });
            if (!fileUrl) throw new Error("Unable to construct Zoho file URL");
            const { gsUri, parsed, avg } = await processOne({ fileUrl, projectId, location, model, bucketName, recordId });
            const payload = {
              recordId,
              zohoFilePath: fp,
              zohoDownloadUrl: fileUrl,
              gcsUri: gsUri,
              extracted: parsed || null,
              avg_confidence_score: avg,
              createdAt: new Date().toISOString(),
            };
            await commitUpsert({ projectId, databaseId: dbId, collection: "Sampling", docId: String(recordId), data: payload });
            results.push({ recordId, avg_confidence_score: avg, zohoDownloadUrl: fileUrl });
          } catch (e) {
            results.push({ error: String(e?.message || e), recordId: rec?.ID || null });
          } finally {
            active--;
            runNext();
          }
        })();
      }
    };
    await runNext();
    while (active > 0 || idx < eligible.length) { await new Promise((r) => setTimeout(r, 100)); }

    const successes = results.filter((r) => !r.error);
    const errors = results.filter((r) => !!r.error);
    const avgOverall = successes.length ? successes.reduce((a, b) => a + (b.avg_confidence_score || 0), 0) / successes.length : 0;
    return new Response(JSON.stringify({ success: true, processed: successes.length, failed: errors.length, avg_confidence_overall: avgOverall, results: successes, errors }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || "Unknown error", where: "sampling.get" }), { status: 500 });
  }
}
