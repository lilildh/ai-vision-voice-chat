import { EventEmitter } from "node:events";

import { createRequest, createResponse } from "node-mocks-http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { createCostControlService } from "../src/cost-control";
import {
  MultimodalProviderError,
  type MultimodalProvider,
  type MultimodalProviderRequest
} from "../src/multimodal-provider";

type RequestBody = {
  keyframes?: unknown[];
  session?: unknown;
  text?: string;
};

const originalModelEnv = {
  COST_IMAGE_TOKENS_PER_KEYFRAME: process.env.COST_IMAGE_TOKENS_PER_KEYFRAME,
  COST_INPUT_USD_PER_1M_TOKENS: process.env.COST_INPUT_USD_PER_1M_TOKENS,
  COST_OUTPUT_USD_PER_1M_TOKENS: process.env.COST_OUTPUT_USD_PER_1M_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS: process.env.MODEL_MAX_OUTPUT_TOKENS,
  MODEL_TIMEOUT_MS: process.env.MODEL_TIMEOUT_MS,
  MODEL_API_KEY: process.env.MODEL_API_KEY,
  MODEL_BASE_URL: process.env.MODEL_BASE_URL,
  MODEL_NAME: process.env.MODEL_NAME
};

function imageDataUrl(bytes = Buffer.from("image")) {
  return `data:image/png;base64,${Buffer.alloc(bytes.length, bytes).toString("base64")}`;
}

function validRequestBody(overrides: RequestBody = {}) {
  return {
    text: "你看到了什么？",
    keyframes: [
      {
        capturedAt: "2026-06-12T07:30:00.000Z",
        dataUrl: imageDataUrl(),
        height: 360,
        id: "frame-1",
        width: 640
      }
    ],
    session: {
      messages: [
        {
          createdAt: "2026-06-12T07:29:59.000Z",
          role: "user",
          text: "上一轮问题"
        }
      ],
      sessionId: "session-1",
      stats: {
        estimatedUsd: 0.001,
        keyframeCount: 2,
        requestCount: 1
      }
    },
    ...overrides
  };
}

function setValidModelEnv(overrides: NodeJS.ProcessEnv = {}) {
  process.env.MODEL_API_KEY = "test-key";
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

function createFakeMultimodalProvider(
  options: {
    rejectWith?: Error;
    streamDeltas?: string[];
    streamRejectWith?: Error;
  } = {}
) {
  const calls: MultimodalProviderRequest[] = [];
  const provider: MultimodalProvider = {
    async complete(request) {
      calls.push(request);

      if (options.rejectWith) {
        throw options.rejectWith;
      }

      return {
        modelMs: 12,
        modelName: request.config.modelName,
        provider: "openai-compatible",
        text: "我看到一张桌面关键帧。"
      };
    },
    async completeStream(request, onDelta) {
      calls.push(request);

      if (options.streamRejectWith) {
        throw options.streamRejectWith;
      }

      const deltas = options.streamDeltas ?? ["我看到", "一张桌面关键帧。"];

      for (const delta of deltas) {
        onDelta(delta);
      }

      return {
        modelMs: 12,
        modelName: request.config.modelName,
        provider: "openai-compatible",
        text: deltas.join(""),
        usage: {
          inputTokens: 21,
          outputTokens: 8,
          totalTokens: 29
        }
      };
    }
  };

  return {
    calls,
    provider
  };
}

async function postConversationTurn(body: unknown, app = createApp()) {
  const request = createRequest({
    body,
    headers: {
      "content-type": "application/json"
    },
    method: "POST",
    url: "/api/conversation-turn"
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

async function postConversationTurnStream(body: unknown, app = createApp()) {
  const request = createRequest({
    body,
    headers: {
      "content-type": "application/json"
    },
    method: "POST",
    url: "/api/conversation-turn/stream"
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
    body: String(response._getData()),
    headers: response._getHeaders(),
    status: response._getStatusCode()
  };
}

function parseSseEvents(rawBody: string) {
  return rawBody
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = {
        data: "",
        event: "message"
      };

      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) {
          event.event = line.slice("event: ".length);
        }

        if (line.startsWith("data: ")) {
          event.data += line.slice("data: ".length);
        }
      }

      return {
        event: event.event,
        data: JSON.parse(event.data) as unknown
      };
    });
}

function restoreModelEnv() {
  for (const [key, value] of Object.entries(originalModelEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("POST /api/conversation-turn", () => {
  beforeEach(() => {
    delete process.env.MODEL_API_KEY;
    delete process.env.MODEL_BASE_URL;
    delete process.env.MODEL_NAME;
    delete process.env.MODEL_TIMEOUT_MS;
    delete process.env.COST_IMAGE_TOKENS_PER_KEYFRAME;
    delete process.env.COST_INPUT_USD_PER_1M_TOKENS;
    delete process.env.COST_OUTPUT_USD_PER_1M_TOKENS;
    delete process.env.MODEL_MAX_OUTPUT_TOKENS;
  });

  afterEach(() => {
    restoreModelEnv();
  });

  it("rejects empty text with an explicit error code", async () => {
    const response = await postConversationTurn(
      validRequestBody({ text: "   " })
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      cost: {
        request: {
          cloudCallAttempted: false
        }
      },
      error: {
        code: "EMPTY_TEXT",
        retryable: false
      },
      ok: false
    });
  });

  it("rejects requests without keyframes", async () => {
    const response = await postConversationTurn(
      validRequestBody({ keyframes: [] })
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "NO_KEYFRAMES"
      },
      ok: false
    });
  });

  it("rejects more than three keyframes", async () => {
    const keyframes = Array.from({ length: 4 }, (_, index) => ({
      capturedAt: "2026-06-12T07:30:00.000Z",
      dataUrl: imageDataUrl(),
      id: `frame-${index + 1}`
    }));

    const response = await postConversationTurn(
      validRequestBody({ keyframes })
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "TOO_MANY_KEYFRAMES",
        details: {
          limit: 3
        }
      },
      ok: false
    });
  });

  it("rejects a keyframe larger than one megabyte", async () => {
    const response = await postConversationTurn(
      validRequestBody({
        keyframes: [
          {
            capturedAt: "2026-06-12T07:30:00.000Z",
            dataUrl: imageDataUrl(Buffer.alloc(1_000_001)),
            id: "frame-1"
          }
        ]
      })
    );

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      error: {
        code: "IMAGE_TOO_LARGE",
        details: {
          limitBytes: 1_000_000
        }
      },
      ok: false
    });
  });

  it("rejects non-image data URLs", async () => {
    const response = await postConversationTurn(
      validRequestBody({
        keyframes: [
          {
            capturedAt: "2026-06-12T07:30:00.000Z",
            dataUrl: "data:text/plain;base64,aGVsbG8=",
            id: "frame-1"
          }
        ]
      })
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "INVALID_KEYFRAME"
      },
      ok: false
    });
  });

  it("rejects invalid base64 image payloads", async () => {
    const response = await postConversationTurn(
      validRequestBody({
        keyframes: [
          {
            capturedAt: "2026-06-12T07:30:00.000Z",
            dataUrl: "data:image/png;base64,not-valid-base64!",
            id: "frame-1"
          }
        ]
      })
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "INVALID_KEYFRAME"
      },
      ok: false
    });
  });

  it("rejects valid requests when model configuration is missing", async () => {
    const response = await postConversationTurn(validRequestBody());

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: {
        code: "MODEL_CONFIG_MISSING",
        details: {
          missing: ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME"]
        },
        retryable: true
      },
      ok: false
    });
  });

  it("rejects invalid model configuration before calling the provider", async () => {
    setValidModelEnv({ MODEL_TIMEOUT_MS: "soon" });
    const fake = createFakeMultimodalProvider();

    const response = await postConversationTurn(
      validRequestBody(),
      createApp({ multimodalProvider: fake.provider })
    );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: {
        code: "MODEL_CONFIG_INVALID",
        details: {
          invalid: [
            {
              name: "MODEL_TIMEOUT_MS",
              value: "soon"
            }
          ]
        },
        retryable: false
      },
      ok: false
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns a successful assistant reply from the configured provider", async () => {
    setValidModelEnv({
      MODEL_MAX_OUTPUT_TOKENS: "128",
      MODEL_TIMEOUT_MS: "3000"
    });
    const fake = createFakeMultimodalProvider();

    const response = await postConversationTurn(
      validRequestBody(),
      createApp({ multimodalProvider: fake.provider })
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      cost: {
        request: {
          cloudCallAttempted: true,
          imageBytes: 5,
          inputTextChars: 7,
          keyframeCount: 1
        },
        session: {
          keyframeCount: 1,
          requestCount: 1
        }
      },
      model: {
        name: "vision-model",
        provider: "openai-compatible"
      },
      ok: true,
      reply: {
        role: "assistant",
        text: "我看到一张桌面关键帧。"
      },
      timing: {
        modelMs: 12
      }
    });
    expect(response.body.session.turnId).toEqual(expect.any(String));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      config: {
        apiKey: "test-key",
        baseUrl: "https://model.example.test/v1",
        maxOutputTokens: 128,
        modelName: "vision-model",
        timeoutMs: 3000
      },
      keyframes: [
        {
          byteLength: 5,
          dataUrl: imageDataUrl(),
          id: "frame-1"
        }
      ],
      messages: [
        {
          role: "user",
          text: "上一轮问题"
        }
      ],
      text: "你看到了什么？"
    });
  });

  it("returns an explicit error when the provider fails", async () => {
    setValidModelEnv();
    const providerError = new MultimodalProviderError({
      code: "MODEL_PROVIDER_ERROR",
      details: {
        providerStatus: 502
      },
      message: "上游模型调用失败。",
      retryable: true,
      status: 502
    });
    const fake = createFakeMultimodalProvider({ rejectWith: providerError });

    const response = await postConversationTurn(
      validRequestBody(),
      createApp({ multimodalProvider: fake.provider })
    );

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      cost: {
        request: {
          cloudCallAttempted: true
        }
      },
      error: {
        code: "MODEL_PROVIDER_ERROR",
        details: {
          providerStatus: 502
        },
        message: "上游模型调用失败。",
        retryable: true
      },
      ok: false
    });
  });

  it("rejects the seventh valid request in the current minute", async () => {
    setValidModelEnv();
    const fake = createFakeMultimodalProvider();
    const app = createApp({ multimodalProvider: fake.provider });

    for (let index = 0; index < 6; index += 1) {
      const response = await postConversationTurn(validRequestBody(), app);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ok: true
      });
    }

    const response = await postConversationTurn(validRequestBody(), app);

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        details: {
          limit: 6,
          windowMs: 60_000
        },
        retryable: true
      },
      ok: false
    });
    expect(response.body.error.details.retryAfterMs).toBeGreaterThan(0);
  });

  it("rejects the twenty-first valid turn in one session", async () => {
    setValidModelEnv();
    const fake = createFakeMultimodalProvider();
    const app = createApp({
      costControlService: createCostControlService({
        rateLimit: { limit: 100, windowMs: 60_000 }
      }),
      multimodalProvider: fake.provider
    });

    for (let index = 0; index < 20; index += 1) {
      const response = await postConversationTurn(validRequestBody(), app);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ok: true
      });
    }

    const response = await postConversationTurn(validRequestBody(), app);

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({
      error: {
        code: "SESSION_TURN_LIMIT_EXCEEDED",
        details: {
          currentTurnCount: 20,
          limit: 20,
          sessionId: "session-1"
        },
        retryable: false
      },
      ok: false
    });
  });

  it("rejects invalid cost configuration with an explicit error", async () => {
    setValidModelEnv();
    process.env.COST_OUTPUT_USD_PER_1M_TOKENS = "free";

    const response = await postConversationTurn(validRequestBody());

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: {
        code: "COST_CONFIG_INVALID",
        details: {
          invalid: [
            {
              name: "COST_OUTPUT_USD_PER_1M_TOKENS",
              value: "free"
            }
          ]
        },
        retryable: false
      },
      ok: false
    });
  });

  it("streams statuses, assistant deltas, and final completion over SSE", async () => {
    setValidModelEnv({
      MODEL_MAX_OUTPUT_TOKENS: "128",
      MODEL_TIMEOUT_MS: "3000"
    });
    const fake = createFakeMultimodalProvider({
      streamDeltas: ["我看到", "桌面上的杯子。"]
    });

    const response = await postConversationTurnStream(
      validRequestBody(),
      createApp({ multimodalProvider: fake.provider })
    );
    const events = parseSseEvents(response.body);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(events.map((event) => event.event)).toEqual([
      "status",
      "status",
      "status",
      "status",
      "status",
      "delta",
      "delta",
      "status",
      "complete"
    ]);
    expect(events.slice(0, 5).map((event) => event.data)).toEqual([
      { phase: "validating" },
      { phase: "estimating-cost" },
      { phase: "checking-model" },
      { phase: "calling-model" },
      { phase: "streaming-reply" }
    ]);
    expect(events[5].data).toEqual({ text: "我看到" });
    expect(events[6].data).toEqual({ text: "桌面上的杯子。" });
    expect(events[7].data).toEqual({ phase: "completed" });
    expect(events[8].data).toMatchObject({
      cost: {
        request: {
          cloudCallAttempted: true
        }
      },
      model: {
        name: "vision-model",
        provider: "openai-compatible",
        usage: {
          inputTokens: 21,
          outputTokens: 8,
          totalTokens: 29
        }
      },
      ok: true,
      reply: {
        role: "assistant",
        text: "我看到桌面上的杯子。"
      }
    });
  });

  it("streams validation errors as explicit SSE error events", async () => {
    const response = await postConversationTurnStream(
      validRequestBody({ text: "   " })
    );
    const events = parseSseEvents(response.body);

    expect(response.status).toBe(200);
    expect(events).toEqual([
      {
        data: { phase: "validating" },
        event: "status"
      },
      {
        data: {
          response: expect.objectContaining({
            cost: {
              request: expect.objectContaining({
                cloudCallAttempted: false
              }),
              session: expect.any(Object)
            },
            error: expect.objectContaining({
              code: "EMPTY_TEXT",
              retryable: false
            }),
            ok: false
          }),
          status: 400
        },
        event: "error"
      }
    ]);
  });

  it("streams provider failures with attempted cloud-call cost", async () => {
    setValidModelEnv();
    const providerError = new MultimodalProviderError({
      code: "MODEL_PROVIDER_ERROR",
      details: {
        providerStatus: 502
      },
      message: "上游模型调用失败。",
      retryable: true,
      status: 502
    });
    const fake = createFakeMultimodalProvider({
      streamRejectWith: providerError
    });

    const response = await postConversationTurnStream(
      validRequestBody(),
      createApp({ multimodalProvider: fake.provider })
    );
    const events = parseSseEvents(response.body);
    const errorEvent = events.at(-1);

    expect(errorEvent).toMatchObject({
      event: "error",
      data: {
        response: {
          cost: {
            request: {
              cloudCallAttempted: true
            }
          },
          error: {
            code: "MODEL_PROVIDER_ERROR",
            details: {
              providerStatus: 502
            },
            message: "上游模型调用失败。",
            retryable: true
          },
          ok: false
        },
        status: 502
      }
    });
  });
});
