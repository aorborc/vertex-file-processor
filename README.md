Vertex File Processor (Next.js, JS)

This app accepts a PDF URL and a prompt, downloads the file, uploads it to Google Cloud Storage, calls Vertex AI (Gemini 1.5) with the file + prompt, and returns the result as JSON.

Setup
- Node: 18+
- Copy `.env.local.example` to `.env.local` and fill values:
  - `GOOGLE_APPLICATION_CREDENTIALS_JSON`: full service account JSON (as one line)
  - `GOOGLE_CLOUD_PROJECT`: your GCP project id (e.g. `gemini-lens-w9we5` from your Firebase project)
  - `GCS_BUCKET`: a bucket accessible by that service account (e.g. Firebase default bucket `gemini-lens-w9we5.appspot.com`)
  - `VERTEX_LOCATION` (optional): defaults to `us-central1`
  - `VERTEX_MODEL` (optional): defaults to `gemini-2.5-pro` (set to another supported model like `gemini-2.5-flash` or `gemini-2.0-flash-001`)

Install & Run
- `npm install`
- `npm run dev`
- Open http://localhost:3000

API
- `POST /api/process-file`
  - body: `{ "fileUrl": "https://.../file.pdf" | "gs://bucket/path.pdf", "prompt": "..." }`
  - response: `{ success, gcsUri: "gs://...", vertex: {...} }`
  - Behavior:
    - Accepts either http/https URL or an existing `gs://` URL.
    - If `VERTEX_INPUT=inline` (function env), the function uploads to GCS but sends the content inline to Vertex to avoid GCS reads by Vertex.
- `GET /api/verify-auth`
  - response: `{ authMode, projectId, location, model, bucket, hasCredentialsJson }`

Request

```
POST /api/process-file
Content-Type: application/json

{
  "fileUrl": "https://.../file.pdf" | "gs://bucket/path.pdf",
  "prompt": "<instruction>"
}
```

Response (sample)

```json
{
  "success": true,
  "gcsUri": "gs://<bucket>/uploads/<timestamp>-<id>.pdf",
  "extracted": {
    "supplier_name": "ACME Corp",
    "supplier_name_confidence": 0.98,
    "supplier_address": "123 Example St, City",
    "supplier_address_confidence": 0.95,
    "supplier_tax_id": "27ABCDE1234Z1Z5",
    "supplier_tax_id_confidence": 0.9,
    "invoice_number": "INV-12345",
    "invoice_number_confidence": 0.99,
    "invoice_date": "2025-08-31",
    "invoice_date_confidence": 0.98,
    "due_date": "2025-09-30",
    "due_date_confidence": 0.8,
    "bill_to": "Cloudstore Retail Pvt Ltd ...",
    "bill_to_confidence": 0.95,
    "ship_to": "Cloudstore Retail Pvt Ltd ...",
    "ship_to_confidence": 0.95,
    "currency": "INR",
    "currency_confidence": 0.7,
    "subtotal": 3990.0,
    "subtotal_confidence": 0.9,
    "tax": 0.0,
    "tax_confidence": 0.5,
    "total": 3990.0,
    "total_confidence": 0.99,
    "line_items": [
      {
        "description": "French Beans",
        "description_confidence": 0.99,
        "quantity": 10,
        "quantity_confidence": 0.99,
        "unit_price": 90,
        "unit_price_confidence": 0.99,
        "amount": 900.0,
        "amount_confidence": 0.99
      }
    ],
    "fields_confidence": {
       "supplier_name": 0.98,
       "invoice_number": 0.99,
       "total": 0.99
    }
  },
  "extractedRaw": {
    "supplier_name": "ACME Corp",
    "supplier_address": "123 Example St, City",
    "supplier_tax_id": "27ABCDE1234Z1Z5",
    "invoice_number": "INV-12345",
    "invoice_date": "2025-08-31",
    "due_date": "2025-09-30",
    "bill_to": "Cloudstore Retail Pvt Ltd ...",
    "ship_to": "Cloudstore Retail Pvt Ltd ...",
    "currency": "INR",
    "subtotal": 3990.0,
    "tax": 0.0,
    "total": 3990.0,
    "line_items": [
      { "description": "French Beans", "quantity": 10, "unit_price": 90, "amount": 900.0, "confidence": 0.99 }
    ],
    "fields_confidence": { "supplier_name": 0.98, "invoice_number": 0.99, "total": 0.99 }
  },
  "vertex": {
    "modelVersion": "gemini-2.5-pro",
    "candidates": [ { "content": { "role": "model", "parts": [ { "text": "..." } ] } } ]
  }
}
```

Notes
- Do not commit real credentials. Use `.env.local` for local development.
- The route runs on the Node.js runtime (not Edge) due to GCS usage.

Firebase Cloud Functions (ADC) setup
- Create dedicated service account (recommended): `vertex-runner@<project>.iam.gserviceaccount.com` with:
  - `roles/aiplatform.user` (Vertex AI User)
  - `roles/storage.objectCreator` and `roles/storage.objectViewer` on your bucket (or project-level if simpler)
- The repository now includes a Cloud Function `processFile` in `/functions` using ADC (no keys).
  - It uses the runtime service account by default. To force a specific one, set env `FUNCTION_SERVICE_ACCOUNT` before deploy or edit `functions/index.js` options.
  - Bucket resolution priority: `GCS_BUCKET` env → Firebase `FIREBASE_CONFIG.storageBucket` → `<projectId>.appspot.com`.

Deploy the function (from project root)
- cd vertex-file-processor
- Install firebase-tools: `npm i -g firebase-tools`
- Login and set project: `firebase login` then `firebase use gemini-lens-w9we5`
- Install deps: `cd functions && npm install && cd ..`
- Deploy only the function: `firebase deploy --only functions:processFile`

Hosting rewrite (optional)
- If you want your Next.js UI to call the Cloud Function at `/api/process-file` in production, add this to your existing `firebase.json` under `hosting.rewrites`:
  - `{ "source": "/api/process-file", "function": { "functionId": "processFile", "region": "us-central1" } }`
- Then `firebase deploy --only hosting,functions:processFile`

Local development with ADC (no keys)
- Remove `GOOGLE_APPLICATION_CREDENTIALS_JSON` from `.env.local` to avoid key usage.
- Authenticate ADC locally: `gcloud auth application-default login`
- Run the Next app: `cd vertex-file-processor && npm run dev` (uses local ADC)
- Or run the Functions emulator: `cd vertex-file-processor/functions && npm run serve`

Use a deployed API in dev
- In production (Firebase Hosting), the app expects `NEXT_PUBLIC_API_BASE_URL=/api/process-file` and a Hosting rewrite to the function.
- For local dev but using the deployed function (ADC parity), set in `.env.local`:
  - `NEXT_PUBLIC_API_BASE_URL=https://us-central1-<project>.cloudfunctions.net/processFile`
  - The UI will call that URL directly instead of the local `/api/process-file` route.

Notes on models
- Default model is `gemini-2.5-pro`. Override via `VERTEX_MODEL`.

Caching
- Not enabled by default. If you later want caching, we can add Firestore back to map source URLs to `gs://` URIs.

GCP + Firebase Setup (Step-by-step)
- Choose project: Use your Firebase project’s underlying Google Cloud project (Project ID likely `gemini-lens-w9we5`). Confirm in Firebase Console > Project settings > General.

- Enable required APIs (Cloud Console):
  - Vertex AI API
  - Cloud Storage API (aka “Cloud Storage JSON API”)
  - (Optional) Service Usage API is typically enabled by default.

- Create a service account:
  - IAM & Admin > Service Accounts > Create Service Account (e.g. `vertex-runner`)
  - Grant roles to this service account:
    - Vertex AI User (`roles/aiplatform.user`) — to call Gemini models
    - Storage Object Admin (`roles/storage.objectAdmin`) — to upload PDFs to your bucket
  - Finish without granting user access.

- Create a JSON key for the service account:
  - In the service account details > Keys > Add Key > Create new key (JSON)
  - Download the file. For local development, put the full JSON into `.env.local` under `GOOGLE_APPLICATION_CREDENTIALS_JSON` as a single line string.

- Configure Cloud Storage bucket:
  - If you’re using Firebase Storage, the default GCS bucket may be either `<project-id>.appspot.com` or `<project-id>.firebasestorage.app`.
  - Confirm the actual bucket id in Firebase Console > Storage > Settings (copy the “Default bucket”).
  - You can set that bucket as `GCS_BUCKET` if you want to override; otherwise the function auto-detects it from `FIREBASE_CONFIG`.
  - Ensure your service account has access to this bucket (Storage Object Creator, optionally Viewer if reading objects).

- Vertex AI location & model:
  - Set `VERTEX_LOCATION` to a supported region (e.g., `us-central1`).
  - Default model is `gemini-2.5-pro`; the code automatically falls back to `gemini-2.5-flash` then `gemini-2.0-flash-001` if a model isn’t available in your project/region.
  - You can override with `VERTEX_MODEL` to pin a specific model.
  - Input mode: set `VERTEX_INPUT=inline` to bypass Vertex’s GCS read requirement (handy while service agents are provisioning). Default is `gcs`.

- Testing locally:
  - `npm install`
  - `npm run dev`
  - Open http://localhost:3000
  - Use a publicly accessible PDF URL and a prompt; the server uploads it to GCS and calls Vertex AI.

Security Tips
- Keep the service account key private; never commit `.env.local` or JSON key files.
- Consider using Workload Identity Federation or Secret Manager in production instead of raw keys.
- Restrict the service account’s permissions to least privilege needed.
