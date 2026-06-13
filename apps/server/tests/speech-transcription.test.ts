import { EventEmitter } from "node:events";

import { createRequest, createResponse } from "node-mocks-http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { createOpenAiCompatibleSpeechTranscriptionProvider } from "../src/speech-transcription";

type FakeSpeechProviderRequest = {
  audio: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
  };
  config: {
    apiKey: string;
    asrModelName?: string;
    baseUrl: string;
    modelName: string;
    timeoutMs: number;
  };
};

type FakeSpeechProvider = {
  transcribe(request: FakeSpeechProviderRequest): Promise<{
    modelMs: number;
    modelName: string;
    provider: "openai-compatible";
    text: string;
  }>;
};

const originalModelEnv = {
  MODEL_API_KEY: process.env.MODEL_API_KEY,
  MODEL_ASR_NAME: process.env.MODEL_ASR_NAME,
  MODEL_BASE_URL: process.env.MODEL_BASE_URL,
  MODEL_NAME: process.env.MODEL_NAME,
  MODEL_TIMEOUT_MS: process.env.MODEL_TIMEOUT_MS
};

function restoreModelEnv() {
  for (const [key, value] of Object.entries(originalModelEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearModelEnv() {
  delete process.env.MODEL_API_KEY;
  delete process.env.MODEL_ASR_NAME;
  delete process.env.MODEL_BASE_URL;
  delete process.env.MODEL_NAME;
  delete process.env.MODEL_TIMEOUT_MS;
}

function setValidModelEnv(overrides: NodeJS.ProcessEnv = {}) {
  process.env.MODEL_API_KEY = "test-key";
  process.env.MODEL_ASR_NAME = "asr-model";
  process.env.MODEL_BASE_URL = "https://model.example.test/v1";
  process.env.MODEL_NAME = "vision-model";

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createMultipartBody(
  parts: Array<{
    content: Buffer | string;
    contentType?: string;
    filename?: string;
    name: string;
  }>
) {
  const boundary = "----qny-test-boundary";
  const chunks: Buffer[] = [];

  for (const part of parts) {
    const headers = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${part.name}"${
        part.filename ? `; filename="${part.filename}"` : ""
      }`
    ];

    if (part.contentType) {
      headers.push(`Content-Type: ${part.contentType}`);
    }

    chunks.push(Buffer.from(`${headers.join("\r\n")}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content));
    chunks.push(Buffer.from("\r\n"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function createFakeSpeechProvider(
  options: {
    rejectWith?: Error;
    text?: string;
  } = {}
) {
  const calls: FakeSpeechProviderRequest[] = [];
  const provider: FakeSpeechProvider = {
    async transcribe(request) {
      calls.push(request);

      if (options.rejectWith) {
        throw options.rejectWith;
      }

      return {
        modelMs: 18,
        modelName: request.config.asrModelName ?? "asr-model",
        provider: "openai-compatible",
        text: options.text ?? "你看到什么"
      };
    }
  };

  return {
    calls,
    provider
  };
}

function createProviderBackedApp(input: {
  body: string;
  status: number;
}) {
  const provider = createOpenAiCompatibleSpeechTranscriptionProvider({
    fetch: async () =>
      new Response(input.body, {
        status: input.status
      })
  });

  return createApp({ speechTranscriptionProvider: provider });
}

async function postSpeechTranscription(
  app = createApp(),
  input: {
    audio?: Buffer;
    contentType?: string;
    filename?: string;
  } = {}
) {
  const multipart = createMultipartBody([
    {
      content: input.audio ?? Buffer.from("fake-webm-audio"),
      contentType: input.contentType ?? "audio/webm",
      filename: input.filename ?? "voice.webm",
      name: "audio"
    },
    {
      content: "session-1",
      name: "sessionId"
    }
  ]);
  const request = createRequest({
    body: multipart.body,
    headers: {
      "content-length": String(multipart.body.length),
      "content-type": multipart.contentType
    },
    method: "POST",
    url: "/api/speech-transcription"
  });
  const response = createResponse({ eventEmitter: EventEmitter });
  const completed = new Promise<void>((resolve) => {
    response.on("end", () => resolve());
  });

  app.use((_request, fallbackResponse) => {
    fallbackResponse.status(404).json({
      error: {
        code: "NOT_FOUND"
      },
      ok: false
    });
  });
  app.handle(request, response);
  await completed;

  return {
    body: response._getJSONData(),
    status: response._getStatusCode()
  };
}

describe("POST /api/speech-transcription", () => {
  beforeEach(() => {
    clearModelEnv();
  });

  afterEach(() => {
    restoreModelEnv();
  });

  it("transcribes multipart browser audio with the configured ASR model", async () => {
    setValidModelEnv();
    const fake = createFakeSpeechProvider();

    const response = await postSpeechTranscription(
      createApp({ speechTranscriptionProvider: fake.provider })
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      model: {
        name: "asr-model",
        provider: "openai-compatible"
      },
      ok: true,
      text: "你看到什么",
      timing: {
        modelMs: 18
      }
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      audio: {
        filename: "voice.webm",
        mimeType: "audio/webm"
      },
      config: {
        apiKey: "test-key",
        asrModelName: "asr-model",
        baseUrl: "https://model.example.test/v1",
        modelName: "vision-model"
      }
    });
    expect(fake.calls[0].audio.buffer.toString()).toBe("fake-webm-audio");
  });

  it("fails explicitly when the ASR model name is missing", async () => {
    setValidModelEnv({ MODEL_ASR_NAME: undefined });
    const fake = createFakeSpeechProvider();

    const response = await postSpeechTranscription(
      createApp({ speechTranscriptionProvider: fake.provider })
    );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: {
        code: "MODEL_CONFIG_MISSING",
        details: {
          missing: ["MODEL_ASR_NAME"]
        },
        retryable: true
      },
      ok: false
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("maps provider failures to a retryable model provider error", async () => {
    setValidModelEnv();
    const fake = createFakeSpeechProvider({
      rejectWith: Object.assign(new Error("provider rejected audio"), {
        code: "MODEL_PROVIDER_ERROR",
        details: {
          providerStatus: 502
        },
        retryable: true,
        status: 502
      })
    });

    const response = await postSpeechTranscription(
      createApp({ speechTranscriptionProvider: fake.provider })
    );

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      error: {
        code: "MODEL_PROVIDER_ERROR",
        details: {
          providerStatus: 502
        },
        retryable: true
      },
      ok: false
    });
  });

  it.each([
    [401, "API Key 或模型权限无效。", false],
    [403, "API Key 或模型权限无效。", false],
    [400, "ASR 模型名、接口路径或请求格式不兼容。", false],
    [404, "ASR 模型名、接口路径或请求格式不兼容。", false],
    [429, "ASR 服务额度不足或触发限流。", true],
    [500, "ASR provider 服务异常。", true]
  ])(
    "returns actionable provider diagnostics for ASR status %i",
    async (providerStatus, message, retryable) => {
      setValidModelEnv();

      const response = await postSpeechTranscription(
        createProviderBackedApp({
          body: `provider status ${providerStatus}`,
          status: providerStatus
        })
      );

      expect(response.status).toBe(502);
      expect(response.body).toMatchObject({
        error: {
          code: "MODEL_PROVIDER_ERROR",
          details: {
            providerStatus,
            providerText: `provider status ${providerStatus}`
          },
          message,
          retryable
        },
        ok: false
      });
    }
  );

  it("redacts and truncates provider error text", async () => {
    setValidModelEnv({ MODEL_API_KEY: "sk-test-secret" });
    const longProviderText = `invalid key sk-test-secret ${"x".repeat(800)}`;

    const response = await postSpeechTranscription(
      createProviderBackedApp({
        body: longProviderText,
        status: 401
      })
    );

    const providerText = response.body.error.details.providerText as string;

    expect(providerText).not.toContain("sk-test-secret");
    expect(providerText).toContain("[redacted]");
    expect(providerText.endsWith("...")).toBe(true);
    expect(providerText.length).toBeLessThanOrEqual(520);
  });

  it("maps provider timeouts to a retryable timeout error", async () => {
    setValidModelEnv();
    const fake = createFakeSpeechProvider({
      rejectWith: Object.assign(new Error("timeout"), {
        code: "MODEL_PROVIDER_TIMEOUT",
        retryable: true,
        status: 504
      })
    });

    const response = await postSpeechTranscription(
      createApp({ speechTranscriptionProvider: fake.provider })
    );

    expect(response.status).toBe(504);
    expect(response.body).toMatchObject({
      error: {
        code: "MODEL_PROVIDER_TIMEOUT",
        retryable: true
      },
      ok: false
    });
  });

  it("returns an explicit error when ASR produces an empty transcription", async () => {
    setValidModelEnv();
    const fake = createFakeSpeechProvider({ text: "   " });

    const response = await postSpeechTranscription(
      createApp({ speechTranscriptionProvider: fake.provider })
    );

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: {
        code: "EMPTY_TRANSCRIPTION",
        retryable: true
      },
      ok: false
    });
  });
});
