export const runtime = 'nodejs';

import { getProjectId } from "@/lib/google";
import { listDocuments } from "@/lib/firestore-rest";

function rowAvg(item) {
  const fc = item?.fields_confidence || {};
  const keys = [
    "Invoice_Number","Invoice_Date","Seller_GSTIN","Seller_PAN","Seller_Name",
    "Buyer_GSTIN","Buyer_Name","Buyer_PAN","Ship_to_GSTIN","Ship_to_Name",
    "Sub_Total_Amount","Discount_Amount","CGST_Amount","SGST_Amount","IGST_Amount",
    "CESS_Amount","Additional_Cess_Amount","Total_Tax_Amount","IRN_Details",
  ];
  let sum = 0; let cnt = 0;
  for (const k of keys) {
    const v = fc?.[k];
    if (typeof v === 'number' && v > 0) { sum += v; cnt += 1; }
  }
  return cnt ? sum / cnt : 0;
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const folderId = url.searchParams.get('folderId') || url.searchParams.get('folder');

    const projectId = (await getProjectId()) || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) return new Response(JSON.stringify({ error: 'Missing project id' }), { status: 500 });
    const databaseId = process.env.FIRESTORE_DATABASE_ID || '(default)';

    const docs = await listDocuments({ projectId, databaseId, collection: 'Sampling', pageSize: 5000 });
    const rowsRaw = docs
      .map((d) => ({ docName: d.name, fields: d.fields || {} }))
      .filter((r) => r.fields.tag === 'prasoon-sampling')
      .filter((r) => !folderId || r.fields.driveFolderId === folderId);

    function docIdFromName(name) {
      if (!name) return null;
      const parts = String(name).split('/');
      return parts[parts.length - 1] || null;
    }

    const rows = rowsRaw.map((r) => ({
      recordId: docIdFromName(r.docName) || r.fields.recordId || null,
      gcsUri: r.fields.gcsUri || null,
      downloadUrl: r.fields.driveViewUrl || null,
      driveFileName: r.fields.driveFileName || null,
      fields: r.fields.extracted?.fields || null,
      fields_confidence: r.fields.extracted?.fields_confidence || null,
      createdAt: r.fields.createdAt || null,
      avg_confidence_row: rowAvg({ fields_confidence: r.fields.extracted?.fields_confidence || {} }),
    }));

    const valid = rows.filter((r) => typeof r.avg_confidence_row === 'number');
    const overall = valid.length ? valid.reduce((a, b) => a + (b.avg_confidence_row || 0), 0) / valid.length : 0;

    return new Response(JSON.stringify({ success: true, count: rows.length, overall_avg_confidence: overall, rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Unknown error' }), { status: 500 });
  }
}
