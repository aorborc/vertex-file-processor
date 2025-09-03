export const runtime = 'nodejs';

import { getProjectId } from "@/lib/google";
import { listDocuments, getDocument, commitUpsert } from "@/lib/firestore-rest";

function nowIso() { return new Date().toISOString(); }

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const reset = String(url.searchParams.get('reset') || '').toLowerCase() === 'true';
    const ttlSec = Math.max(0, Number(url.searchParams.get('ttlSec') || process.env.SUMMARY_CACHE_TTL_SEC || 300));

    const projectId = (await getProjectId()) || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) return new Response(JSON.stringify({ error: "Missing project id" }), { status: 500 });
    const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";

    const cacheColl = 'SamplingSummaryCache';
    const cacheId = 'latest';

    if (!reset) {
      const cached = await getDocument({ projectId, databaseId, collection: cacheColl, docId: cacheId });
      if (cached && cached.fields) {
        const cachedAt = cached.fields.cachedAt ? Date.parse(cached.fields.cachedAt) : null;
        const fresh = cachedAt && (Date.now() - cachedAt) < ttlSec * 1000;
        if (fresh) {
          const payload = { ...cached.fields, cached: true };
          return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Cache': 'hit' } });
        }
      }
    }

    // Recompute summary
    const docs = await listDocuments({ projectId, databaseId, collection: "Sampling", pageSize: 5000 });
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

    const summary = { success: true, overall_avg_confidence: overall, count: rows.length, rows, cachedAt: nowIso() };
    await commitUpsert({ projectId, databaseId, collection: cacheColl, docId: cacheId, data: summary });
    return new Response(JSON.stringify({ ...summary, cached: false }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Cache': 'miss' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || "Unknown error" }), { status: 500 });
  }
}
