export const runtime = 'nodejs';

import { getProjectId } from "@/lib/google";
import { listDocuments } from "@/lib/firestore-rest";

function toNum(v, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }

// Compute totals and cost based on tokens + bytes with configurable rates via env
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const projectId = (await getProjectId()) || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) return new Response(JSON.stringify({ error: 'Missing project id' }), { status: 500 });
    const databaseId = process.env.FIRESTORE_DATABASE_ID || '(default)';

    // Pricing params (USD). Provide env defaults; if missing, caller can pass as query too
    const inPer1k = toNum(url.searchParams.get('vertex_in_per_1k') || process.env.VERTEX_PRICE_INPUT_PER_1K_USD, NaN);
    const outPer1k = toNum(url.searchParams.get('vertex_out_per_1k') || process.env.VERTEX_PRICE_OUTPUT_PER_1K_USD, NaN);
    const gcsPerGBMonth = toNum(url.searchParams.get('gcs_per_gb_month') || process.env.GCS_PRICE_PER_GB_MONTH_USD, 0.026);
    const fsWritePer100k = toNum(url.searchParams.get('fs_write_per_100k') || process.env.FS_PRICE_WRITE_PER_100K_USD, 0.18);
    const fsReadPer100k = toNum(url.searchParams.get('fs_read_per_100k') || process.env.FS_PRICE_READ_PER_100K_USD, 0.06);

    const docs = await listDocuments({ projectId, databaseId, collection: 'Sampling', pageSize: 20000 });
    const rows = docs.map((d) => d.fields || {});

    // Totals
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalBytes = 0;
    let writeOps = 0;
    let readOps = 0;
    for (const r of rows) {
      totalInputTokens += toNum(r.inputTokens, 0);
      totalOutputTokens += toNum(r.outputTokens, 0);
      totalBytes += toNum(r.sizeBytes, 0);
      // One write per record; reads are up to you; assume 1 read for this summary
      writeOps += 1;
      readOps += 1;
    }

    // Convert to costs
    const vertexCost = (Number.isFinite(inPer1k) && Number.isFinite(outPer1k))
      ? (totalInputTokens / 1000) * inPer1k + (totalOutputTokens / 1000) * outPer1k
      : null;
    const gcsGBMonth = totalBytes / (1024 * 1024 * 1024);
    const gcsCostMonthly = gcsGBMonth * gcsPerGBMonth;
    const fsCost = (writeOps / 100000) * fsWritePer100k + (readOps / 100000) * fsReadPer100k;

    return new Response(JSON.stringify({
      success: true,
      counts: {
        records: rows.length,
        totalInputTokens,
        totalOutputTokens,
        totalMB: totalBytes / (1024 * 1024),
        writeOps,
        readOps,
      },
      pricing: {
        vertex_in_per_1k_usd: Number.isFinite(inPer1k) ? inPer1k : null,
        vertex_out_per_1k_usd: Number.isFinite(outPer1k) ? outPer1k : null,
        gcs_per_gb_month_usd: gcsPerGBMonth,
        fs_write_per_100k_usd: fsWritePer100k,
        fs_read_per_100k_usd: fsReadPer100k,
      },
      costs: {
        vertex_usd: vertexCost,
        gcs_monthly_storage_usd: gcsCostMonthly,
        firestore_usd: fsCost,
        total_usd: (vertexCost ?? 0) + gcsCostMonthly + fsCost,
      },
      notes: {
        vertex: 'Set VERTEX_PRICE_INPUT_PER_1K_USD and VERTEX_PRICE_OUTPUT_PER_1K_USD envs or pass ?vertex_in_per_1k, ?vertex_out_per_1k. Costs are token-based.',
        gcs: 'Storage assumes Standard tier, single region; network egress not included.',
        firestore: 'Write/read ops estimated at 1 per record for this summary.',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Unknown error' }), { status: 500 });
  }
}

