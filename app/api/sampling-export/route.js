export const runtime = 'nodejs';

import { getProjectId } from "@/lib/google";
import { listDocuments } from "@/lib/firestore-rest";

const FIELD_KEYS = [
  "Invoice_Number",
  "Invoice_Date",
  "Seller_GSTIN",
  "Seller_PAN",
  "Seller_Name",
  "Buyer_GSTIN",
  "Buyer_Name",
  "Buyer_PAN",
  "Ship_to_GSTIN",
  "Ship_to_Name",
  "Sub_Total_Amount",
  "Discount_Amount",
  "CGST_Amount",
  "SGST_Amount",
  "IGST_Amount",
  "CESS_Amount",
  "Additional_Cess_Amount",
  "Total_Tax_Amount",
  "IRN_Details",
];

function rowAvg(item) {
  const fc = item?.fields_confidence || {};
  let sum = 0;
  let cnt = 0;
  for (const k of FIELD_KEYS) {
    const v = fc?.[k];
    if (typeof v === 'number' && v > 0) { sum += v; cnt += 1; }
  }
  return cnt ? sum / cnt : 0;
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const format = (url.searchParams.get('format') || 'csv').toLowerCase();

    const projectId = (await getProjectId()) || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) return new Response(JSON.stringify({ error: 'Missing project id' }), { status: 500 });
    const databaseId = process.env.FIRESTORE_DATABASE_ID || '(default)';

    const docs = await listDocuments({ projectId, databaseId, collection: 'Sampling', pageSize: 2000 });
    // Normalize rows from stored structure
    const rowsRaw = docs.map((d) => ({
      recordId: d.fields?.recordId || null,
      zohoDownloadUrl: d.fields?.zohoDownloadUrl || null,
      fields: d.fields?.extracted?.fields || null,
      fields_confidence: d.fields?.extracted?.fields_confidence || null,
      createdAt: d.fields?.createdAt || null,
    }));
    // Filter: require Invoice_Number
    const rows = rowsRaw.filter((r) => {
      const inv = r?.fields?.Invoice_Number;
      return inv != null && String(inv).trim() !== '';
    });
    const rowAverages = rows.map((r) => rowAvg(r));
    const overall = rowAverages.length ? rowAverages.reduce((a, b) => a + b, 0) / rowAverages.length : 0;

    if (format === 'json') {
      return new Response(JSON.stringify({
        success: true,
        overall_avg_confidence: overall,
        count: rows.length,
        rows: rows.map((r, i) => ({
          recordId: r.recordId,
          zohoDownloadUrl: r.zohoDownloadUrl,
          avg_confidence_row: rowAverages[i],
          fields: r.fields,
          fields_confidence: r.fields_confidence,
        })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Default: CSV export
    const header = [
      'recordId',
      'zohoDownloadUrl',
      'avg_confidence_row',
      ...FIELD_KEYS.flatMap((k) => [k, `${k}_confidence`]),
    ];
    const lines = [];
    // Put overall avg on first comment line and as response header
    lines.push(`# Overall_Avg_Confidence,${overall.toFixed(6)}`);
    lines.push(header.join(','));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rec = [
        csvEscape(r.recordId),
        csvEscape(r.zohoDownloadUrl || ''),
        String(rowAverages[i].toFixed(6)),
      ];
      for (const k of FIELD_KEYS) {
        const v = r?.fields?.[k];
        const c = r?.fields_confidence?.[k];
        rec.push(csvEscape(v == null ? '' : v));
        rec.push(csvEscape(typeof c === 'number' ? c.toFixed(6) : ''));
      }
      lines.push(rec.join(','));
    }
    const csv = lines.join('\n');
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Overall-Average': overall.toFixed(6),
        'Content-Disposition': 'attachment; filename="sampling-summary.csv"',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Unknown error' }), { status: 500 });
  }
}

