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

function formatValue(v) {
  if (v == null) return "-";
  if (typeof v === "string") {
    const s = v.trim();
    return s.length ? s : "-";
  }
  return String(v);
}

function percent(n) {
  if (n == null) return "-";
  const x = Number(n);
  if (Number.isNaN(x)) return "-";
  return `${(x * 100).toFixed(1)}%`;
}

export default function SamplingPage() {
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  const FIELD_KEYS = useMemo(() => [
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
  ], []);

  function rowAvg(r) {
    const fc = r?.fields_confidence || {};
    let sum = 0;
    let cnt = 0;
    for (const k of FIELD_KEYS) {
      const v = fc?.[k];
      if (typeof v === "number" && v > 0) {
        sum += v;
        cnt += 1;
      }
    }
    return cnt ? sum / cnt : 0;
  }

  const filteredRows = useMemo(() => {
    const rows = summary?.rows || [];
    return rows.filter((r) => {
      const inv = r?.fields?.Invoice_Number;
      return inv != null && String(inv).trim() !== "";
    });
  }, [summary]);

  const overall = useMemo(() => {
    if (!filteredRows.length) return 0;
    const vals = filteredRows.map((r) => rowAvg(r));
    const sum = vals.reduce((a, b) => a + b, 0);
    return sum / vals.length;
  }, [filteredRows]);

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
    <div style={{ padding: 24, fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto", background: "#f6f7fb", minHeight: "100vh" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Invoice Sampling Dashboard</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={runSampling} disabled={running} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", background: running ? "#eee" : "white", cursor: running ? "default" : "pointer" }}>{running ? "Running…" : "Run Sampling (200)"}</button>
          <button onClick={refreshSummary} disabled={running} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", background: "white", cursor: running ? "default" : "pointer" }}>Refresh Summary</button>
        </div>
      </div>
      {error && <div style={{ color: "#b00", marginBottom: 12, background: "#fff", border: "1px solid #f3c0c0", padding: 8, borderRadius: 8 }}>Error: {error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <div style={{ background: "white", border: "1px solid #e6e8ef", borderRadius: 12, padding: 16 }}>
          <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 6 }}>Overall Avg Confidence</div>
          <div style={{ fontSize: 28, fontWeight: 600 }}>{percent(overall)}</div>
        </div>
        <div style={{ background: "white", border: "1px solid #e6e8ef", borderRadius: 12, padding: 16 }}>
          <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 6 }}>Included Rows</div>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{filteredRows.length}</div>
        </div>
        <div style={{ background: "white", border: "1px solid #e6e8ef", borderRadius: 12, padding: 16 }}>
          <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 6 }}>Last Run Avg</div>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{lastRun ? number(lastRun.avg_confidence_overall) : "-"}</div>
        </div>
      </div>

      <div style={{ marginBottom: 6, color: "#374151", fontWeight: 600 }}>Summary</div>
      <div style={{ overflowX: "auto" }}>
        {(() => {
          return (
        <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", background: "white", border: "1px solid #e6e8ef", borderRadius: 12, overflow: "hidden" }}>
          <thead>
            <tr>
              <th style={{ borderBottom: "1px solid #e6e8ef", textAlign: "left", padding: 10, background: "#fafbff" }}>Record ID</th>
              <th style={{ borderBottom: "1px solid #e6e8ef", textAlign: "left", padding: 10, background: "#fafbff" }}>Download URL</th>
              <th style={{ borderBottom: "1px solid #e6e8ef", textAlign: "right", padding: 10, background: "#fafbff" }}>Avg Confidence (%)</th>
              {FIELD_KEYS.map((k) => (
                <th key={`${k}-val`} style={{ borderBottom: "1px solid #e6e8ef", textAlign: "left", padding: 10, background: "#fafbff" }}>{k}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <tr key={r.recordId || Math.random()}>
                <td style={{ borderBottom: "1px solid #f0f2f7", padding: 10 }}>{r.recordId}</td>
                <td style={{ borderBottom: "1px solid #f0f2f7", padding: 10, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.zohoDownloadUrl ? <a href={r.zohoDownloadUrl} target="_blank" rel="noreferrer">download</a> : "-"}
                </td>
                <td style={{ borderBottom: "1px solid #f0f2f7", padding: 10, textAlign: "right" }}>{percent(rowAvg(r))}</td>
                {FIELD_KEYS.map((k) => (
                  <td key={`${r.recordId}-${k}`} style={{ borderBottom: "1px solid #f0f2f7", padding: 10 }}>
                    {(() => {
                      const val = formatValue(r?.fields?.[k]);
                      const conf = percent(r?.fields_confidence?.[k]);
                      return (
                        <span>
                          <span style={{ color: "#111827" }}>{val}</span>
                          {conf !== '-' ? <span style={{ color: "#6b7280" }}> ({conf})</span> : null}
                        </span>
                      );
                    })()}
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
