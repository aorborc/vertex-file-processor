import { getAccessToken as getGcpAccessToken } from "@/lib/google";

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  const t = typeof v;
  if (t === "string") return { stringValue: v };
  if (t === "number") return { doubleValue: v };
  if (t === "boolean") return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (t === "object") {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = encodeValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function decodeValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("integerValue" in v) return Number(v.integerValue);
  if ("booleanValue" in v) return !!v.booleanValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = decodeValue(val);
    return out;
  }
  return null;
}

async function getAccessToken(scopes = ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/datastore"]) {
  // Delegate to shared helper that supports inline JSON credentials
  return getGcpAccessToken();
}

export async function commitUpsert({ projectId, databaseId = "(default)", collection, docId, data }) {
  if (!projectId) throw new Error("commitUpsert missing projectId");
  if (!collection) throw new Error("commitUpsert missing collection");
  if (!docId) throw new Error("commitUpsert missing docId");
  const token = await getAccessToken();

  async function doCommit(dbid) {
    const endpoint = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(dbid)}/documents:commit`;
    const name = `projects/${projectId}/databases/${dbid}/documents/${collection}/${docId}`;
    const body = {
      writes: [
        {
          update: {
            name,
            fields: encodeValue(data).mapValue.fields,
          },
        },
      ],
    };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      const err = new Error(`Firestore commit failed (${dbid}): ${res.status} ${txt}`);
      err._raw = txt;
      err._status = res.status;
      throw err;
    }
    return true;
  }

  try {
    return await doCommit(databaseId);
  } catch (e) {
    const msg = String(e?._raw || e?.message || e);
    if (databaseId !== "(default)" && /NOT_FOUND|Database not found|invalid database/i.test(msg || "")) {
      // Fallback to default DB automatically
      return await doCommit("(default)");
    }
    throw e;
  }
}

export async function listDocuments({ projectId, databaseId = "(default)", collection, pageSize = 1000 }) {
  if (!projectId) throw new Error("listDocuments missing projectId");
  if (!collection) throw new Error("listDocuments missing collection");
  const token = await getAccessToken();

  async function doList(dbid) {
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(dbid)}/documents/${collection}`;
    let nextToken = undefined;
    const docs = [];
    do {
      const url = new URL(base);
      url.searchParams.set("pageSize", String(pageSize));
      if (nextToken) url.searchParams.set("pageToken", nextToken);
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const txt = await res.text();
        const err = new Error(`Firestore list failed (${dbid}): ${res.status} ${txt}`);
        err._raw = txt;
        err._status = res.status;
        throw err;
      }
      const data = await res.json();
      const arr = data.documents || [];
      for (const d of arr) {
        docs.push({ name: d.name, fields: decodeValue({ mapValue: { fields: d.fields || {} } }) });
      }
      nextToken = data.nextPageToken;
    } while (nextToken);
    return docs;
  }

  try {
    return await doList(databaseId);
  } catch (e) {
    const msg = String(e?._raw || e?.message || e);
    if (databaseId !== "(default)" && /NOT_FOUND|Database not found|invalid database/i.test(msg || "")) {
      return await doList("(default)");
    }
    throw e;
  }
}
