export const MAX_KEYFRAMES = 3;
export const MAX_KEYFRAME_BYTES = 1_000_000;
export const CONVERSATION_BODY_LIMIT = "5mb";

export type ConversationRole = "user" | "assistant";

export type ConversationMessage = {
  role: ConversationRole;
  text: string;
  createdAt: string;
};

export type ConversationTurnRequest = {
  text: string;
  keyframes: Array<{
    id: string;
    dataUrl: string;
    capturedAt: string;
    width?: number;
    height?: number;
  }>;
  session: {
    sessionId: string;
    messages: ConversationMessage[];
    stats?: {
      requestCount: number;
      keyframeCount: number;
      estimatedUsd: number;
    };
  };
};

export type CostStats = {
  request: {
    inputTextChars: number;
    keyframeCount: number;
    imageBytes: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedUsd: number;
    cloudCallAttempted: boolean;
  };
  session: {
    requestCount: number;
    keyframeCount: number;
    estimatedUsd: number;
  };
};

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ConversationTurnSuccessResponse = {
  ok: true;
  reply: { role: "assistant"; text: string };
  session: { sessionId: string; turnId: string };
  cost: CostStats;
  model: { provider: "openai-compatible"; name: string; usage?: ModelUsage };
  timing: { totalMs: number; modelMs: number | null };
};

export type ConversationTurnErrorCode =
  | "EMPTY_TEXT"
  | "NO_KEYFRAMES"
  | "TOO_MANY_KEYFRAMES"
  | "IMAGE_TOO_LARGE"
  | "INVALID_KEYFRAME"
  | "INVALID_SESSION_CONTEXT"
  | "MALFORMED_JSON"
  | "RATE_LIMITED"
  | "SESSION_TURN_LIMIT_EXCEEDED"
  | "COST_CONFIG_INVALID"
  | "MODEL_CONFIG_INVALID"
  | "MODEL_CONFIG_MISSING"
  | "MODEL_PROVIDER_ERROR"
  | "MODEL_PROVIDER_TIMEOUT";

export type ConversationTurnErrorResponse = {
  ok: false;
  error: {
    code: ConversationTurnErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  cost: CostStats;
  timing: { totalMs: number };
};
