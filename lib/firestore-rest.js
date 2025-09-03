import { GoogleAuth } from "google-auth-library";

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
  const auth = new GoogleAuth({ scopes });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token || !token.token) throw new Error("Failed to obtain Google access token");
  return token.token;
}

export async function commitUpsert({ projectId, databaseId = "(default)", collection, docId, data }) {
  if (!projectId) throw new Error("commitUpsert missing projectId");
  if (!collection) throw new Error("commitUpsert missing collection");
  if (!docId) throw new Error("commitUpsert missing docId");
  const token = await getAccessToken();
  const endpoint = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents:commit`;
  const name = `projects/${projectId}/databases/${databaseId}/documents/${collection}/${docId}`;
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
    throw new Error(`Firestore commit failed: ${res.status} ${txt}`);
  }
  return true;
}

export async function listDocuments({ projectId, databaseId = "(default)", collection, pageSize = 1000 }) {
  if (!projectId) throw new Error("listDocuments missing projectId");
  if (!collection) throw new Error("listDocuments missing collection");
  const token = await getAccessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents/${collection}`;
  let nextToken = undefined;
  const docs = [];
  do {
    const url = new URL(base);
    url.searchParams.set("pageSize", String(pageSize));
    if (nextToken) url.searchParams.set("pageToken", nextToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Firestore list failed: ${res.status} ${txt}`);
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

