"use client";
export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

function safeParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

export default function PreviewPage() {
  const router = useRouter();
  const [gcsUri, setGcsUri] = useState("");
  const [viewerUrl, setViewerUrl] = useState("");
  const [extracted, setExtracted] = useState(null);
  const [raw, setRaw] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    // Try to load last result from localStorage + URL params
    const persisted = safeParse(localStorage.getItem("lastResult"));
    const sp = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
    const paramGs = sp.get("gsUri") || sp.get("gcsUri");
    const paramData = sp.get("data");
    let initialGs = paramGs || persisted?.gcsUri || persisted?.url || "";
    let initialExtracted = persisted?.extracted || null;
    let initialRaw = persisted?.extractedRaw || persisted?.vertex || null;
    if (paramData) {
      const decoded = safeParse(decodeURIComponent(paramData));
      if (decoded) {
        initialExtracted = decoded.extracted || initialExtracted;
        initialRaw = decoded.extractedRaw || initialRaw;
      }
    }
    if (initialGs) setGcsUri(initialGs);
    if (initialExtracted) setExtracted(initialExtracted);
    if (initialRaw) setRaw(initialRaw);
  }, []);

  useEffect(() => {
    async function run() {
      if (!gcsUri) return;
      setLoading(true); setError(null);
      try {
        const signedBase = process.env.NEXT_PUBLIC_SIGNED_URL_API_BASE || '/api/signed-url';
        const url = `${signedBase}?gsUri=${encodeURIComponent(gcsUri)}&ttlSec=604800`;
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to create signed URL");
        setViewerUrl(data.url);
      } catch (e) {
        setError(e.message || String(e));
      } finally { setLoading(false); }
    }
    run();
  }, [gcsUri]);

  const [form, setForm] = useState({});
  useEffect(() => {
    if (extracted && typeof extracted === "object") {
      setForm(extracted);
    }
  }, [extracted]);

  function toNum(v) {
    const n = typeof v === 'string' ? v.replace(/[^0-9.+-]/g, '') : v;
    const p = parseFloat(n);
    return Number.isFinite(p) ? p : 0;
  }

  function recomputeTotals(items, prev) {
    const subtotal = (items || []).reduce((s, it) => s + toNum(it.amount), 0);
    const tax = toNum(prev?.tax);
    const total = subtotal + tax;
    return { subtotal: Number(subtotal.toFixed(2)), total: Number(total.toFixed(2)) };
  }

  function updateField(field, value) {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      if (field === 'tax') {
        const { subtotal, total } = recomputeTotals(next.line_items, next);
        next.subtotal = subtotal;
        next.total = total;
      }
      return next;
    });
  }

  function updateLineItem(idx, field, value) {
    setForm((prev) => {
      const items = Array.isArray(prev.line_items) ? [...prev.line_items] : [];
      const base = items[idx] || {};
      let nextItem = { ...base, [field]: value };
      // numeric-only and auto-calc
      const q = toNum(field === 'quantity' ? value : base.quantity);
      const u = toNum(field === 'unit_price' ? value : base.unit_price);
      if (field === 'quantity' || field === 'unit_price') {
        const amt = Number((q * u).toFixed(2));
        nextItem.quantity = q;
        nextItem.unit_price = u;
        nextItem.amount = amt;
      } else if (field === 'amount') {
        nextItem.amount = toNum(value);
      }
      items[idx] = nextItem;

      const { subtotal, total } = recomputeTotals(items, prev);
      return { ...prev, line_items: items, subtotal, total };
    });
  }

  function addLineItem() {
    setForm((prev) => ({
      ...prev,
      line_items: [...(prev.line_items || []), { description: "", quantity: 0, unit_price: 0, amount: 0 }],
    }));
  }

  function removeLineItem(idx) {
    setForm((prev) => ({
      ...prev,
      line_items: (prev.line_items || []).filter((_, i) => i !== idx),
    }));
  }

  async function onAccept() {
    // For now, just copy JSON to clipboard and show confirmation
    try {
      await navigator.clipboard.writeText(JSON.stringify({ gcsUri, data: form }, null, 2));
      setAccepted(true);
      setTimeout(() => setAccepted(false), 3000);
    } catch (e) {
      alert("Copied to clipboard failed: " + (e.message || String(e)));
    }
  }

  return (
    <main className="split">
      <div className="panel">
        <h2 style={{ margin: '12px 0' }}>Invoice Preview</h2>
        <div className="row" style={{ marginBottom: 8 }}>
          <input
            type="text"
            value={gcsUri}
            onChange={(e) => setGcsUri(e.target.value)}
            placeholder="gs://bucket/path.pdf"
            className="input"
            style={{ flex: 1 }}
          />
          <button className="btn" onClick={() => setGcsUri(gcsUri)} disabled={!gcsUri || loading}>
            <svg className="icon" viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zm7-18l-5.5 9h11z"/></svg>
            Load
          </button>
        </div>
        {error && <div className="card" style={{ color: 'var(--danger)' }}>Error: {error}</div>}
        <div className="viewer">
          {viewerUrl ? (
            // Try to embed PDF directly
            <iframe title="pdf" src={viewerUrl} style={{ width: '100%', height: '100%', border: 'none' }} />
          ) : (
            <div style={{ padding: 16, color: '#555' }}>{loading ? 'Generating viewer…' : 'Enter a gs:// URI to preview.'}</div>
          )}
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Preview URL auto-refreshes as needed (valid up to 7 days).
        </div>
      </div>

      <div className="panel panel-scroll" style={{ minWidth: 360 }}>
        <h2 style={{ margin: '12px 0' }}>Review & Edit</h2>
        <div className="grid" style={{ gap: 10 }}>
          {[
            ["supplier_name", "Supplier Name"],
            ["supplier_address", "Supplier Address"],
            ["supplier_tax_id", "Supplier Tax ID"],
            ["invoice_number", "Invoice #"],
            ["invoice_date", "Invoice Date"],
            ["due_date", "Due Date"],
            ["bill_to", "Bill To"],
            ["ship_to", "Ship To"],
            ["currency", "Currency"],
            ["subtotal", "Subtotal"],
            ["tax", "Tax"],
            ["total", "Total"],
          ].map(([key, label]) => {
            const conf = form?.[`${key}_confidence`] ?? extracted?.fields_confidence?.[key] ?? null;
            const confPct = (typeof conf === 'number' && !Number.isNaN(conf)) ? Math.round(conf * 100) + '%' : '—';
            const isCurrency = ["subtotal","tax","total"].includes(key);
            const readOnly = ["subtotal","total"].includes(key);
            return (
              <div key={key} className="label" style={{gap:6}}>
                {label}
                <div className="input-wrap" style={{maxWidth: isCurrency ? 260 : undefined}}>
                  {isCurrency && <span className="input-leading-icon">₹</span>}
                  <input
                    value={form?.[key] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (key === 'tax') {
                        const cleaned = String(v).replace(/[^0-9.\-]/g,'').replace(/(\..*)\./,'$1');
                        updateField(key, cleaned);
                      } else {
                        updateField(key, v);
                      }
                    }}
                    className={`input ${isCurrency ? 'leading' : ''} trailing`}
                    readOnly={readOnly}
                  />
                  <span className="input-trailing-badge" title="confidence">{confPct}</span>
                </div>
              </div>
            );
          })}

          <div style={{ display:'flex', flexDirection:'column', minHeight:0, gap:8 }}>
            <h3 style={{ margin: '8px 0' }}>Line Items</h3>
              <div className="card" style={{ padding: 8, display:'flex', flexDirection:'column', minHeight:0, gap:8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px,1fr) 110px 110px 120px 110px 140px 140px 48px', gap: 12, fontWeight: 600, marginBottom: 8 }}>
                <div>Description</div>
                <div>Indent</div>
                <div>Dispatch</div>
                <div>Received</div>
                <div>Qty</div>
                <div>Unit Price</div>
                <div>Amount</div>
                <div className="muted">Del</div>
              </div>
              <div className="scroll" style={{ flex:1 }}>
                {(form?.line_items || []).map((li, idx) => {
                  const dConf = li?.description_confidence ?? li?.confidence ?? null;
                  const iConf = li?.indent_qty_confidence ?? li?.confidence ?? null;
                  const disConf = li?.dispatch_qty_confidence ?? li?.confidence ?? null;
                  const rConf = li?.received_qty_confidence ?? li?.confidence ?? null;
                  const qConf = li?.quantity_confidence ?? li?.confidence ?? null;
                  const uConf = li?.unit_price_confidence ?? li?.confidence ?? null;
                  const aConf = li?.amount_confidence ?? li?.confidence ?? null;
                  const pct = (v)=> (typeof v==='number' && !Number.isNaN(v)) ? Math.round(v*100)+'%' : '—';
                  return (
                    <div key={idx} style={{ display: 'grid', gridTemplateColumns: 'minmax(240px,1fr) 110px 110px 120px 110px 140px 140px 48px', gap: 12, alignItems: 'center', marginBottom: 10 }}>
                      <div className="input-wrap" style={{ minWidth: 0 }}>
                        <input className="input trailing" value={li.description ?? ''} onChange={(e)=>updateLineItem(idx,'description',e.target.value)} />
                        <span className="input-trailing-badge" title="confidence">{pct(dConf)}</span>
                      </div>
                      <div className="input-wrap">
                        <input className="input trailing" type="text" inputMode="decimal" style={{minWidth:110}} value={li.indent_qty ?? ''} onChange={(e)=>updateLineItem(idx,'indent_qty',e.target.value)} />
                        <span className="input-trailing-badge" title="confidence">{pct(iConf)}</span>
                      </div>
                      <div className="input-wrap">
                        <input className="input trailing" type="text" inputMode="decimal" style={{minWidth:110}} value={li.dispatch_qty ?? ''} onChange={(e)=>updateLineItem(idx,'dispatch_qty',e.target.value)} />
                        <span className="input-trailing-badge" title="confidence">{pct(disConf)}</span>
                      </div>
                      <div className="input-wrap">
                        <input className="input trailing" type="text" style={{minWidth:120}} value={li.received_qty ?? ''} onChange={(e)=>updateLineItem(idx,'received_qty',e.target.value)} />
                        <span className="input-trailing-badge" title="confidence">{pct(rConf)}</span>
                      </div>
                      <div className="input-wrap">
                        <input className="input trailing" type="text" inputMode="decimal" style={{minWidth:110}} value={li.quantity ?? ''} onChange={(e)=>updateLineItem(idx,'quantity',e.target.value)} />
                        <span className="input-trailing-badge" title="confidence">{pct(qConf)}</span>
                      </div>
                      <div className="input-wrap">
                        <span className="input-leading-icon">₹</span>
                        <input className="input leading trailing" type="text" inputMode="decimal" style={{minWidth:140}} value={li.unit_price ?? ''} onChange={(e)=>updateLineItem(idx,'unit_price',e.target.value)} />
                        <span className="input-trailing-badge" title="confidence">{pct(uConf)}</span>
                      </div>
                      <div className="input-wrap">
                        <span className="input-leading-icon">₹</span>
                        <input className="input leading trailing" type="text" inputMode="decimal" style={{minWidth:140}} value={li.amount ?? ''} onChange={(e)=>updateLineItem(idx,'amount',e.target.value)} />
                        <span className="input-trailing-badge" title="confidence">{pct(aConf)}</span>
                      </div>
                      <div>
                        <button className="btn warn" onClick={() => removeLineItem(idx)} type="button" title="Remove row" style={{ padding: 8 }}>
                          <svg className="icon" viewBox="0 0 24 24"><path d="M6 7h12v2H6zm2 3h8l-1 11H9L8 10zm3-7h2v2h-2z"/></svg>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button className="btn secondary" type="button" onClick={addLineItem} style={{ marginTop: 8 }}>
                <svg className="icon" viewBox="0 0 24 24"><path d="M11 11V6h2v5h5v2h-5v5h-2v-5H6v-2z"/></svg>
                Add line item
              </button>
              </div>
          </div>

          <div className="row">
            <button className="btn" type="button" onClick={onAccept}>
              <svg className="icon" viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v16h13c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 18H8V7h11v16z"/></svg>
              Accept & Copy JSON
            </button>
            {accepted && <span style={{ color: 'green', alignSelf: 'center' }}>Copied!</span>}
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <h3>Raw extracted (read-only)</h3>
          <pre className="code mono" style={{ maxHeight: 240 }}>{JSON.stringify(raw, null, 2)}</pre>
        </div>
      </div>
    </main>
  );
}
