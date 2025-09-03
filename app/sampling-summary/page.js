"use client";

import { useEffect, useMemo, useState } from "react";

const COLORS = {
  bg: "#f5f6fa",
  text: "#2d3436",
  subText: "#636e72",
  card: "#ffffff",
  border: "#ecf0f1",
  accent: "#00b894", // green
  accentSoft: "#55efc4",
  warn: "#d63031", // red
};

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

function percent(n) {
  if (n == null) return "-";
  const x = Number(n);
  if (Number.isNaN(x)) return "-";
  return `${(x * 100).toFixed(1)}%`;
}

function formatValue(v) {
  if (v == null) return "-";
  if (typeof v === "string") {
    const s = v.trim();
    return s.length ? s : "-";
  }
  return String(v);
}

function rowAvg(r) {
  const fc = r?.fields_confidence || {};
  let sum = 0;
  let cnt = 0;
  for (const k of FIELD_KEYS) {
    const v = fc?.[k];
    if (typeof v === "number" && v > 0) { sum += v; cnt += 1; }
  }
  return cnt ? sum / cnt : 0;
}

export default function SamplingSummaryPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generatedAt, setGeneratedAt] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Use summary API; be robust to HTML error responses in dev
      const res = await fetch("/api/sampling-summary", { cache: "no-store", headers: { Accept: "application/json" } });
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("application/json")) {
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || `Summary failed: ${res.status}`);
        setData(json);
      } else {
        const text = await res.text();
        throw new Error(`Summary failed: ${res.status} ${text.slice(0,300)}`);
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => {
    // Set client-only timestamp to avoid SSR hydration mismatches
    const fmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setGeneratedAt(fmt.format(new Date()));
  }, []);

  const filteredRows = useMemo(() => {
    const rows = data?.rows || [];
    return rows.filter((r) => {
      const inv = r?.fields?.Invoice_Number;
      return inv != null && String(inv).trim() !== "";
    });
  }, [data]);

  const overall = useMemo(() => {
    if (!filteredRows.length) return 0;
    const vals = filteredRows.map((r) => rowAvg(r));
    const sum = vals.reduce((a, b) => a + b, 0);
    return sum / vals.length;
  }, [filteredRows]);

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", padding: 24, color: COLORS.text, fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Sampling Summary</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <a href="/api/sampling-export" style={{ textDecoration: "none" }}>
            <span style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${COLORS.accent}`, background: COLORS.accent, color: '#fff', display: 'inline-block' }}>Download CSV</span>
          </a>
          <button onClick={load} disabled={loading} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${COLORS.border}`, background: "#fff", cursor: loading ? "default" : "pointer" }}>{loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>

      {error && (
        <div style={{ background: "#fff", border: `1px solid ${COLORS.warn}33`, color: COLORS.warn, padding: 10, borderRadius: 10, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginBottom: 16 }}>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16 }}>
          <div style={{ color: COLORS.subText, fontSize: 12, marginBottom: 6 }}>Overall Avg Confidence</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: COLORS.accent }}>{percent(overall)}</div>
        </div>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16 }}>
          <div style={{ color: COLORS.subText, fontSize: 12, marginBottom: 6 }}>Included Rows</div>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{filteredRows.length}</div>
        </div>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 16 }}>
          <div style={{ color: COLORS.subText, fontSize: 12, marginBottom: 6 }}>Generated</div>
          <div style={{ fontSize: 14, color: COLORS.subText }} suppressHydrationWarning>{generatedAt || ''}</div>
        </div>
      </div>

      <div style={{ marginBottom: 6, fontWeight: 600 }}>Details</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 12, overflow: "hidden" }}>
          <thead>
            <tr>
              <th style={{ borderBottom: `1px solid ${COLORS.border}`, textAlign: "left", padding: 10, background: "#fafbff" }}>Record ID</th>
              <th style={{ borderBottom: `1px solid ${COLORS.border}`, textAlign: "left", padding: 10, background: "#fafbff" }}>Download URL</th>
              <th style={{ borderBottom: `1px solid ${COLORS.border}`, textAlign: "right", padding: 10, background: "#fafbff" }}>Avg Confidence (%)</th>
              {FIELD_KEYS.map((k) => (
                <th key={k} style={{ borderBottom: `1px solid ${COLORS.border}`, textAlign: "left", padding: 10, background: "#fafbff" }}>{k}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <tr key={r.recordId || Math.random()}>
                <td style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 10 }}>{r.recordId}</td>
                <td style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 10, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.zohoDownloadUrl ? <a href={r.zohoDownloadUrl} target="_blank" rel="noreferrer" style={{ color: COLORS.accent }}>download</a> : "-"}
                </td>
                <td style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 10, textAlign: "right", color: COLORS.text }}>{percent(rowAvg(r))}</td>
                {FIELD_KEYS.map((k) => (
                  <td key={`${r.recordId}-${k}`} style={{ borderBottom: `1px solid ${COLORS.border}`, padding: 10 }}>
                    {(() => {
                      const val = formatValue(r?.fields?.[k]);
                      const conf = r?.fields_confidence?.[k];
                      return (
                        <span>
                          <span style={{ color: COLORS.text }}>{val}</span>
                          {typeof conf === 'number' ? <span style={{ color: COLORS.subText }}> ({percent(conf)})</span> : null}
                        </span>
                      );
                    })()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
