export const runtime = 'nodejs';

import { getProjectId } from "@/lib/google";
import { listDocuments, commitUpsert } from "@/lib/firestore-rest";

function calcAvg(fields_confidence) {
  const vals = Object.values(fields_confidence || {}).filter((v) => typeof v === 'number' && v > 0);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export async function POST(request) {
  try {
    const url = new URL(request.url);
    const projectId = (await getProjectId()) || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) return new Response(JSON.stringify({ error: 'Missing project id' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    const databaseId = process.env.FIRESTORE_DATABASE_ID || '(default)';

    const docs = await listDocuments({ projectId, databaseId, collection: 'Sampling', pageSize: 5000 });
    const candidates = docs.filter((d) => (d.fields?.tag === 'prasoon-sampling'));

    let updated = 0;
    const changes = [];
    for (const d of candidates) {
      const f = d.fields || {};
      const fc = f.extracted?.fields_confidence || {};
      const avg = calcAvg(fc);
      const prev = Number(f.avg_confidence_score || 0);
      // Update only if difference > 1e-6
      if (!(Math.abs(prev - avg) <= 1e-6)) {
        const name = d.name || '';
        const parts = name.split('/');
        const docId = parts[parts.length - 1];
        const next = { ...f, avg_confidence_score: avg };
        await commitUpsert({ projectId, databaseId, collection: 'Sampling', docId: String(docId), data: next });
        updated += 1;
        changes.push({ docId, prev, next: avg });
      }
    }

    return new Response(JSON.stringify({ success: true, scanned: candidates.length, updated, changes }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Unknown error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

