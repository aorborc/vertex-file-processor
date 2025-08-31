import { detectAuthMode, getProjectId } from "@/lib/google";

export const runtime = 'nodejs';

export async function GET() {
  const authMode = detectAuthMode();
  const projectId = await getProjectId();
  const location = process.env.VERTEX_LOCATION || "us-central1";
  const model = process.env.VERTEX_MODEL || "gemini-1.5-pro-002";
  const bucket = process.env.GCS_BUCKET || null;
  const hasCredentialsJson = !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  return new Response(
    JSON.stringify({ authMode, projectId, location, model, bucket, hasCredentialsJson }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

