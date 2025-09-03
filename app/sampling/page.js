"use client";

import { useEffect, useMemo, useState } from "react";

function number(n) {
  if (n == null) return "-";
  try {
    const x = Number(n);
    if (Number.isNaN(x)) return "-";
    return x.toFixed(3);
  } catch {
    return String(n);
  }
}

export default function SamplingPage() {
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  const overall = useMemo(() => {
    if (!summary?.rows?.length) return 0;
    return summary.overall_avg_confidence || 0;
  }, [summary]);

  async function refreshSummary() {
    setError(null);
    try {
      const res = await fetch("/api/sampling-summary", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Summary failed: ${res.status}`);
      setSummary(data);
    } catch (e) {
      setError(String(e?.message || e));
    }
  }

  async function runSampling() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/sampling", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Sampling failed: ${res.status}`);
      setLastRun({ when: new Date().toISOString(), ...data });
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setRunning(false);
      await refreshSummary();
    }
  }

  useEffect(() => {
    refreshSummary();
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1>Sampling</h1>
      <p>Fetch 200 Zoho files, extract invoice fields via Vertex, and store results to Firestore collection <code>Sampling</code>.</p>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={runSampling} disabled={running} style={{ padding: "8px 12px" }}>{running ? "Running…" : "Run Sampling (200)"}</button>
        <button onClick={refreshSummary} disabled={running} style={{ padding: "8px 12px" }}>Refresh Summary</button>
      </div>
      {error && <p style={{ color: "#b00" }}>Error: {error}</p>}
      {lastRun && (
        <div style={{ marginTop: 16 }}>
          <strong>Last run:</strong> processed {lastRun.processed}, failed {lastRun.failed}, overall avg {number(lastRun.avg_confidence_overall)}
        </div>
      )}
      <hr style={{ margin: "16px 0" }} />
      <h2>Summary</h2>
      <div style={{ marginBottom: 8 }}>
        <strong>Overall Avg Confidence:</strong> {number(overall)}
      </div>
      <div style={{ overflowX: "auto" }}>
        {(() => {
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
          return (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Record ID</th>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Download URL</th>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Avg Confidence</th>
              {FIELD_KEYS.map((k) => (
                <th key={`${k}-val`} style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>{k}</th>
              ))}
              {FIELD_KEYS.map((k) => (
                <th key={`${k}-conf`} style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>{k}_conf</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(summary?.rows || []).map((r) => (
              <tr key={r.recordId || Math.random()}>
                <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.recordId}</td>
                <td style={{ borderBottom: "1px solid #eee", padding: 6, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.zohoDownloadUrl ? <a href={r.zohoDownloadUrl} target="_blank" rel="noreferrer">download</a> : "-"}
                </td>
                <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{number(r.avg_confidence_score)}</td>
                {FIELD_KEYS.map((k) => (
                  <td key={`${r.recordId}-${k}-v`} style={{ borderBottom: "1px solid #eee", padding: 6 }}>
                    {r?.fields?.[k] != null && r?.fields?.[k] !== "" ? String(r.fields[k]) : "-"}
                  </td>
                ))}
                {FIELD_KEYS.map((k) => (
                  <td key={`${r.recordId}-${k}-c`} style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>
                    {number(r?.fields_confidence?.[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
          );
        })()}
      </div>
    </div>
  );
}
