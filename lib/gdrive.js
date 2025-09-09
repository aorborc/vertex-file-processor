import { getAccessTokenWithScopes, getProjectId } from "@/lib/google";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

function parseFolderId(input) {
  if (!input) return null;
  // Accept raw ID
  if (!/^https?:\/\//i.test(input)) return input.trim();
  try {
    const u = new URL(input);
    // Patterns: /drive/folders/<id> or /folders/<id>
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.findIndex((p) => p === "folders");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  } catch {}
  return null;
}

export function extractFolderId(folderIdOrLink) {
  const id = parseFolderId(folderIdOrLink);
  if (!id || /[^A-Za-z0-9_-]/.test(id)) return null;
  return id;
}

export async function listDrivePdfsInFolder({ folderId, pageSize = 400 }) {
  const token = await getAccessTokenWithScopes([DRIVE_SCOPE]);
  const projectId = await getProjectId();
  const base = "https://www.googleapis.com/drive/v3/files";
  const files = [];
  let nextPageToken = undefined;
  const q = `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`;
  do {
    const url = new URL(base);
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "nextPageToken, files(id, name, mimeType, size)");
    url.searchParams.set("pageSize", String(Math.min(1000, pageSize)));
    if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);
    const headers = { Authorization: `Bearer ${token}` };
    if (projectId) headers["X-Goog-User-Project"] = projectId;
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      const txt = await res.text();
      try {
        const err = JSON.parse(txt);
        const reason = err?.error?.details?.[0]?.reason || err?.error?.status || '';
        if (res.status === 403 && /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|PERMISSION_DENIED/i.test(JSON.stringify(err))) {
          throw new Error(
            `Drive list failed: 403 insufficient scopes. Re-auth with Drive scope:\n` +
            `gcloud auth application-default revoke && \\\n+gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive.readonly`
          );
        }
        throw new Error(`Drive list failed: ${res.status} ${txt}`);
      } catch (_) {
        throw new Error(`Drive list failed: ${res.status} ${txt}`);
      }
    }
    const data = await res.json();
    (data.files || []).forEach((f) => files.push(f));
    nextPageToken = data.nextPageToken;
    if (files.length >= pageSize) break;
  } while (nextPageToken);
  return files.slice(0, pageSize);
}

export async function downloadDriveFile({ fileId, timeoutMs = 60000 }) {
  const token = await getAccessTokenWithScopes([DRIVE_SCOPE]);
  const projectId = await getProjectId();
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const headers = { Authorization: `Bearer ${token}` };
    if (projectId) headers["X-Goog-User-Project"] = projectId;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Drive download failed: ${res.status} ${txt}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } finally {
    clearTimeout(t);
  }
}
