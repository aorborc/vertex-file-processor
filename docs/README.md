Vertex File Processor — Full Documentation

Overview
- Purpose: Extract structured invoice data from PDFs using Google Vertex AI (Gemini), with file handling via Google Cloud Storage (GCS) and caching in Firestore to minimize cost and latency.
- Components:
  - Next.js UI (App Router)
  - Cloud Functions (Gen 2): processFile, signedUrl
  - Google Cloud Storage (private by default)
  - Vertex AI generative models
  - Firestore caches: urlCache, processCache, signedUrlCache

High-level Flow
- UI POSTs PDF URL + prompt to processFile
- If http/https URL:
  - Download, upload to GCS, cache URL→GCS mapping (urlCache)
- If gs:// URL: use directly
- processFile computes cache key hash(gsUri|model|prompt)
  - Cache hit: return cached response
  - Cache miss: call Vertex AI, postprocess JSON, cache response (processCache)
- UI displays response, allows Preview
- Preview requests signed URL from signedUrl function (TTL up to 7 days), which uses signedUrlCache to reuse URLs when possible

Environments & Endpoints
- Hosting rewrites: /api/process-file → processFile, /api/signed-url → signedUrl
- Local UI can be configured to call deployed functions via .env.local:
  - NEXT_PUBLIC_API_BASE_URL=https://us-central1-<project>.cloudfunctions.net/processFile
  - NEXT_PUBLIC_SIGNED_URL_API_BASE=https://us-central1-<project>.cloudfunctions.net/signedUrl

Credentials & Auth (ADC)
- Production: Functions run with an attached runtime service account (ADC). No JSON keys.
- Local UI: Call deployed functions to keep ADC parity.
- If you must run local server routes, provide GOOGLE_APPLICATION_CREDENTIALS_JSON only for local dev (never commit).

Service Accounts & IAM
- Runtime SA (e.g., vertex-runner@<project>.iam.gserviceaccount.com)
  - Vertex AI User: roles/aiplatform.user
  - Storage Object Creator: roles/storage.objectCreator (write)
  - Storage Object Viewer: roles/storage.objectViewer (read if needed)
  - Service Account Token Creator: roles/iam.serviceAccountTokenCreator (required for v4 signed URLs)
  - Firestore access: roles/datastore.user is sufficient (we use server SDK)
- Vertex Service Agent (service-<PROJECT_NUMBER>@gcp-sa-aiplatform.iam.gserviceaccount.com)
  - Storage Object Viewer on the bucket for fileUri mode

Firestore Databases & Regions
- Named DB support: FIRESTORE_DATABASE_ID can target a named database (e.g., sw-vertex-processor)
- Fallback: If named DB isn’t found, functions fall back to the default DB and log a NOT_FOUND fallback message
- Region: Prefer the same location for Firestore and Functions (e.g., us-central1)

Caching Semantics
- urlCache (key: sha256(source URL))
  - Maps http/https → gsUri to avoid repeated downloads
  - Fields: { sourceUrl, gsUri, contentType, size, createdAt, updatedAt }
- processCache (key: sha256(`${gsUri}|${model}|${prompt}`))
  - Stores full Vertex response plus normalized JSON with per-field confidences
  - reset=true bypasses cache and overwrites it
  - Response includes cachedProcess: true and cachedAt (ISO)
- signedUrlCache (key: sha256(gsUri))
  - Stores v4 signed URL + expires epoch (ms) and is reused if >60s remains
  - TTL cap: 7 days (GCS v4 maximum)

Models
- Default model: gemini-2.5-pro
- Fallback chain: 2.5-flash → 2.0-flash-001 → 1.5 variants (if not available/allowed)
- Region: us-central1 by default

Prompting
- Default prompt instructs:
  - Capture billing_details and shipping_address blocks
  - Line item quantities: indent_qty, dispatch_qty, received_qty (text or number), quantity derived from received_qty if present else dispatch
  - Return JSON only; include per-field confidences 0–1

UI Usage (Home)
- Fill PDF URL (supports gs:// and https)
- Adjust prompt if needed
- Click Send to Vertex
  - Live timer shows seconds while request runs
  - Response section opens when complete
  - Cache: HIT badge appears on subsequent identical requests
- Click Open Preview to review PDF + extracted data
  - Endpoint banner shows which functions you are calling

UI Usage (Preview)
- Left: embedded PDF via signed preview URL (auto-refreshes; valid up to 7 days)
- Right: Review & Edit
  - Top-level fields with trailing % confidence
  - Numeric currency fields show a leading ₹ symbol
  - Line items table: Description | Indent | Dispatch | Received | Qty | Unit Price | Amount | Del
    - Each field shows trailing % confidence
    - Inputs are text with inputMode=decimal and min widths; long values scroll horizontally
    - Subtotal and Total recompute automatically
  - Accept & Copy JSON copies the current JSON to clipboard

Back-end Behavior (processFile)
- Input: { fileUrl: string (gs:// or https), prompt: string, reset?: boolean }
- Output: { success, gcsUri, extracted, extractedRaw, vertex, cachedProcess?, cachedAt? }
- Internal steps:
  1) If https, check urlCache, else download and upload to GCS, then save urlCache
  2) Compute cache key; if not reset, return processCache if found
  3) Call Vertex AI using fileData (fileUri) or inlineData fallback
  4) Parse model output to JSON; propagate field-level confidences
  5) Save processCache and return response

Back-end Behavior (signedUrl)
- Input: ?gsUri=gs://...&ttlSec=604800 (max 7 days)
- Output: { url, expires }
- Reads signedUrlCache; if valid for >60s, returns cached; else signs anew and caches

Security & Privacy
- GCS is private by default. We use v4 signed URLs for limited-time preview access.
- Do not commit service account JSON. Prefer ADC with IAM.
- Use least-privilege roles and separate service accounts per app if possible.

Deployment
- Prereqs: Node 20, Firebase CLI
- Functions deploy:
  - firebase deploy --only functions:processFile,functions:signedUrl
- Hosting deploy:
  - firebase deploy --only hosting
- Web frameworks (Next.js SSR): ensure the frameworks experiment or newer CLI supports your setup

Troubleshooting
- Firestore NOT_FOUND on named DB:
  - Indicates the named database doesn’t exist or isn’t reachable. Functions will fall back to default and log a fallback message.
- Vertex service agent provisioning:
  - First-time GCS fileUri reads can fail until service agent is created; grant Storage Object Viewer to service-<PROJECT_NUMBER>@gcp-sa-aiplatform.iam.gserviceaccount.com
- Signed URL errors (signBlob):
  - Ensure runtime SA has roles/iam.serviceAccountTokenCreator
- GCS bucket not found:
  - Verify bucket (e.g., <project>.firebasestorage.app) and region; confirm Firebase Storage is enabled
- Logs:
  - Firebase Console → Functions → View logs
  - Cloud Console → Logging → Logs Explorer (service_name="processFile"|"signedUrl")

API Reference
- POST /api/process-file
  - Body: { fileUrl: "gs://..." | "https://...", prompt: string, reset?: boolean }
  - Response: { success, gcsUri, extracted, extractedRaw, vertex, cachedProcess?, cachedAt? }
- GET /api/signed-url?gsUri=gs://...&ttlSec=...
  - Response: { url, expires }
- GET /api/verify-auth
  - Response: server auth + config (unlinked in UI)

Cost Controls
- Firestore caching (process + signed URLs) reduces Vertex and signing calls
- Reuse gsUri to avoid repeated downloads
- Use reset=true only when necessary

Roadmap
- Persist accepted JSON to Firestore for auditing and downstream use
- Compare extracted data to Zoho Creator/Books bills
- Admin dashboard for cache hits/misses and latency

