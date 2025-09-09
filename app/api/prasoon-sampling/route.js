export const runtime = 'nodejs';

import { uploadBufferToGCS, callVertexGenerateContent, getProjectId } from "@/lib/google";
import { commitUpsert } from "@/lib/firestore-rest";
import { extractFolderId, listDrivePdfsInFolder, downloadDriveFile } from "@/lib/gdrive";

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

function percent(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }
function calcAvgConfidence(doc) {
  const fc = doc?.fields_confidence || {};
  const vals = Object.values(fc).filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function guessMimeTypeFromName(name) {
  const ext = (name || '').toLowerCase().split('.').pop();
  return ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
}

export async function POST(request) {
  try {
    const body = await request.json();
    const defaultFolder = process.env.PRASOON_DEFAULT_DRIVE_FOLDER_ID || "119ge4hcHq-_9BgHIjcOUda3gZtlnSIPk";
    const folderIdOrLink = body?.folderIdOrLink || body?.folder || body?.folderId || body?.link || defaultFolder;
    const limit = Math.min(500, Math.max(1, Number(body?.count || body?.limit || 200)));
    const folderId = extractFolderId(folderIdOrLink);
    if (!folderId) {
      return new Response(JSON.stringify({ error: "Missing or invalid Google Drive folderId or link" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const bucketName = process.env.GCS_BUCKET;
    if (!bucketName) return new Response(JSON.stringify({ error: "Server missing GCS_BUCKET env" }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    const projectId = (await getProjectId()) || process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.VERTEX_LOCATION || "us-central1";
    const model = process.env.VERTEX_MODEL || "gemini-2.5-pro";
    const dbId = process.env.FIRESTORE_DATABASE_ID || "(default)";

    // List PDFs in the folder
    const files = await listDrivePdfsInFolder({ folderId, pageSize: limit });
    if (!files.length) {
      return new Response(JSON.stringify({ error: "No PDF files found in the Drive folder" }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Concurrency control
    const concurrency = Math.max(1, Math.min(6, Number(process.env.SAMPLING_CONCURRENCY || 4)));
    let idx = 0;
    let active = 0;
    const results = [];

    const runNext = async () => {
      while (active < concurrency && idx < files.length) {
        const file = files[idx++];
        active++;
        (async () => {
          try {
            const fileId = file.id;
            const recordId = fileId; // unique
            const name = file.name || `drive_${fileId}.pdf`;
            const viewUrl = `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;

            // Download from Drive, upload to GCS
            const buffer = await downloadDriveFile({ fileId });
            const ts = Date.now();
            const rand = Math.random().toString(36).slice(2, 8);
            const destination = `uploads/prasoon/${recordId}-${ts}-${rand}.pdf`;
            const contentType = guessMimeTypeFromName(name);
            const gsUri = await uploadBufferToGCS({ bucketName, destination, buffer, contentType });

            // Call Vertex
            const prompt = buildPrompt();
            const vertex = await callVertexGenerateContent({
              projectId,
              location,
              model,
              gsUri,
              prompt,
              mimeType: 'application/pdf',
            });

            // Parse model output
            const parts = vertex?.candidates?.[0]?.content?.parts || [];
            const textPart = parts.find((p) => typeof p.text === 'string');
            const txt = textPart?.text || null;
            const cleaned = txt ? txt.replace(/^```json\n?|```$/gi, "").replace(/^```\n?|```$/gi, "") : null;
            let parsed = null;
            if (cleaned) {
              const s = cleaned;
              const start = s.indexOf('{');
              const end = s.lastIndexOf('}');
              const core = start >= 0 && end >= start ? s.slice(start, end + 1) : s;
              try { parsed = JSON.parse(core); } catch {}
            }
            const avg = calcAvgConfidence(parsed || {});

            const usage = vertex?.usageMetadata || null;
            const inputTokens = usage?.promptTokenCount ?? null;
            const outputTokens = usage?.candidatesTokenCount ?? null;
            const sizeBytes = Number(file?.size || buffer.length || 0) || null;

            const payload = {
              recordId,
              tag: 'prasoon-sampling',
              driveFileId: fileId,
              driveFileName: name,
              driveFolderId: folderId,
              driveViewUrl: viewUrl,
              gcsUri: gsUri,
              extracted: parsed || null,
              avg_confidence_score: percent(avg),
              vertex_usage: usage || null,
              inputTokens,
              outputTokens,
              sizeBytes,
              createdAt: new Date().toISOString(),
            };
            await commitUpsert({ projectId, databaseId: dbId, collection: 'Sampling', docId: String(recordId), data: payload });
            results.push({ recordId, avg_confidence_score: avg, downloadUrl: viewUrl });
          } catch (e) {
            results.push({ error: String(e?.message || e) });
          } finally {
            active--;
            runNext();
          }
        })();
      }
    };
    await runNext();
    while (active > 0 || idx < files.length) { // wait for drain
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }

    const successes = results.filter((r) => !r.error);
    const errors = results.filter((r) => !!r.error);
    const avgOverall = successes.length ? successes.reduce((a, b) => a + (b.avg_confidence_score || 0), 0) / successes.length : 0;
    return new Response(JSON.stringify({ success: true, processed: successes.length, failed: errors.length, avg_confidence_overall: avgOverall, results: successes, errors }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Unknown error', where: 'prasoon-sampling' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
