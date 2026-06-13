import type { Request, Response as ExpressResponse } from "express";

import type {
  SpeechTranscriptionErrorCode,
  SpeechTranscriptionErrorResponse,
  SpeechTranscriptionSuccessResponse
} from "./conversation-contract";
import {
  createModelConfigService,
  type ModelConfigService,
  type ResolvedModelConfig
} from "./model-config";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type ProviderName = "openai-compatible";

type ProviderErrorCode = Extract<
  SpeechTranscriptionErrorCode,
  "MODEL_PROVIDER_ERROR" | "MODEL_PROVIDER_TIMEOUT"
>;

export type SpeechTranscriptionAudio = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
};

export type SpeechTranscriptionProviderRequest = {
  audio: SpeechTranscriptionAudio;
  config: ResolvedModelConfig;
};

export type SpeechTranscriptionProviderResult = {
  modelMs: number;
  modelName: string;
  provider: ProviderName;
  text: string;
};

export type SpeechTranscriptionProvider = {
  transcribe(
    request: SpeechTranscriptionProviderRequest
  ): Promise<SpeechTranscriptionProviderResult>;
};

export class SpeechTranscriptionProviderError extends Error {
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
    this.name = "SpeechTranscriptionProviderError";
    this.code = input.code;
    this.details = input.details;
    this.retryable = input.retryable;
    this.status = input.status;
  }
}

type MultipartPart = {
  content: Buffer;
  contentType: string;
  filename?: string;
  name: string;
};

type OpenAiCompatibleSpeechTranscriptionProviderOptions = {
  fetch?: FetchLike;
};

function elapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

function buildAudioTranscriptionsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown) {
  return isRecord(error) && error.name === "AbortError";
}

function isProviderError(error: unknown): error is {
  code: ProviderErrorCode;
  details?: Record<string, unknown>;
  message: string;
  retryable: boolean;
  status: number;
} {
  return (
    isRecord(error) &&
    (error.code === "MODEL_PROVIDER_ERROR" ||
      error.code === "MODEL_PROVIDER_TIMEOUT") &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean" &&
    typeof error.status === "number"
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactProviderMessage(message: string, secrets: string[] = []) {
  let redacted = message.trim();

  for (const secret of secrets) {
    const normalizedSecret = secret.trim();

    if (normalizedSecret.length >= 4) {
      redacted = redacted.replace(
        new RegExp(escapeRegExp(normalizedSecret), "g"),
        "[redacted]"
      );
    }
  }

  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[redacted]");
}

function truncateProviderMessage(message: string, secrets: string[] = []) {
  const normalized = redactProviderMessage(message, secrets);

  if (normalized.length <= 500) {
    return normalized;
  }

  return `${normalized.slice(0, 500)}...`;
}

async function readProviderErrorMessage(response: Response, secrets: string[] = []) {
  try {
    return truncateProviderMessage(await response.text(), secrets);
  } catch {
    return "";
  }
}

function getProviderStatusDiagnostic(status: number) {
  if (status === 401 || status === 403) {
    return {
      message: "API Key 或模型权限无效。",
      retryable: false
    };
  }

  if (status === 400 || status === 404) {
    return {
      message: "ASR 模型名、接口路径或请求格式不兼容。",
      retryable: false
    };
  }

  if (status === 429) {
    return {
      message: "ASR 服务额度不足或触发限流。",
      retryable: true
    };
  }

  if (status >= 500) {
    return {
      message: "ASR provider 服务异常。",
      retryable: true
    };
  }

  return {
    message: "语音识别 provider 调用失败。",
    retryable: false
  };
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "unknown provider error";
}

function extractTranscriptionText(body: unknown) {
  if (!isRecord(body) || typeof body.text !== "string") {
    return "";
  }

  return body.text.trim();
}

async function fetchAudioTranscription(
  fetchImpl: FetchLike,
  request: SpeechTranscriptionProviderRequest
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, request.config.timeoutMs);
  const formData = new FormData();
  const audioBlob = new Blob([request.audio.buffer], {
    type: request.audio.mimeType
  });

  formData.append("file", audioBlob, request.audio.filename);
  formData.append("model", request.config.asrModelName ?? "");

  const startedAt = Date.now();

  try {
    const response = await fetchImpl(
      buildAudioTranscriptionsUrl(request.config.baseUrl),
      {
        body: formData,
        headers: {
          Authorization: `Bearer ${request.config.apiKey}`
        },
        method: "POST",
        signal: controller.signal
      }
    );

    if (!response.ok) {
      const diagnostic = getProviderStatusDiagnostic(response.status);

      throw new SpeechTranscriptionProviderError({
        code: "MODEL_PROVIDER_ERROR",
        details: {
          providerStatus: response.status,
          providerText: await readProviderErrorMessage(response, [
            request.config.apiKey
          ])
        },
        message: diagnostic.message,
        retryable: diagnostic.retryable,
        status: 502
      });
    }

    const text = extractTranscriptionText(await response.json());

    return {
      modelMs: elapsedMs(startedAt),
      modelName: request.config.asrModelName ?? "",
      provider: "openai-compatible" as const,
      text
    };
  } catch (error) {
    if (error instanceof SpeechTranscriptionProviderError) {
      throw error;
    }

    if (isAbortError(error)) {
      throw new SpeechTranscriptionProviderError({
        code: "MODEL_PROVIDER_TIMEOUT",
        message: "语音识别 provider 调用超时。",
        retryable: true,
        status: 504
      });
    }

    throw new SpeechTranscriptionProviderError({
      code: "MODEL_PROVIDER_ERROR",
      details: {
        providerMessage: getErrorMessage(error)
      },
      message: "语音识别 provider 调用失败。",
      retryable: true,
      status: 502
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function createOpenAiCompatibleSpeechTranscriptionProvider(
  options: OpenAiCompatibleSpeechTranscriptionProviderOptions = {}
): SpeechTranscriptionProvider {
  const fetchImpl = options.fetch ?? fetch;

  return {
    transcribe(request) {
      return fetchAudioTranscription(fetchImpl, request);
    }
  };
}

function createErrorBody(
  startedAt: number,
  code: SpeechTranscriptionErrorCode,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>
): SpeechTranscriptionErrorResponse {
  return {
    error: {
      code,
      details,
      message,
      retryable
    },
    ok: false,
    timing: {
      totalMs: elapsedMs(startedAt)
    }
  };
}

function sendError(
  response: ExpressResponse,
  status: number,
  startedAt: number,
  code: SpeechTranscriptionErrorCode,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>
) {
  response
    .status(status)
    .json(createErrorBody(startedAt, code, message, retryable, details));
}

function getHeader(request: Request, name: string) {
  const value = request.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return value ?? "";
}

function getMultipartBoundary(contentType: string) {
  const match = /boundary=([^;]+)/i.exec(contentType);

  return match?.[1]?.replace(/^"|"$/g, "") ?? "";
}

async function readRawBody(request: Request) {
  if (Buffer.isBuffer(request.body)) {
    return request.body;
  }

  if (typeof request.body === "string") {
    return Buffer.from(request.body);
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function trimPartContent(content: Buffer) {
  if (
    content.length >= 2 &&
    content[content.length - 2] === 13 &&
    content[content.length - 1] === 10
  ) {
    return content.subarray(0, content.length - 2);
  }

  return content;
}

function parseContentDisposition(value: string) {
  const name = /(?:^|;\s*)name="([^"]+)"/i.exec(value)?.[1] ?? "";
  const filename = /(?:^|;\s*)filename="([^"]*)"/i.exec(value)?.[1];

  return {
    filename,
    name
  };
}

function parseMultipartBody(body: Buffer, boundary: string) {
  const delimiter = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  const parts: MultipartPart[] = [];
  let cursor = body.indexOf(delimiter);

  while (cursor !== -1) {
    const partStart = cursor + delimiter.length;

    if (body.subarray(partStart, partStart + 2).toString() === "--") {
      break;
    }

    let contentStart = partStart;

    if (body.subarray(contentStart, contentStart + 2).toString() === "\r\n") {
      contentStart += 2;
    }

    const nextDelimiter = body.indexOf(delimiter, contentStart);

    if (nextDelimiter === -1) {
      break;
    }

    const rawPart = body.subarray(contentStart, nextDelimiter);
    const headerEnd = rawPart.indexOf(headerSeparator);

    if (headerEnd === -1) {
      cursor = nextDelimiter;
      continue;
    }

    const headerText = rawPart.subarray(0, headerEnd).toString("utf8");
    const content = trimPartContent(
      rawPart.subarray(headerEnd + headerSeparator.length)
    );
    const headers = new Map<string, string>();

    for (const line of headerText.split("\r\n")) {
      const separatorIndex = line.indexOf(":");

      if (separatorIndex === -1) {
        continue;
      }

      headers.set(
        line.slice(0, separatorIndex).trim().toLowerCase(),
        line.slice(separatorIndex + 1).trim()
      );
    }

    const disposition = parseContentDisposition(
      headers.get("content-disposition") ?? ""
    );

    if (disposition.name) {
      parts.push({
        content,
        contentType: headers.get("content-type") ?? "application/octet-stream",
        filename: disposition.filename,
        name: disposition.name
      });
    }

    cursor = nextDelimiter;
  }

  return parts;
}

function findAudioPart(parts: MultipartPart[]) {
  const part = parts.find((candidate) => candidate.name === "audio");

  if (!part) {
    return null;
  }

  return {
    buffer: part.content,
    filename: part.filename || "voice.webm",
    mimeType: part.contentType || "application/octet-stream"
  };
}

function createSuccessBody(input: {
  result: SpeechTranscriptionProviderResult;
  startedAt: number;
}): SpeechTranscriptionSuccessResponse {
  return {
    model: {
      name: input.result.modelName,
      provider: input.result.provider
    },
    ok: true,
    text: input.result.text,
    timing: {
      modelMs: input.result.modelMs,
      totalMs: elapsedMs(input.startedAt)
    }
  };
}

export function createSpeechTranscriptionHandler(
  speechTranscriptionProvider: SpeechTranscriptionProvider = createOpenAiCompatibleSpeechTranscriptionProvider(),
  modelConfigService: ModelConfigService = createModelConfigService()
) {
  return async function handleSpeechTranscription(
    request: Request,
    response: ExpressResponse
  ) {
    const startedAt = Date.now();
    const contentType = getHeader(request, "content-type");
    const boundary = getMultipartBoundary(contentType);

    if (!boundary) {
      sendError(
        response,
        400,
        startedAt,
        "INVALID_AUDIO",
        "语音转写请求必须使用 multipart/form-data。",
        false
      );
      return;
    }

    let audio: SpeechTranscriptionAudio | null = null;

    try {
      audio = findAudioPart(parseMultipartBody(await readRawBody(request), boundary));
    } catch {
      sendError(
        response,
        400,
        startedAt,
        "INVALID_AUDIO",
        "语音转写音频解析失败。",
        false
      );
      return;
    }

    if (!audio || audio.buffer.length === 0) {
      sendError(
        response,
        400,
        startedAt,
        "EMPTY_AUDIO",
        "语音转写音频为空。",
        true
      );
      return;
    }

    const modelConfig = modelConfigService.getConfig();

    if (!modelConfig.ok) {
      if (modelConfig.reason === "invalid") {
        sendError(
          response,
          503,
          startedAt,
          "MODEL_CONFIG_INVALID",
          "模型配置无效，无法调用云端语音识别模型。",
          false,
          {
            invalid: modelConfig.invalid
          }
        );
        return;
      }

      sendError(
        response,
        503,
        startedAt,
        "MODEL_CONFIG_MISSING",
        "模型配置缺失，无法调用云端语音识别模型。",
        true,
        {
          missing: modelConfig.missing
        }
      );
      return;
    }

    if (!modelConfig.config.asrModelName) {
      sendError(
        response,
        503,
        startedAt,
        "MODEL_CONFIG_MISSING",
        "ASR 模型配置缺失，无法调用云端语音识别模型。",
        true,
        {
          missing: ["MODEL_ASR_NAME"]
        }
      );
      return;
    }

    try {
      const result = await speechTranscriptionProvider.transcribe({
        audio,
        config: modelConfig.config
      });
      const text = result.text.trim();

      if (!text) {
        sendError(
          response,
          422,
          startedAt,
          "EMPTY_TRANSCRIPTION",
          "云端语音识别没有返回可用文本，请再说一次。",
          true
        );
        return;
      }

      response.json(
        createSuccessBody({
          result: {
            ...result,
            text
          },
          startedAt
        })
      );
    } catch (error) {
      if (isProviderError(error)) {
        sendError(
          response,
          error.status,
          startedAt,
          error.code,
          error.message,
          error.retryable,
          error.details
        );
        return;
      }

      sendError(
        response,
        502,
        startedAt,
        "MODEL_PROVIDER_ERROR",
        "语音识别 provider 调用失败。",
        true
      );
    }
  };
}
