import { createRequest, createResponse } from "node-mocks-http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";

type RequestBody = {
  keyframes?: unknown[];
  session?: unknown;
  text?: string;
};

const originalModelEnv = {
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

function postConversationTurn(body: unknown) {
  const request = createRequest({
    body,
    headers: {
      "content-type": "application/json"
    },
    method: "POST",
    url: "/api/conversation-turn"
  });
  const response = createResponse();
  const app = createApp();

  app.use((_request, fallbackResponse) => {
    fallbackResponse.status(404).json({
      error: {
        code: "NOT_FOUND"
      },
      ok: false
    });
  });
  app.handle(request, response);

  return {
    body: response._getJSONData(),
    status: response._getStatusCode()
  };
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
  });

  afterEach(() => {
    restoreModelEnv();
  });

  it("rejects empty text with an explicit error code", () => {
    const response = postConversationTurn(validRequestBody({ text: "   " }));

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

  it("rejects requests without keyframes", () => {
    const response = postConversationTurn(validRequestBody({ keyframes: [] }));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "NO_KEYFRAMES"
      },
      ok: false
    });
  });

  it("rejects more than three keyframes", () => {
    const keyframes = Array.from({ length: 4 }, (_, index) => ({
      capturedAt: "2026-06-12T07:30:00.000Z",
      dataUrl: imageDataUrl(),
      id: `frame-${index + 1}`
    }));

    const response = postConversationTurn(validRequestBody({ keyframes }));

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

  it("rejects a keyframe larger than one megabyte", () => {
    const response = postConversationTurn(
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

  it("rejects non-image data URLs", () => {
    const response = postConversationTurn(
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

  it("rejects invalid base64 image payloads", () => {
    const response = postConversationTurn(
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

  it("rejects valid requests when model configuration is missing", () => {
    const response = postConversationTurn(validRequestBody());

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

  it("returns a provider-not-implemented failure when config and validation pass", () => {
    process.env.MODEL_API_KEY = "test-key";
    process.env.MODEL_BASE_URL = "https://model.example.test/v1";
    process.env.MODEL_NAME = "vision-model";

    const response = postConversationTurn(validRequestBody());

    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({
      cost: {
        request: {
          cloudCallAttempted: false,
          imageBytes: 5,
          inputTextChars: 7,
          keyframeCount: 1
        }
      },
      error: {
        code: "MODEL_PROVIDER_NOT_IMPLEMENTED",
        retryable: false
      },
      ok: false
    });
  });
});
