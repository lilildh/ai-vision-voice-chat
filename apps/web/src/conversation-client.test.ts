import { describe, expect, it, vi } from "vitest";

import {
  postSpeechTranscription,
  postConversationTurn,
  streamConversationTurn
} from "./conversation-client";

const body = {
  keyframes: [
    {
      capturedAt: "2026-06-13T01:00:00.000Z",
      dataUrl: "data:image/jpeg;base64,aW1hZ2U=",
      height: 720,
      id: "frame-1",
      width: 1280
    }
  ],
  session: {
    messages: [],
    sessionId: "session-1",
    stats: {
      estimatedUsd: 0,
      keyframeCount: 0,
      requestCount: 0
    }
  },
  text: "你看到了什么？"
};

function createStreamResponse(chunks: string[]) {
  const encoder = new TextEncoder();

  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    }),
    ok: true
  } as Response;
}

function createSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("postConversationTurn", () => {
  it("posts the existing conversation-turn contract as JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        reply: { role: "assistant", text: "我看到一张桌面画面。" }
      })
    });

    const response = await postConversationTurn(body, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith("/api/conversation-turn", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });
    expect(response).toEqual({
      ok: true,
      reply: { role: "assistant", text: "我看到一张桌面画面。" }
    });
  });
});

describe("postSpeechTranscription", () => {
  it("posts recorded browser audio as multipart form data", async () => {
    const audio = new Blob(["fake-webm-audio"], { type: "audio/webm" });
    const fetchFn = vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        text: "你看到了什么？"
      }),
      ok: true
    });

    const response = await postSpeechTranscription(
      audio,
      { sessionId: "session-1" },
      fetchFn
    );

    expect(fetchFn).toHaveBeenCalledWith("/api/speech-transcription", {
      body: expect.any(FormData),
      method: "POST"
    });
    const formData = fetchFn.mock.calls[0]?.[1]?.body as FormData;

    expect(formData.get("sessionId")).toBe("session-1");
    expect(response).toEqual({
      ok: true,
      text: "你看到了什么？"
    });
  });
});

describe("streamConversationTurn", () => {
  it("parses status, split delta chunks, and the final completion response", async () => {
    const completeResponse = {
      cost: {
        session: {
          estimatedUsd: 0.00042,
          keyframeCount: 1,
          requestCount: 1
        }
      },
      model: {
        name: "vision-model",
        provider: "openai-compatible",
        usage: {
          inputTokens: 30,
          outputTokens: 7,
          totalTokens: 37
        }
      },
      ok: true,
      reply: { role: "assistant", text: "我看到杯子。" },
      session: { sessionId: "session-1", turnId: "turn-1" },
      timing: { modelMs: 100, totalMs: 321 }
    };
    const deltaEvent = createSse("delta", { text: "我看到" });
    const fetchFn = vi.fn().mockResolvedValue(
      createStreamResponse([
        createSse("status", { phase: "validating" }),
        deltaEvent.slice(0, 17),
        deltaEvent.slice(17),
        createSse("delta", { text: "杯子。" }),
        createSse("complete", completeResponse)
      ])
    );
    const statuses: string[] = [];
    const deltas: string[] = [];

    const response = await streamConversationTurn(
      body,
      {
        onDelta: (text) => deltas.push(text),
        onStatus: (phase) => statuses.push(phase)
      },
      fetchFn
    );

    expect(fetchFn).toHaveBeenCalledWith("/api/conversation-turn/stream", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });
    expect(statuses).toEqual(["validating"]);
    expect(deltas).toEqual(["我看到", "杯子。"]);
    expect(response).toEqual(completeResponse);
  });

  it("returns explicit error events without throwing", async () => {
    const errorResponse = {
      cost: {
        session: {
          estimatedUsd: 0,
          keyframeCount: 1,
          requestCount: 1
        }
      },
      error: {
        code: "RATE_LIMITED",
        message: "请求过于频繁，请稍后再试。",
        retryable: true
      },
      ok: false,
      timing: { totalMs: 19 }
    };
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        createStreamResponse([
          createSse("error", { response: errorResponse, status: 429 })
        ])
      );
    const errors: string[] = [];

    const response = await streamConversationTurn(
      body,
      {
        onError: (nextError) => errors.push(nextError.error.code)
      },
      fetchFn
    );

    expect(errors).toEqual(["RATE_LIMITED"]);
    expect(response).toEqual(errorResponse);
  });

  it("rejects malformed stream events", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(createStreamResponse(["event: delta\ndata: {bad}\n\n"]));

    await expect(streamConversationTurn(body, {}, fetchFn)).rejects.toThrow(
      "流式对话响应格式不正确。"
    );
  });
});
