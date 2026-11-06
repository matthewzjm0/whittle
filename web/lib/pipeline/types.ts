export interface StudioModel {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  contextWindow: number;
  apiKey?: string;
  outputTokenField?: "max_tokens" | "max_completion_tokens";
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}

export type DelegationAuto = "cheap" | "value" | "performance";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelConnection {
  baseUrl: string;
  apiKey?: string;
}

export interface ModelChoice {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text exactly as the model produced it; parse and validate before use. */
  arguments: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's arguments. */
  parameters: object;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Only on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** Only on tool messages: the id of the call being answered. */
  toolCallId?: string;
}

export interface PipelineNode {
  id: string;
  type: "start" | "model" | "delegated" | "custom" | "condition" | "variable" | "output";
  x: number;
  y: number;
  label: string;
  modelId?: string;
  effort?: ReasoningEffort;
  workerModelIds?: string[];
  leaderAuto?: DelegationAuto;
  leaderPool?: string[];
  workerAuto?: DelegationAuto;
  workerPool?: string[];
  validatorModelId?: string;
  maxWorkers?: number;
  customBlockId?: string;
  prompt?: string;
  condition?: "contains" | "not-contains" | "equals";
  value?: string;
  variable?: string;
}

export interface PipelineEdge {
  id: string;
  from: string;
  to: string;
  port: "out" | "pass" | "fail";
}

export interface PipelineGraph {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cost?: number;
}

export type CustomAction =
  | { kind: "model"; modelId: string; prompt: string }
  | { kind: "template"; template: string }
  | { kind: "math"; operation: "add" | "subtract" | "multiply" | "divide"; operand: number }
  | {
      kind: "http";
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      url: string;
      bodyTemplate?: string;
      responsePath?: string;
      authHeader?: string;
      authPrefix?: string;
      headers?: Record<string, string>;
    }
  | { kind: "cost" };

export interface CustomBlockDefinition {
  id: string;
  name: string;
  action: CustomAction;
  apiKey?: string;
}

export interface CustomHttpRequest {
  definition: CustomBlockDefinition;
  input: string;
  value: string;
  variables: ReadonlyMap<string, string>;
  signal: AbortSignal;
}

export type CustomHttp = (request: CustomHttpRequest) => Promise<string>;

export interface PipelineEvent {
  type: "node-start" | "node-complete" | "complete" | "error";
  nodeId?: string;
  branchId?: string;
  output?: string;
  error?: string;
  usage?: TokenUsage;
}

export interface CompletionResult {
  text: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
}

export type Complete = (
  model: StudioModel,
  messages: Message[],
  maxOutputTokens: number,
  signal: AbortSignal,
  effort?: ReasoningEffort,
  tools?: ToolSpec[],
) => Promise<CompletionResult>;

export type PipelineRequest =
  | { mode: "models"; connection: ModelConnection }
  | { mode: "chat"; model: StudioModel; messages: Message[]; maxOutputTokens: number }
  | {
      mode: "pipeline";
      graph: PipelineGraph;
      models: StudioModel[];
      input: string;
      maxOutputTokens: number;
      customBlocks?: CustomBlockDefinition[];
    };
