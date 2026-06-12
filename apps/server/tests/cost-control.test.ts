import { describe, expect, it } from "vitest";

import {
  createCostControlService,
  estimateConversationCost,
  readCostControlConfig
} from "../src/cost-control";

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    COST_IMAGE_TOKENS_PER_KEYFRAME: "850",
    COST_INPUT_USD_PER_1M_TOKENS: "5",
    COST_OUTPUT_USD_PER_1M_TOKENS: "15",
    MODEL_MAX_OUTPUT_TOKENS: "512",
    ...overrides
  };
}

describe("cost-control", () => {
  it("estimates request and session cost from text, keyframes, and output budget", () => {
    const config = readCostControlConfig(validEnv());

    expect(config.ok).toBe(true);

    if (!config.ok) {
      return;
    }

    const cost = estimateConversationCost({
      config: config.config,
      imageBytes: 12_000,
      keyframeCount: 2,
      previousSessionCost: {
        estimatedUsd: 0.001,
        keyframeCount: 3,
        requestCount: 4
      },
      text: "123456789"
    });

    expect(cost).toEqual({
      request: {
        cloudCallAttempted: false,
        estimatedInputTokens: 1703,
        estimatedOutputTokens: 512,
        estimatedUsd: 0.016195,
        imageBytes: 12_000,
        inputTextChars: 9,
        keyframeCount: 2
      },
      session: {
        estimatedUsd: 0.017195,
        keyframeCount: 5,
        requestCount: 5
      }
    });
  });

  it("allows six requests per minute and rejects the seventh", () => {
    const service = createCostControlService({
      now: () => 1_000
    });
    const config = readCostControlConfig(validEnv());

    expect(config.ok).toBe(true);

    if (!config.ok) {
      return;
    }

    const request = {
      imageBytes: 5,
      keyframeCount: 1,
      sessionId: "session-rate-limit",
      text: "你看到了什么？"
    };

    const allowed = Array.from({ length: 6 }, () =>
      service.evaluate({ config: config.config, request })
    );

    expect(allowed.every((result) => result.ok)).toBe(true);

    const rejected = service.evaluate({ config: config.config, request });

    expect(rejected).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        retryable: true,
        status: 429
      },
      ok: false
    });

    if (!rejected.ok) {
      expect(rejected.error.details).toEqual({
        limit: 6,
        retryAfterMs: 60_000,
        windowMs: 60_000
      });
    }
  });

  it("allows requests after the one-minute window expires", () => {
    let now = 1_000;
    const service = createCostControlService({
      now: () => now
    });
    const config = readCostControlConfig(validEnv());

    expect(config.ok).toBe(true);

    if (!config.ok) {
      return;
    }

    const request = {
      imageBytes: 5,
      keyframeCount: 1,
      sessionId: "session-window-reset",
      text: "你看到了什么？"
    };

    Array.from({ length: 6 }, () =>
      service.evaluate({ config: config.config, request })
    );

    now = 61_001;

    const result = service.evaluate({ config: config.config, request });

    expect(result.ok).toBe(true);
  });

  it("rejects the twenty-first turn in one session", () => {
    const service = createCostControlService({
      rateLimit: { limit: 100, windowMs: 60_000 }
    });
    const config = readCostControlConfig(validEnv());

    expect(config.ok).toBe(true);

    if (!config.ok) {
      return;
    }

    const request = {
      imageBytes: 5,
      keyframeCount: 1,
      sessionId: "session-turn-limit",
      text: "继续看一下"
    };

    const allowed = Array.from({ length: 20 }, () =>
      service.evaluate({ config: config.config, request })
    );

    expect(allowed.every((result) => result.ok)).toBe(true);

    const rejected = service.evaluate({ config: config.config, request });

    expect(rejected).toMatchObject({
      error: {
        code: "SESSION_TURN_LIMIT_EXCEEDED",
        retryable: false,
        status: 429
      },
      ok: false
    });

    if (!rejected.ok) {
      expect(rejected.error.details).toEqual({
        currentTurnCount: 20,
        limit: 20,
        sessionId: "session-turn-limit"
      });
    }
  });

  it("keeps session turn counters isolated by session id", () => {
    const service = createCostControlService({
      rateLimit: { limit: 100, windowMs: 60_000 }
    });
    const config = readCostControlConfig(validEnv());

    expect(config.ok).toBe(true);

    if (!config.ok) {
      return;
    }

    const baseRequest = {
      imageBytes: 5,
      keyframeCount: 1,
      text: "继续看一下"
    };

    Array.from({ length: 20 }, () =>
      service.evaluate({
        config: config.config,
        request: {
          ...baseRequest,
          sessionId: "session-a"
        }
      })
    );

    const result = service.evaluate({
      config: config.config,
      request: {
        ...baseRequest,
        sessionId: "session-b"
      }
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid cost configuration instead of silently falling back", () => {
    const config = readCostControlConfig(
      validEnv({ COST_INPUT_USD_PER_1M_TOKENS: "free" })
    );

    expect(config).toEqual({
      error: {
        invalid: [
          {
            name: "COST_INPUT_USD_PER_1M_TOKENS",
            value: "free"
          }
        ]
      },
      ok: false
    });
  });
});
