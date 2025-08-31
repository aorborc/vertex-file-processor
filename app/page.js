"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function Page() {
  const [fileUrl, setFileUrl] = useState("gs://gemini-lens-w9we5.firebasestorage.app/uploads/1756668214325-awfd10.pdf");
  const [prompt, setPrompt] = useState(
    "You are an expert invoice parser. Extract structured JSON with per-field confidence (0-1). Return ONLY JSON. Fields: { supplier_name, supplier_address, supplier_tax_id, invoice_number, invoice_date, due_date, billing_details, shipping_address, bill_to, ship_to, currency, subtotal, tax, total, line_items: [{ description, indent_qty, dispatch_qty, received_qty, quantity, unit_price, amount, confidence }], fields_confidence: { field_name: score } }. Notes: (1) Parse handwritten values for received_qty when present (OK or a number). (2) Map item quantities: indent_qty = requested, dispatch_qty = shipped, received_qty = actually received. (3) Populate quantity as the received_qty if present, else the shipped/dispatch qty. (4) Provide numeric values where possible and dates in YYYY-MM-DD. (5) billing_details and shipping_address should be strings capturing the blocks labelled BILLING DETAILS and SHIPPING ADDRESS if present."
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(null);
  const [timerSec, setTimerSec] = useState(null);
  const [startedAt, setStartedAt] = useState(null);
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "/api/process-file";
  const signedBase = process.env.NEXT_PUBLIC_SIGNED_URL_API_BASE || "/api/signed-url";
  const docCurl = 'POST ' + apiBase + '\nContent-Type: application/json\n\n{\n  "fileUrl": "https://.../file.pdf" | "gs://bucket/path.pdf",\n  "prompt": "<instruction>"\n}';
  const sampleResponse = {
    success: true,
    gcsUri: "gs://<bucket>/uploads/<timestamp>-<id>.pdf",
    extracted: {
      supplier_name: "ACME Corp",
      supplier_name_confidence: 0.98,
      supplier_address: "123 Example St, City",
      supplier_address_confidence: 0.95,
      supplier_tax_id: "27ABCDE1234Z1Z5",
      supplier_tax_id_confidence: 0.9,
      invoice_number: "INV-12345",
      invoice_number_confidence: 0.99,
      invoice_date: "2025-08-31",
      invoice_date_confidence: 0.98,
      due_date: "2025-09-30",
      due_date_confidence: 0.8,
      bill_to: "Cloudstore Retail Pvt Ltd ...",
      bill_to_confidence: 0.95,
      ship_to: "Cloudstore Retail Pvt Ltd ...",
      ship_to_confidence: 0.95,
      currency: "INR",
      currency_confidence: 0.7,
      subtotal: 3990.0,
      subtotal_confidence: 0.9,
      tax: 0.0,
      tax_confidence: 0.5,
      total: 3990.0,
      total_confidence: 0.99,
      line_items: [
        {
          description: "French Beans",
          description_confidence: 0.99,
          quantity: 10,
          quantity_confidence: 0.99,
          unit_price: 90,
          unit_price_confidence: 0.99,
          amount: 900.0,
          amount_confidence: 0.99
        }
      ],
      fields_confidence: {
        supplier_name: 0.98,
        invoice_number: 0.99,
        total: 0.99
      }
    },
    extractedRaw: {
      supplier_name: "ACME Corp",
      supplier_address: "123 Example St, City",
      supplier_tax_id: "27ABCDE1234Z1Z5",
      invoice_number: "INV-12345",
      invoice_date: "2025-08-31",
      due_date: "2025-09-30",
      bill_to: "Cloudstore Retail Pvt Ltd ...",
      ship_to: "Cloudstore Retail Pvt Ltd ...",
      currency: "INR",
      subtotal: 3990.0,
      tax: 0.0,
      total: 3990.0,
      line_items: [
        { description: "French Beans", quantity: 10, unit_price: 90, amount: 900.0, confidence: 0.99 }
      ],
      fields_confidence: { supplier_name: 0.98, invoice_number: 0.99, total: 0.99 }
    },
    vertex: {
      modelVersion: "gemini-2.5-pro",
      candidates: [{ /* trimmed for brevity */ }]
    }
  };
  const docResponse = JSON.stringify(sampleResponse, null, 2);
  const router = useRouter();

  useEffect(() => {
    if (loading && startedAt) {
      setTimerSec("0.0");
      const id = setInterval(() => {
        const s = (Date.now() - startedAt) / 1000;
        setTimerSec(s.toFixed(1));
      }, 100);
      return () => clearInterval(id);
    } else {
      setTimerSec(null);
    }
  }, [loading, startedAt]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    setElapsedMs(null);
    try {
      const started = Date.now();
      setStartedAt(started);
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileUrl, prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Request failed");
      setResult(data);
      setElapsedMs(Date.now() - started);
    } catch (err) {
      setError(err.message || "Unexpected error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="grid" style={{gap:16}}>
      <div className="card" style={{display:'flex', gap:12, alignItems:'center'}}>
        <span className="badge">Endpoints</span>
        <div className="mono" title="Process endpoint">process: {apiBase}</div>
        <div className="mono" title="Signed URL endpoint">signed-url: {signedBase}</div>
      </div>
      <form onSubmit={onSubmit} className="card grid" style={{gap:12}}>
        <label className="label">
          PDF URL
          <input
            className="input"
            type="url"
            placeholder="https://example.com/file.pdf"
            value={fileUrl}
            onChange={(e) => setFileUrl(e.target.value)}
            required
          />
          <div className="muted" style={{fontSize:12}}>
            Original file URL (reference):
            <div className="mono" style={{whiteSpace:'nowrap', overflowX:'auto'}}>
              https://creatorapp.zohopublic.in/file/deloittettipl/trade-invoice-platform/Files/133740007807502149/upload_invoice/download/5WnO5ZXWDuSsTXDKDHKFN3wV2bj2zwCE47zZ97HVe7rCWHnjQQftsTpZqXeO7uBX0eu8qRrS6yANufr7b6PCOMmxk32t43nQeMNb?filepath=/1756645255475149_13.pdf
            </div>
            See API Docs for differences between web file URLs and GCS gs:// URIs.
          </div>
        </label>
        <label className="label">
          Prompt
          <textarea
            className="textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
          />
        </label>
        <button type="submit" disabled={loading} className="btn">
          <svg className="icon" viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
          {loading ? 'Processing…' : 'Send to Vertex'}
        </button>
      </form>

      <div className="row">
        <button
          type="button"
          className="btn secondary"
          disabled={!result}
          onClick={() => {
            if (!result) return;
            try { localStorage.setItem('lastResult', JSON.stringify(result)); } catch {}
            router.push('/preview');
          }}
        >
          <svg className="icon" viewBox="0 0 24 24"><path d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 12a5 5 0 110-10 5 5 0 010 10z"/></svg>
          Open Preview
        </button>
        {!result && <span className="muted">Run once to enable preview</span>}
      </div>

      {error && (<p className="card" style={{borderColor:'var(--danger)', color:'var(--danger)'}}>Error: {error}</p>)}

      <details className="card" style={{padding:12}} open={Boolean(result)}>
        <summary style={{cursor:'pointer', fontWeight:600}}>
          Response
          {loading && timerSec != null && (
            <span className="badge" style={{marginLeft:8}}>{timerSec} s</span>
          )}
          {!loading && elapsedMs != null && (
            <span className="badge" style={{marginLeft:8}}>{(elapsedMs/1000).toFixed(1)} s</span>
          )}
          {!loading && result?.cachedProcess && (
            <span
              className="badge"
              style={{marginLeft:8, background:'#d1fae5', color:'#065f46'}}
              title={(() => {
                const ts = result?.cachedAt ? Date.parse(result.cachedAt) : NaN;
                if (!Number.isNaN(ts)) {
                  const mins = Math.max(0, Math.floor((Date.now() - ts) / 60000));
                  return `Cached ${mins} min${mins===1?'':'s'} ago`;
                }
                return 'Cached';
              })()}
            >
              Cache: HIT
            </span>
          )}
        </summary>
        {result && <pre className="code mono" style={{marginTop:10}}>{JSON.stringify(result, null, 2)}</pre>}
      </details>

      <details className="card" style={{padding:12}}>
        <summary style={{cursor:'pointer', fontWeight:600}}>UI Test Steps</summary>
        <div className="grid" style={{gap:10, marginTop:10}}>
          <ol style={{margin:0, paddingLeft:18}}>
            <li>Enter a PDF URL (or gs:// URI) and adjust the prompt if needed.</li>
            <li>Click “Send to Vertex”. Observe the live timer in seconds on the Response header.</li>
            <li>When the response arrives, “Open Preview” becomes enabled.</li>
            <li>Click “Open Preview” to view the PDF on the left and extracted fields on the right.</li>
            <li>In Preview, edit numeric line items (Qty, Unit Price, Amount). Amount and summary (Subtotal/Total) recalc automatically.</li>
            <li>Trailing confidence (%) appears inside each input. The line items list scrolls independently.</li>
          </ol>
        </div>
      </details>

      <details className="card" style={{padding:12}}>
        <summary style={{cursor:'pointer', fontWeight:600}}>API Docs</summary>
        <div className="grid" style={{gap:10, marginTop:10}}>
          <p className="muted">
            Send a PDF URL and prompt to Vertex AI. The server uploads to Google Cloud Storage and calls Gemini.
            In production, Hosting rewrites <code>/api/process-file</code> to the Cloud Function.
          </p>
          <ul>
            <li>Effective API base: <span className="badge mono">{apiBase}</span></li>
            <li>Accepts http/https or gs:// URLs</li>
            <li>Response includes <code>gcsUri</code>, parsed <code>extracted</code>, and full <code>vertex</code></li>
            <li>Repository: <a href="https://github.com/aorborc/vertex-file-processor" target="_blank" rel="noreferrer">github.com/aorborc/vertex-file-processor</a></li>
          </ul>
          <div>
            <h3 style={{ margin: 0 }}>Request</h3>
            <pre className="code mono">{docCurl}</pre>
          </div>
          <div>
            <h3 style={{ margin: 0 }}>Response (sample)</h3>
            <pre className="code mono">{docResponse}</pre>
          </div>
        </div>
      </details>
    </main>
  );
}
