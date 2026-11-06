export const LIMITS = {
  nodes: 64,
  edges: 128,
  executionBranches: 128,
  executionSteps: 512,
  pipelineModelCalls: 256,
  models: 32,
  delegatedWorkers: 32,
  delegatedRoleChars: 128,
  delegatedTaskChars: 2048,
  customBlocks: 64,
  customHeaders: 8,
  customHeaderValueChars: 1024,
  modelChoices: 1000,
  messages: 256,
  inputChars: 65_536,
  textChars: 131_072,
  templateChars: 32_768,
  stateChars: 262_144,
  requestBytes: 2_097_152,
  providerBytes: 2_097_152,
  minContextTokens: 256,
  contextTokens: 2_000_000,
  outputTokens: 32_768,
  providerTimeoutMs: 120_000,
  modelCostPerMillion: 1_000_000,
  tools: 16,
  toolNameChars: 64,
  toolDescriptionChars: 1024,
  toolSchemaChars: 8192,
  toolCallsPerReply: 16,
  toolCallIdChars: 128,
  toolArgumentChars: 65_536,
} as const;

export const DEFAULT_DELEGATED_WORKERS = 8;

const errors = {
  request: [400, "Invalid or oversized request."],
  graph: [400, "Pipeline graph is invalid."],
  fanout: [400, "Pipeline branching exceeded the per-run execution or model-call limit."],
  models: [400, "Model configuration is invalid."],
  custom: [400, "Custom block configuration is invalid."],
  context: [400, "Estimated input plus reserved output exceeds the model context window."],
  template: [400, "Template contains an unknown variable or malformed placeholder."],
  state: [400, "Pipeline text or variable state exceeds the size limit."],
  endpoint: [400, "Endpoint must use HTTPS or explicit HTTP loopback without embedded credentials or fragments; model endpoints cannot include a query."],
  address: [400, "Endpoint resolves to a blocked or unsafe address."],
  loopback: [403, "Loopback endpoints are disabled. Enable PIPELINE_ALLOW_LOOPBACK only on a trusted local server."],
  dns: [502, "Unable to resolve the model endpoint."],
  provider: [502, "Model request failed."],
  response: [502, "Model endpoint returned an invalid or oversized completion."],
  customProvider: [502, "Custom API request failed."],
  customResponse: [502, "Custom API returned an invalid or oversized response."],
  customDns: [502, "Unable to resolve the custom API endpoint."],
  customTimeout: [504, "Custom API request timed out."],
  math: [400, "Arithmetic action requires a finite number and a non-zero divisor."],
  delegation: [502, "The coordinator returned an invalid worker plan after one retry."],
  timeout: [504, "Model request timed out."],
  cancelled: [499, "Request cancelled."],
  origin: [403, "A same-origin POST request is required."],
  media: [415, "Content-Type must be application/json."],
} as const;

export class PipelineError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(readonly code: keyof typeof errors, detail?: string) {
    const safe = detail && /^(?:[a-z0-9.-]{1,253}|HTTP \d{3})$/i.test(detail) ? detail : undefined;
    super(safe ? `${errors[code][1].replace(/\.$/, "")} (${safe}).` : errors[code][1]);
    this.name = "PipelineError";
    this.status = errors[code][0];
    this.detail = safe;
  }
}

export function safeError(error: unknown): PipelineError {
  // Reconstruct from a closed set; never expose adapter errors or upstream bodies.
  if (error instanceof PipelineError && Object.prototype.hasOwnProperty.call(errors, error.code)) {
    return new PipelineError(error.code, error.detail);
  }
  return new PipelineError("provider");
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new PipelineError("cancelled");
}
