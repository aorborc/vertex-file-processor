import axios from "axios";

// Utilities to fetch Zoho Creator Files report and build file download URLs

export function extractPrivateLink(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("privatelink") || null;
  } catch {
    return null;
  }
}

export async function fetchZohoFiles({ reportUrl, count = 200 }) {
  if (!reportUrl) throw new Error("Missing Zoho report URL");
  try {
    const res = await axios.get(reportUrl, {
      timeout: 60_000,
      headers: {
        // Some endpoints behave better with an explicit UA
        "User-Agent": "vertex-file-processor/1.0 (+https://github.com/aorborc/vertex-file-processor)",
        Accept: "application/json",
      },
      validateStatus: (s) => s >= 200 && s < 300, // make 4xx/5xx throw below
    });
    const data = res?.data?.data || [];
    return Array.isArray(data) ? data.slice(0, count) : [];
  } catch (e) {
    const status = e?.response?.status;
    const body = e?.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : String(e?.message || e);
    throw new Error(`Zoho report fetch failed: status ${status || 'unknown'} ${body}`);
  }
}

export function parseZohoFilePath(uploadInvoiceValue) {
  // Example input: 
  //   "/api/v2.1/.../upload_invoice/download?filepath=1756906086110711_MBK000028243_0001.pdf"
  if (!uploadInvoiceValue || typeof uploadInvoiceValue !== "string") return null;
  const qIndex = uploadInvoiceValue.indexOf("?");
  const qs = qIndex >= 0 ? uploadInvoiceValue.slice(qIndex + 1) : uploadInvoiceValue;
  const params = new URLSearchParams(qs);
  let fp = params.get("filepath");
  if (!fp) return null;
  if (!fp.startsWith("/")) fp = "/" + fp;
  return fp;
}

export function buildZohoDownloadUrl({ appLinkName, appName, formOrReportName, recordId, fieldLinkName, privateLink, filePath }) {
  // Pattern:
  // https://creatorapp.zohopublic.in/file/{appowner}/{appLinkName}/{formOrReportName}/{recordId}/{fieldLinkName}/download/{privateLink}?filepath=/{filePath}
  // Based on user's example
  if (!recordId || !filePath || !privateLink) return null;
  const appOwner = "deloittettipl"; // fixed per user context
  const base = "https://creatorapp.zohopublic.in/file";
  const link = [base, appOwner, appLinkName || "trade-invoice-platform", formOrReportName || "Files", recordId, fieldLinkName || "upload_invoice", "download", privateLink].join("/");
  const url = `${link}?filepath=${encodeURIComponent(filePath)}`;
  return url;
}
