export const runtime = 'nodejs';

import { getProjectId } from "@/lib/google";
import { listDocuments } from "@/lib/firestore-rest";

export async function GET() {
  try {
    const projectId = (await getProjectId()) || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) return new Response(JSON.stringify({ error: "Missing project id" }), { status: 500 });
    const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";

    const docs = await listDocuments({ projectId, databaseId, collection: "Sampling", pageSize: 1000 });
    const rows = docs.map((d) => ({
      recordId: d.fields?.recordId || null,
      avg_confidence_score: Number(d.fields?.avg_confidence_score || 0),
      zohoDownloadUrl: d.fields?.zohoDownloadUrl || null,
      fields: d.fields?.extracted?.fields || null,
      fields_confidence: d.fields?.extracted?.fields_confidence || null,
      createdAt: d.fields?.createdAt || null,
    }));
    const valid = rows.filter((r) => typeof r.avg_confidence_score === 'number' && !Number.isNaN(r.avg_confidence_score));
    const overall = valid.length ? valid.reduce((a, b) => a + b.avg_confidence_score, 0) / valid.length : 0;

    return new Response(JSON.stringify({ success: true, overall_avg_confidence: overall, count: rows.length, rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || "Unknown error" }), { status: 500 });
  }
}
