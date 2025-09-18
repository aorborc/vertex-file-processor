export const runtime = 'nodejs';

import { getProjectId } from "@/lib/google";
import { getDocument, commitUpsert } from "@/lib/firestore-rest";
import { callVertexGenerateContent } from "@/lib/google";

function buildPrompt() {
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

function parseJsonLoose(s) {
  if (!s || typeof s !== 'string') return null;
  const cleaned = s.replace(/^```json\n?|```$/gi, "").replace(/^```\n?|```$/gi, "");
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const core = start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;
  try { return JSON.parse(core); } catch { return null; }
}
function calcAvg(fields_confidence) {
  const vals = Object.values(fields_confidence || {}).filter((v) => typeof v === 'number' && v > 0);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const recordId = String(body?.recordId || '').trim();
    if (!recordId) return new Response(JSON.stringify({ error: 'Missing recordId' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const projectId = (await getProjectId()) || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) return new Response(JSON.stringify({ error: 'Missing project id' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    const databaseId = process.env.FIRESTORE_DATABASE_ID || '(default)';

    const doc = await getDocument({ projectId, databaseId, collection: 'Sampling', docId: recordId });
    if (!doc || !doc.fields) return new Response(JSON.stringify({ error: 'Record not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    const gcsUri = doc.fields.gcsUri;
    if (!gcsUri || typeof gcsUri !== 'string') return new Response(JSON.stringify({ error: 'Record missing gcsUri' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const locationRaw = body?.location;
    const location = typeof locationRaw === 'string' && locationRaw.trim() ? locationRaw.trim() : (process.env.VERTEX_LOCATION || 'us-central1');
    const model = 'gemini-2.5-flash';
    const useBatchRaw = body?.useBatch;
    const useBatch = (() => {
      if (useBatchRaw == null) return true;
      const normalized = String(useBatchRaw).trim().toLowerCase();
      return !(normalized === 'false' || normalized === '0' || normalized === 'no');
    })();
    const prompt = buildPrompt();

    // Call Vertex
    const vertex = await callVertexGenerateContent({
      projectId,
      location,
      model,
      gsUri: gcsUri,
      prompt,
      mimeType: 'application/pdf',
      useBatch,
    });
    const parts = vertex?.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p) => typeof p.text === 'string');
    const txt = textPart?.text || null;
    const extracted = parseJsonLoose(txt) || {};
    const avg = calcAvg(extracted?.fields_confidence || {});

    const usage = vertex?.usageMetadata || null;
    const inputTokens = usage?.promptTokenCount ?? null;
    const outputTokens = usage?.candidatesTokenCount ?? null;

    const next = {
      ...(doc.fields || {}),
      extracted,
      avg_confidence_score: avg,
      vertex_usage: usage || null,
      inputTokens,
      outputTokens,
      updatedAt: new Date().toISOString(),
    };
    await commitUpsert({ projectId, databaseId, collection: 'Sampling', docId: recordId, data: next });

    return new Response(JSON.stringify({ success: true, recordId, avg, usage }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Unknown error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
