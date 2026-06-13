export type ConversationMessage = {
  createdAt: string;
  role: "user" | "assistant";
  text: string;
};

export type ConversationSessionStats = {
  estimatedUsd: number;
  keyframeCount: number;
  requestCount: number;
};

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ConversationTurnStatusPhase =
  | "validating"
  | "estimating-cost"
  | "checking-model"
  | "calling-model"
  | "streaming-reply"
  | "completed";

export type ConversationTurnRequest = {
  keyframes: Array<{
    capturedAt: string;
    dataUrl: string;
    height: number;
    id: string;
    width: number;
  }>;
  session: {
    messages: ConversationMessage[];
    sessionId: string;
    stats: ConversationSessionStats;
  };
  text: string;
};

type ConfiguredModelConfigStatus<TSource extends "runtime" | "env"> = {
  ok: true;
  source: TSource;
  asrModelName?: string;
  baseUrl: string;
  hasApiKey: true;
  maxOutputTokens: number;
  modelName: string;
  timeoutMs: number;
};

type RuntimeModelConfigStatus = ConfiguredModelConfigStatus<"runtime">;
type EnvModelConfigStatus = ConfiguredModelConfigStatus<"env">;

export type ModelConfigStatus =
  | RuntimeModelConfigStatus
  | EnvModelConfigStatus
  | {
      ok: true;
      source: "missing";
      hasApiKey: boolean;
      missing: string[];
    }
  | {
      ok: true;
      source: "invalid";
      hasApiKey: boolean;
      invalid: Array<{ name: string; value: string }>;
    };

export type RuntimeModelConfigInput = {
  apiKey: string;
  asrModelName?: string;
  baseUrl: string;
  maxOutputTokens: number;
  modelName: string;
  timeoutMs: number;
};

type ModelConfigErrorResponse = {
  error: {
    code: string;
    message: string;
  };
  ok: false;
};

function isModelConfigErrorResponse(
  value: ModelConfigStatus | ModelConfigErrorResponse
): value is ModelConfigErrorResponse {
  return value.ok === false;
}

export type ConversationTurnResponse =
  | {
      ok: true;
      reply: { role: "assistant"; text: string };
      cost: {
        request?: {
          cloudCallAttempted: boolean;
        };
        session: ConversationSessionStats;
      };
      model?: {
        name: string;
        provider: "openai-compatible";
        usage?: ModelUsage;
      };
      timing: { totalMs: number };
    }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
      cost: {
        request?: {
          cloudCallAttempted: boolean;
        };
        session: ConversationSessionStats;
      };
      timing: { totalMs: number };
    };

export type SpeechTranscriptionResponse =
  | {
      ok: true;
      text: string;
      model?: {
        name: string;
        provider: "openai-compatible";
      };
      timing?: { totalMs: number; modelMs?: number | null };
    }
  | {
      ok: false;
      error: {
        code: string;
        details?: Record<string, unknown>;
        message: string;
        retryable: boolean;
      };
      timing: { totalMs: number };
    };

type FetchFn = typeof fetch;
type SpeechTranscriptionMetadata = {
  sessionId?: string | null;
};

type StreamHandlers = {
  onComplete?: (response: Extract<ConversationTurnResponse, { ok: true }>) => void;
  onDelta?: (text: string) => void;
  onError?: (response: Extract<ConversationTurnResponse, { ok: false }>) => void;
  onStatus?: (phase: ConversationTurnStatusPhase) => void;
};

type ParsedSseEvent = {
  data: unknown;
  event: string;
};

export async function postConversationTurn(
  body: ConversationTurnRequest,
  fetchFn: FetchFn = fetch
) {
  const response = await fetchFn("/api/conversation-turn", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  return (await response.json()) as ConversationTurnResponse;
}

export async function getModelConfig(fetchFn: FetchFn = fetch) {
  const response = await fetchFn("/api/model-config", {
    method: "GET"
  });

  if (!response.ok) {
    throw new Error("无法读取模型配置。");
  }

  return (await response.json()) as ModelConfigStatus;
}

export async function putModelConfig(
  body: RuntimeModelConfigInput,
  fetchFn: FetchFn = fetch
): Promise<RuntimeModelConfigStatus> {
  const response = await fetchFn("/api/model-config", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json"
    },
    method: "PUT"
  });
  const responseBody = (await response.json()) as
    | ModelConfigStatus
    | ModelConfigErrorResponse;

  if (isModelConfigErrorResponse(responseBody)) {
    throw new Error(
      `${responseBody.error.code}：${responseBody.error.message}`
    );
  }

  if (!response.ok) {
    throw new Error("无法保存模型配置。");
  }

  return responseBody as RuntimeModelConfigStatus;
}

export async function postSpeechTranscription(
  audio: Blob,
  metadata: SpeechTranscriptionMetadata = {},
  fetchFn: FetchFn = fetch
) {
  const formData = new FormData();

  formData.append("audio", audio, "voice.webm");

  if (metadata.sessionId) {
    formData.append("sessionId", metadata.sessionId);
  }

  const response = await fetchFn("/api/speech-transcription", {
    body: formData,
    method: "POST"
  });

  return (await response.json()) as SpeechTranscriptionResponse;
}

function parseSseBlock(block: string): ParsedSseEvent {
  let event = "message";
  let data = "";

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event: ")) {
      event = line.slice("event: ".length);
      continue;
    }

    if (line.startsWith("data: ")) {
      data += line.slice("data: ".length);
    }
  }

  try {
    return {
      data: JSON.parse(data) as unknown,
      event
    };
  } catch {
    throw new Error("流式对话响应格式不正确。");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatusPhase(value: unknown): value is ConversationTurnStatusPhase {
  return (
    value === "validating" ||
    value === "estimating-cost" ||
    value === "checking-model" ||
    value === "calling-model" ||
    value === "streaming-reply" ||
    value === "completed"
  );
}

function readStatusEvent(data: unknown) {
  if (!isRecord(data) || !isStatusPhase(data.phase)) {
    throw new Error("流式对话响应格式不正确。");
  }

  return data.phase;
}

function readDeltaEvent(data: unknown) {
  if (!isRecord(data) || typeof data.text !== "string") {
    throw new Error("流式对话响应格式不正确。");
  }

  return data.text;
}

function readErrorEvent(data: unknown) {
  if (!isRecord(data) || !isRecord(data.response)) {
    throw new Error("流式对话响应格式不正确。");
  }

  return data.response as Extract<ConversationTurnResponse, { ok: false }>;
}

function readCompleteEvent(data: unknown) {
  if (!isRecord(data) || data.ok !== true) {
    throw new Error("流式对话响应格式不正确。");
  }

  return data as Extract<ConversationTurnResponse, { ok: true }>;
}

export async function streamConversationTurn(
  body: ConversationTurnRequest,
  handlers: StreamHandlers = {},
  fetchFn: FetchFn = fetch
): Promise<ConversationTurnResponse> {
  const response = await fetchFn("/api/conversation-turn/stream", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok || !response.body) {
    throw new Error("无法连接流式对话接口。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalResponse: ConversationTurnResponse | null = null;

  function consumeEvent(event: ParsedSseEvent) {
    if (event.event === "status") {
      handlers.onStatus?.(readStatusEvent(event.data));
      return;
    }

    if (event.event === "delta") {
      handlers.onDelta?.(readDeltaEvent(event.data));
      return;
    }

    if (event.event === "complete") {
      const complete = readCompleteEvent(event.data);
      terminalResponse = complete;
      handlers.onComplete?.(complete);
      return;
    }

    if (event.event === "error") {
      const error = readErrorEvent(event.data);
      terminalResponse = error;
      handlers.onError?.(error);
    }
  }

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    for (;;) {
      const separatorIndex = buffer.indexOf("\n\n");

      if (separatorIndex === -1) {
        break;
      }

      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      consumeEvent(parseSseBlock(block));
    }
  }

  buffer += decoder.decode();

  if (buffer.trim().length > 0) {
    consumeEvent(parseSseBlock(buffer));
  }

  if (!terminalResponse) {
    throw new Error("流式对话响应提前结束。");
  }

  return terminalResponse;
}
