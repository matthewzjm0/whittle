import { handlePipelineRequest } from "../../../lib/pipeline/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handlePipelineRequest(request);
}
