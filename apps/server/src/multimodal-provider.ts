import type {
  ConversationMessage,
  ConversationTurnErrorCode,
  ConversationTurnRequest,
  ModelUsage
} from "./conversation-contract";
import type { ResolvedModelConfig } from "./model-config";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type ProviderName = "openai-compatible";

type ProviderErrorCode = Extract<
  ConversationTurnErrorCode,
  "MODEL_PROVIDER_ERROR" | "MODEL_PROVIDER_TIMEOUT"
>;

type ProviderKeyframe = ConversationTurnRequest["keyframes"][number] & {
  byteLength?: number;
};

export type MultimodalProviderRequest = {
  config: ResolvedModelConfig;
  keyframes: ProviderKeyframe[];
  messages: ConversationMessage[];
  text: string;
};

export type MultimodalProviderResult = {
  modelMs: number;
  modelName: string;
  provider: ProviderName;
  text: string;
  usage?: ModelUsage;
};

export type MultimodalProviderDeltaHandler = (delta: string) => void;

export type MultimodalProvider = {
  complete(
    request: MultimodalProviderRequest
  ): Promise<MultimodalProviderResult>;
  completeStream(
    request: MultimodalProviderRequest,
    onDelta: MultimodalProviderDeltaHandler
  ): Promise<MultimodalProviderResult>;
};

export class MultimodalProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly status: number;

  constructor(input: {
    code: ProviderErrorCode;
    details?: Record<string, unknown>;
    message: string;
    retryable: boolean;
    status: number;
  }) {
    super(input.message);
    this.name = "MultimodalProviderError";
    this.code = input.code;
    this.details = input.details;
    this.retryable = input.retryable;
    this.status = input.status;
  }
}

type OpenAiCompatibleProviderOptions = {
  fetch?: FetchLike;
};

type OpenAiMessage = {
  content:
    | string
    | Array<
        | {
            text: string;
            type: "text";
          }
        | {
            image_url: {
              url: string;
            };
            type: "image_url";
          }
      >;
  role: "assistant" | "user";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown) {
  return isRecord(error) && error.name === "AbortError";
}

function buildChatCompletionsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function buildMessages(request: MultimodalProviderRequest): OpenAiMessage[] {
  const historyMessages = request.messages.map((message) => ({
    content: message.text,
    role: message.role
  }));
  const currentUserMessage: OpenAiMessage = {
    content: [
      {
        text: request.text,
        type: "text"
      },
      ...request.keyframes.map((keyframe) => ({
        image_url: {
          url: keyframe.dataUrl
        },
        type: "image_url" as const
      }))
    ],
    role: "user"
  };

  return [...historyMessages, currentUserMessage];
}

function buildPayload(request: MultimodalProviderRequest, stream: boolean) {
  return {
    max_tokens: request.config.maxOutputTokens,
    messages: buildMessages(request),
    model: request.config.modelName,
    stream,
    ...(stream
      ? {
          stream_options: {
            include_usage: true
          }
        }
      : {})
  };
}

function extractTextFromContent(content: unknown) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!isRecord(part) || part.type !== "text") {
        return "";
      }

      return typeof part.text === "string" ? part.text : "";
    })
    .join("")
    .trim();
}

function extractAssistantText(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    return "";
  }

  const firstChoice = body.choices[0];

  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    return "";
  }

  return extractTextFromContent(firstChoice.message.content);
}

function extractUsage(body: unknown): MultimodalProviderResult["usage"] {
  if (!isRecord(body) || !isRecord(body.usage)) {
    return undefined;
  }

  const usage = body.usage;
  const inputTokens =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const outputTokens =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : undefined;
  const totalTokens =
    typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function extractDeltaText(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    return "";
  }

  const firstChoice = body.choices[0];

  if (!isRecord(firstChoice) || !isRecord(firstChoice.delta)) {
    return "";
  }

  return typeof firstChoice.delta.content === "string"
    ? firstChoice.delta.content
    : "";
}

function truncateProviderMessage(message: string) {
  const normalized = message.trim();

  if (normalized.length <= 500) {
    return normalized;
  }

  return `${normalized.slice(0, 500)}...`;
}

async function readProviderErrorMessage(response: Response) {
  try {
    return truncateProviderMessage(await response.text());
  } catch {
    return "";
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "unknown provider error";
}

function createProviderHeaders(request: MultimodalProviderRequest) {
  return {
    Authorization: `Bearer ${request.config.apiKey}`,
    "Content-Type": "application/json"
  };
}

async function fetchChatCompletions(
  fetchImpl: FetchLike,
  request: MultimodalProviderRequest,
  stream: boolean,
  signal: AbortSignal
) {
  return fetchImpl(buildChatCompletionsUrl(request.config.baseUrl), {
    body: JSON.stringify(buildPayload(request, stream)),
    headers: createProviderHeaders(request),
    method: "POST",
    signal
  });
}

async function assertProviderOk(response: Response) {
  if (response.ok) {
    return;
  }

  throw new MultimodalProviderError({
    code: "MODEL_PROVIDER_ERROR",
    details: {
      providerMessage: await readProviderErrorMessage(response),
      providerStatus: response.status
    },
    message: "模型 provider 返回错误。",
    retryable: response.status === 429 || response.status >= 500,
    status: 502
  });
}

function parseSseDataLines(block: string) {
  return block
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
}

function parseStreamJson(data: string) {
  try {
    return JSON.parse(data) as unknown;
  } catch (error) {
    throw new MultimodalProviderError({
      code: "MODEL_PROVIDER_ERROR",
      details: {
        reason: getErrorMessage(error)
      },
      message: "模型 provider 返回了无法解析的流式响应。",
      retryable: true,
      status: 502
    });
  }
}

async function readOpenAiCompatibleStream(
  response: Response,
  onDelta: MultimodalProviderDeltaHandler
) {
  if (!response.body) {
    throw new MultimodalProviderError({
      code: "MODEL_PROVIDER_ERROR",
      message: "模型 provider 未返回可读取的流式响应。",
      retryable: true,
      status: 502
    });
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let text = "";
  let usage: ModelUsage | undefined;
  let done = false;

  function consumeBlock(block: string) {
    const data = parseSseDataLines(block);

    if (!data) {
      return;
    }

    if (data === "[DONE]") {
      done = true;
      return;
    }

    const body = parseStreamJson(data);
    const delta = extractDeltaText(body);
    const nextUsage = extractUsage(body);

    if (nextUsage) {
      usage = nextUsage;
    }

    if (delta.length > 0) {
      text += delta;
      onDelta(delta);
    }
  }

  while (!done) {
    const { done: readerDone, value } = await reader.read();

    if (readerDone) {
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
      consumeBlock(block);
    }
  }

  buffer += decoder.decode();

  if (buffer.trim().length > 0) {
    consumeBlock(buffer);
  }

  return {
    text: text.trim(),
    usage
  };
}

export function createOpenAiCompatibleMultimodalProvider(
  options: OpenAiCompatibleProviderOptions = {}
): MultimodalProvider {
  const fetchImpl =
    options.fetch ?? ((url, init) => fetch(url, init) as Promise<Response>);

  return {
    async complete(request) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, request.config.timeoutMs);

      try {
        const response = await fetchChatCompletions(
          fetchImpl,
          request,
          false,
          controller.signal
        );

        await assertProviderOk(response);

        const body = await response.json();
        const text = extractAssistantText(body);

        if (text.length === 0) {
          throw new MultimodalProviderError({
            code: "MODEL_PROVIDER_ERROR",
            message: "模型 provider 返回了空回复。",
            retryable: true,
            status: 502
          });
        }

        return {
          modelMs: Date.now() - startedAt,
          modelName: request.config.modelName,
          provider: "openai-compatible",
          text,
          usage: extractUsage(body)
        };
      } catch (error) {
        if (error instanceof MultimodalProviderError) {
          throw error;
        }

        if (controller.signal.aborted || isAbortError(error)) {
          throw new MultimodalProviderError({
            code: "MODEL_PROVIDER_TIMEOUT",
            details: {
              timeoutMs: request.config.timeoutMs
            },
            message: "模型 provider 调用超时。",
            retryable: true,
            status: 504
          });
        }

        throw new MultimodalProviderError({
          code: "MODEL_PROVIDER_ERROR",
          details: {
            reason: getErrorMessage(error)
          },
          message: "模型 provider 调用失败。",
          retryable: true,
          status: 502
        });
      } finally {
        clearTimeout(timeout);
      }
    },

    async completeStream(request, onDelta) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, request.config.timeoutMs);

      try {
        const response = await fetchChatCompletions(
          fetchImpl,
          request,
          true,
          controller.signal
        );

        await assertProviderOk(response);

        const completion = await readOpenAiCompatibleStream(response, onDelta);

        if (completion.text.length === 0) {
          throw new MultimodalProviderError({
            code: "MODEL_PROVIDER_ERROR",
            message: "模型 provider 返回了空回复。",
            retryable: true,
            status: 502
          });
        }

        return {
          modelMs: Date.now() - startedAt,
          modelName: request.config.modelName,
          provider: "openai-compatible",
          text: completion.text,
          usage: completion.usage
        };
      } catch (error) {
        if (error instanceof MultimodalProviderError) {
          throw error;
        }

        if (controller.signal.aborted || isAbortError(error)) {
          throw new MultimodalProviderError({
            code: "MODEL_PROVIDER_TIMEOUT",
            details: {
              timeoutMs: request.config.timeoutMs
            },
            message: "模型 provider 调用超时。",
            retryable: true,
            status: 504
          });
        }

        throw new MultimodalProviderError({
          code: "MODEL_PROVIDER_ERROR",
          details: {
            reason: getErrorMessage(error)
          },
          message: "模型 provider 调用失败。",
          retryable: true,
          status: 502
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}
