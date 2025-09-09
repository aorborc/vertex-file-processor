"use client";

import { useEffect, useMemo, useState } from "react";

const COLORS = { bg: "#f5f6fa", text: "#2d3436", subText: "#636e72", card: "#ffffff", border: "#ecf0f1", accent: "#00b894", warn: "#d63031" };
const FIELD_KEYS = [
  "Invoice_Number","Invoice_Date","Seller_GSTIN","Seller_PAN","Seller_Name",
  "Buyer_GSTIN","Buyer_Name","Buyer_PAN","Ship_to_GSTIN","Ship_to_Name",
  "Sub_Total_Amount","Discount_Amount","CGST_Amount","SGST_Amount","IGST_Amount",
  "CESS_Amount","Additional_Cess_Amount","Total_Tax_Amount","IRN_Details",
];

function percent(n) { if (n == null) return "-"; const x = Number(n); if (Number.isNaN(x)) return "-"; return `${(x * 100).toFixed(1)}%`; }
function formatValue(v) { if (v == null) return "-"; if (typeof v === "string") { const s = v.trim(); return s.length ? s : "-"; } return String(v); }
function rowAvg(r) { const fc = r?.fields_confidence || {}; let sum = 0; let cnt = 0; for (const k of FIELD_KEYS) { const v = fc?.[k]; if (typeof v === 'number' && v > 0) { sum += v; cnt += 1; } } return cnt ? sum / cnt : 0; }

export default function PrasoonSamplingSummaryPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({});
  const [sortKey, setSortKey] = useState('avg');
  const [sortDir, setSortDir] = useState('desc');
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [recalcMsg, setRecalcMsg] = useState('');
  const [showOnlyMissing, setShowOnlyMissing] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const url = `/api/prasoon-sampling-summary`;
      const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      const json = ct.includes("application/json") ? await res.json() : { error: `Bad content-type: ${ct}` };
      if (!res.ok) throw new Error(json?.error || `Summary failed: ${res.status}`);
      setData(json);
    } catch (e) { setError(String(e?.message || e)); } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => {
    function onDone() { load(); }
    if (typeof window !== 'undefined') window.addEventListener('prasoon-retry-done', onDone);
    return () => { if (typeof window !== 'undefined') window.removeEventListener('prasoon-retry-done', onDone); };
  }, []);

  const rows = useMemo(() => data?.rows || [], [data]);
  const apiRowsCount = rows.length;
  const withInvoice = useMemo(() => rows.filter((r) => { const inv = r?.fields?.Invoice_Number; return inv != null && String(inv).trim() !== ''; }), [rows]);
  // Overall average includes rows even if Invoice_Number is missing (those will average to 0)
  const overall = useMemo(() => {
    if (!rows.length) return 0;
    const vals = rows.map((r) => rowAvg(r));
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }, [rows]);

  const filtered = useMemo(() => {
    // Column filters: match substrings case-insensitively
    const f = filters || {};
    const hasAny = Object.entries(f).some(([k,v]) => String(v||'').trim() !== '');
    const base = rows.filter((r) => showOnlyMissing ? !(r?.fields?.Invoice_Number && String(r.fields.Invoice_Number).trim() !== '') : true);
    if (!hasAny) return base;
    return base.filter((r) => {
      // recordId
      if (f.recordId && !String(r.recordId||'').toLowerCase().includes(String(f.recordId).toLowerCase())) return false;
      for (const k of FIELD_KEYS) {
        const fv = String(f[k] || '').trim();
        if (!fv) continue;
        const cell = r?.fields?.[k];
        if (!String(cell ?? '').toLowerCase().includes(fv.toLowerCase())) return false;
      }
      return true;
    });
  }, [rows, filters, showOnlyMissing]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      if (sortKey === 'avg') return dir * (rowAvg(a) - rowAvg(b));
      if (sortKey === 'recordId') return dir * String(a.recordId||'').localeCompare(String(b.recordId||''));
      if (FIELD_KEYS.includes(sortKey)) {
        const av = a?.fields?.[sortKey]; const bv = b?.fields?.[sortKey];
        const an = Number(av); const bn = Number(bv);
        const aNum = !Number.isNaN(an) && String(av).trim() !== '';
        const bNum = !Number.isNaN(bn) && String(bv).trim() !== '';
        if (aNum && bNum) return dir * (an - bn);
        return dir * String(av||'').localeCompare(String(bv||''));
      }
      return 0;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  return (
    <div style={{ background: COLORS.bg, minHeight: '100vh', padding: 24, color: COLORS.text }}>

      {error && <div style={{ background: '#fff', border: `1px solid ${COLORS.warn}33`, color: COLORS.warn, padding: 10, borderRadius: 10, marginBottom: 12 }}>{error}</div>}

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3, minmax(0,1fr))', gap:12, marginBottom:16}}>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16 }}>
          <div style={{ color: COLORS.subText, fontSize: 12, marginBottom: 6 }}>Overall Avg Confidence</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: COLORS.accent }}>{percent(overall)}</div>
          <div style={{ color: COLORS.subText, fontSize: 12, marginTop: 4 }}>Includes rows without Invoice_Number (counted as 0)</div>
        </div>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16 }}>
          <div style={{ color: COLORS.subText, fontSize: 12, marginBottom: 6 }}>Included Rows</div>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{withInvoice.length}</div>
          <div style={{ color: COLORS.subText, fontSize: 12, marginTop: 4 }}>Rows with a non-empty Invoice_Number</div>
        </div>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16 }}>
          <div style={{ color: COLORS.subText, fontSize: 12, marginBottom: 6 }}>API Rows</div>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{apiRowsCount}</div>
          <div style={{ color: COLORS.subText, fontSize: 12, marginTop: 4 }}>All rows returned by the API</div>
        </div>
      </div>

      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>Details</div>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color: COLORS.subText }}>
          <input type="checkbox" checked={showOnlyMissing} onChange={(e)=>setShowOnlyMissing(e.target.checked)} />
          Show only rows without Invoice_Number
        </label>
      </div>
      <div style={{ position:'relative', overflowX: 'auto' }}>
        {loading && (
          <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(255,255,255,0.6)', zIndex:2 }}>
            <div style={{ width:32, height:32, border:'3px solid #ccc', borderTopColor: COLORS.accent, borderRadius:'50%', animation:'spin 1s linear infinite' }} />
            <style jsx>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
          </div>
        )}
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <thead>
            <tr>
              <th style={{ position:'sticky', top:0, zIndex:1, borderBottom: `1px solid ${COLORS.border}`, textAlign:'left', padding:10, background:'#fafbff', cursor:'pointer' }} onClick={()=>{ setSortKey('recordId'); setSortDir(sortKey==='recordId' && sortDir==='asc' ? 'desc' : 'asc'); }}>Record ID</th>
              <th style={{ position:'sticky', top:0, zIndex:1, borderBottom: `1px solid ${COLORS.border}`, textAlign:'left', padding:10, background:'#fafbff' }}>Download</th>
              <th style={{ position:'sticky', top:0, zIndex:1, borderBottom: `1px solid ${COLORS.border}`, textAlign:'right', padding:10, background:'#fafbff', cursor:'pointer' }} onClick={()=>{ setSortKey('avg'); setSortDir(sortKey==='avg' && sortDir==='asc' ? 'desc' : 'asc'); }}>Avg Confidence (%)</th>
              {FIELD_KEYS.map((k) => (
                <th key={k} style={{ position:'sticky', top:0, zIndex:1, borderBottom: `1px solid ${COLORS.border}`, textAlign:'left', padding:10, background:'#fafbff', cursor:'pointer' }} onClick={()=>{ setSortKey(k); setSortDir(sortKey===k && sortDir==='asc' ? 'desc' : 'asc'); }}>{k}</th>
              ))}
            </tr>
            {/* Column search row */}
            <tr>
              <th style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 8 }}>
                <input className="input" placeholder="filter id" value={filters.recordId||''} onChange={(e)=>setFilters((f)=>({ ...f, recordId: e.target.value }))} />
              </th>
              <th style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 8 }}>
                <span style={{ color: COLORS.subText, fontSize: 12 }}>drive link</span>
              </th>
              <th style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 8 }}>
                <span style={{ color: COLORS.subText, fontSize: 12 }}>avg</span>
              </th>
              {FIELD_KEYS.map((k) => (
                <th key={`f-${k}`} style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 8 }}>
                  <input className="input" placeholder="filter" value={filters[k]||''} onChange={(e)=>setFilters((f)=>({ ...f, [k]: e.target.value }))} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const hasInvoice = !!(r?.fields?.Invoice_Number && String(r.fields.Invoice_Number).trim() !== '');
              return (
                <tr key={r.recordId || Math.random()} style={{ transition:'background 120ms ease' }}>
                  <td style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 10, position:'relative', minWidth: 160 }}>
                    {!showOnlyMissing && <span>{r.recordId}</span>}
                    {showOnlyMissing && !hasInvoice && (
                      <RetryButton recordId={r.recordId} visible={true} big={true} />
                    )}
                  </td>
                <td style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 10, maxWidth: 320, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {r.downloadUrl ? <a href={r.downloadUrl} target="_blank" rel="noreferrer" style={{ color: COLORS.accent, textDecoration:'none' }}>view invoice</a> : '-'}
                </td>
                <td style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 10, textAlign:'right' }}>{percent(rowAvg(r))}</td>
                {FIELD_KEYS.map((k) => (
                  <td key={`${r.recordId}-${k}`} style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 10 }}>
                    {(() => { const val = formatValue(r?.fields?.[k]); const conf = r?.fields_confidence?.[k]; return (<span><span>{val}</span>{typeof conf === 'number' ? <span style={{ color: COLORS.subText }}> ({percent(conf)})</span> : null}</span>); })()}
                  </td>
                ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RetryButton({ recordId, visible, big }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function onRetry() {
    if (!recordId || busy) return;
    setBusy(true); setDone(false);
    try {
      const res = await fetch('/api/prasoon-retry', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ recordId }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Retry failed: ${res.status}`);
      setDone(true);
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('prasoon-retry-done'));
    } catch (e) {
      alert(String(e?.message || e));
    } finally {
      setBusy(false);
      setTimeout(() => setDone(false), 2000);
    }
  }
  const pad = big ? '8px 14px' : '4px 8px';
  const fs = big ? 14 : 12;
  const bg = big ? COLORS.accent : '#fff';
  const col = big ? '#fff' : COLORS.text;
  return (
    <button title="Retry with Vertex" onClick={onRetry}
            style={{ position:'absolute', right: 8, top: '50%', transform:'translateY(-50%)', opacity: visible?1:0, pointerEvents: visible?'auto':'none', transition:'opacity 120ms', padding: pad, borderRadius:8, border:`1px solid ${big ? COLORS.accent : COLORS.border}`, background:bg, color: col, fontSize:fs, fontWeight:600, boxShadow: big ? '0 1px 3px rgba(0,0,0,0.08)' : 'none' }}
            className="retry-btn"
    >
      {busy ? 'Retrying…' : (done ? 'Done' : 'Retry Now')}
    </button>
  );
}
