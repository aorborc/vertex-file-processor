"use client";

import { useState } from "react";

export default function Page() {
  const [fileUrl, setFileUrl] = useState("https://creatorapp.zohopublic.in/file/deloittettipl/trade-invoice-platform/Files/133740007807502149/upload_invoice/download/5WnO5ZXWDuSsTXDKDHKFN3wV2bj2zwCE47zZ97HVe7rCWHnjQQftsTpZqXeO7uBX0eu8qRrS6yANufr7b6PCOMmxk32t43nQeMNb?filepath=/1756645255475149_13.pdf");
  const [prompt, setPrompt] = useState(
    "Extract structured invoice data with per-field confidence scores. Return ONLY JSON with this schema: { supplier_name, supplier_address, supplier_tax_id, invoice_number, invoice_date, due_date, bill_to, ship_to, currency, subtotal, tax, total, line_items: [{ description, quantity, unit_price, amount, confidence }], fields_confidence: { field_name: score } }. Parse all line items (description, quantity, unit_price, amount). Provide numeric values where possible. Confidence range 0-1."
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "/api/process-file";
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

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileUrl, prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Request failed");
      setResult(data);
    } catch (err) {
      setError(err.message || "Unexpected error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main>
      <h1>Vertex PDF Processor</h1>
      <section style={{ margin: '16px 0', padding: 12, background: '#f7fafc', border: '1px solid #e3e8ee' }}>
        <h2 style={{ marginTop: 0 }}>Overview</h2>
        <p>
          Use this page to send a PDF URL and prompt to Vertex AI. The server uploads to Google Cloud Storage and calls Gemini. In production, Hosting rewrites <code>/api/process-file</code> to the Cloud Function.
        </p>
        <ul>
          <li>Effective API base: <code>{apiBase}</code></li>
          <li>Accepts http/https or gs:// URLs</li>
          <li>Response includes <code>gcsUri</code>, parsed <code>extracted</code>, and full <code>vertex</code></li>
        </ul>
        <h3>Request</h3>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{docCurl}</pre>
        <h3>Response (sample)</h3>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{docResponse}</pre>
      </section>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12, maxWidth: 900 }}>
        <label>
          PDF URL
          <input
            type="url"
            placeholder="https://example.com/file.pdf"
            value={fileUrl}
            onChange={(e) => setFileUrl(e.target.value)}
            required
            style={{ width: '100%', padding: 8, marginTop: 4 }}
          />
        </label>
        <label>
          Prompt
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            style={{ width: '100%', padding: 8, marginTop: 4 }}
          />
        </label>
        <button type="submit" disabled={loading} style={{ padding: '8px 12px', width: 'fit-content' }}>
          {loading ? 'Processing…' : 'Send to Vertex'}
        </button>
      </form>

      {error && (
        <p style={{ color: 'crimson', marginTop: 16 }}>Error: {error}</p>
      )}

      {result && (
        <div style={{ marginTop: 16 }}>
          <h3>Response</h3>
          <pre style={{ background: '#f5f5f5', padding: 12, overflowX: 'auto' }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </main>
  );
}
