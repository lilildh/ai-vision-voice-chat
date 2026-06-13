import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MultimodalProviderError,
  createOpenAiCompatibleMultimodalProvider
} from "../src/multimodal-provider";

const baseRequest = {
  config: {
    apiKey: "test-key",
    baseUrl: "https://model.example.test/v1/",
    maxOutputTokens: 128,
    modelName: "vision-model",
    timeoutMs: 10_000
  },
  keyframes: [
    {
      byteLength: 5,
      capturedAt: "2026-06-12T07:30:00.000Z",
      dataUrl: "data:image/png;base64,aW1hZ2U=",
      height: 360,
      id: "frame-1",
      width: 640
    }
  ],
  messages: [
    {
      createdAt: "2026-06-12T07:29:59.000Z",
      role: "user" as const,
      text: "上一轮问题"
    }
  ],
  text: "你看到了什么？"
};

function createJsonResponse(body: unknown, status = 200) {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  } as Response;
}

describe("createOpenAiCompatibleMultimodalProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("posts text and keyframes to the OpenAI-compatible chat completions endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        choices: [
          {
            message: {
              content: "画面里有一个桌面物体。"
            }
          }
        ],
        usage: {
          completion_tokens: 9,
          prompt_tokens: 42,
          total_tokens: 51
        }
      })
    );
    const provider = createOpenAiCompatibleMultimodalProvider({
      fetch: fetchMock
    });

    const result = await provider.complete(baseRequest);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://model.example.test/v1/chat/completions",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json"
        },
        method: "POST"
      })
    );
    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse(String(init.body));

    expect(payload).toMatchObject({
      max_tokens: 128,
      messages: [
        {
          content: "上一轮问题",
          role: "user"
        },
        {
          content: [
            {
              text: "你看到了什么？",
              type: "text"
            },
            {
              image_url: {
                url: "data:image/png;base64,aW1hZ2U="
              },
              type: "image_url"
            }
          ],
          role: "user"
        }
      ],
      model: "vision-model",
      stream: false
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({
      modelName: "vision-model",
      provider: "openai-compatible",
      text: "画面里有一个桌面物体。",
      usage: {
        inputTokens: 42,
        outputTokens: 9,
        totalTokens: 51
      }
    });
    expect(result.modelMs).toBeGreaterThanOrEqual(0);
  });

  it("fails explicitly when the upstream provider returns a non-2xx status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(createJsonResponse({ error: "unauthorized" }, 401));
    const provider = createOpenAiCompatibleMultimodalProvider({
      fetch: fetchMock
    });

    await expect(provider.complete(baseRequest)).rejects.toMatchObject({
      code: "MODEL_PROVIDER_ERROR",
      details: {
        providerStatus: 401
      },
      retryable: false,
      status: 502
    });
  });

  it("fails explicitly when the upstream response has no assistant text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        choices: [
          {
            message: {
              content: "   "
            }
          }
        ]
      })
    );
    const provider = createOpenAiCompatibleMultimodalProvider({
      fetch: fetchMock
    });

    await expect(provider.complete(baseRequest)).rejects.toMatchObject({
      code: "MODEL_PROVIDER_ERROR",
      message: "模型 provider 返回了空回复。",
      retryable: true,
      status: 502
    });
  });

  it("fails explicitly when the upstream request times out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });
    const provider = createOpenAiCompatibleMultimodalProvider({
      fetch: fetchMock
    });
    const pending = provider.complete({
      ...baseRequest,
      config: {
        ...baseRequest.config,
        timeoutMs: 25
      }
    });
    const errorPromise = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(25);

    const error = await errorPromise;

    expect(error).toBeInstanceOf(MultimodalProviderError);
    expect(error).toMatchObject({
      code: "MODEL_PROVIDER_TIMEOUT",
      retryable: true,
      status: 504
    });
  });
});
