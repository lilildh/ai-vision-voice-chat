import type {
  ConversationTurnErrorCode,
  CostStats
} from "./conversation-contract";

export type CostControlConfig = {
  imageTokensPerKeyframe: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  maxOutputTokens: number;
};

type CostControlConfigError = {
  invalid: Array<{
    name: string;
    value: string;
  }>;
};

export type CostControlConfigResult =
  | {
      ok: true;
      config: CostControlConfig;
    }
  | {
      ok: false;
      error: CostControlConfigError;
    };

type SessionCost = CostStats["session"];

type EstimateInput = {
  config: CostControlConfig;
  imageBytes: number;
  keyframeCount: number;
  previousSessionCost?: SessionCost;
  text: string;
};

type CostControlRequest = {
  imageBytes: number;
  keyframeCount: number;
  sessionId: string;
  text: string;
};

type CostControlError = {
  code: ConversationTurnErrorCode;
  details: Record<string, unknown>;
  message: string;
  retryable: boolean;
  status: number;
};

export type CostControlResult =
  | {
      ok: true;
      cost: CostStats;
    }
  | {
      ok: false;
      cost: CostStats;
      error: CostControlError;
    };

type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

type CostControlServiceOptions = {
  now?: () => number;
  rateLimit?: RateLimitOptions;
  sessionTurnLimit?: number;
};

type EvaluateInput = {
  config: CostControlConfig;
  request: CostControlRequest;
};

const defaultCostConfig: CostControlConfig = {
  imageTokensPerKeyframe: 850,
  inputUsdPerMillionTokens: 5,
  maxOutputTokens: 512,
  outputUsdPerMillionTokens: 15
};

const defaultRateLimit: RateLimitOptions = {
  limit: 6,
  windowMs: 60_000
};

const defaultSessionTurnLimit = 20;

const envConfigKeys = {
  COST_IMAGE_TOKENS_PER_KEYFRAME: "imageTokensPerKeyframe",
  COST_INPUT_USD_PER_1M_TOKENS: "inputUsdPerMillionTokens",
  COST_OUTPUT_USD_PER_1M_TOKENS: "outputUsdPerMillionTokens",
  MODEL_MAX_OUTPUT_TOKENS: "maxOutputTokens"
} as const;

function parsePositiveNumber(value: string) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return null;
  }

  return numberValue;
}

function roundUsd(value: number) {
  return Number(value.toFixed(6));
}

export function readCostControlConfig(
  env: NodeJS.ProcessEnv
): CostControlConfigResult {
  const config: CostControlConfig = {
    ...defaultCostConfig
  };
  const invalid: CostControlConfigError["invalid"] = [];

  for (const [envName, configKey] of Object.entries(envConfigKeys)) {
    const rawValue = env[envName];

    if (rawValue === undefined || rawValue.trim().length === 0) {
      continue;
    }

    const parsed = parsePositiveNumber(rawValue);

    if (parsed === null) {
      invalid.push({
        name: envName,
        value: rawValue
      });
      continue;
    }

    config[configKey] = parsed;
  }

  if (invalid.length > 0) {
    return {
      error: {
        invalid
      },
      ok: false
    };
  }

  return {
    config,
    ok: true
  };
}

export function estimateConversationCost(input: EstimateInput): CostStats {
  const text = input.text.trim();
  const textTokens = Math.ceil(text.length / 4);
  const imageTokens = input.keyframeCount * input.config.imageTokensPerKeyframe;
  const estimatedInputTokens = textTokens + imageTokens;
  const estimatedOutputTokens = input.config.maxOutputTokens;
  const estimatedUsd = roundUsd(
    (estimatedInputTokens / 1_000_000) *
      input.config.inputUsdPerMillionTokens +
      (estimatedOutputTokens / 1_000_000) *
        input.config.outputUsdPerMillionTokens
  );
  const previous = input.previousSessionCost;

  return {
    request: {
      cloudCallAttempted: false,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedUsd,
      imageBytes: input.imageBytes,
      inputTextChars: text.length,
      keyframeCount: input.keyframeCount
    },
    session: {
      estimatedUsd: roundUsd((previous?.estimatedUsd ?? 0) + estimatedUsd),
      keyframeCount: (previous?.keyframeCount ?? 0) + input.keyframeCount,
      requestCount: (previous?.requestCount ?? 0) + 1
    }
  };
}

export function createCostControlService(
  options: CostControlServiceOptions = {}
) {
  const now = options.now ?? Date.now;
  const rateLimit = options.rateLimit ?? defaultRateLimit;
  const sessionTurnLimit =
    options.sessionTurnLimit ?? defaultSessionTurnLimit;
  let requestWindowStartedAt = now();
  let requestCountInWindow = 0;
  const sessionCosts = new Map<string, SessionCost>();

  function evaluate(input: EvaluateInput): CostControlResult {
    const currentTime = now();

    if (currentTime - requestWindowStartedAt >= rateLimit.windowMs) {
      requestWindowStartedAt = currentTime;
      requestCountInWindow = 0;
    }

    const previousSessionCost = sessionCosts.get(input.request.sessionId);
    const cost = estimateConversationCost({
      config: input.config,
      imageBytes: input.request.imageBytes,
      keyframeCount: input.request.keyframeCount,
      previousSessionCost,
      text: input.request.text
    });

    if (requestCountInWindow >= rateLimit.limit) {
      return {
        cost,
        error: {
          code: "RATE_LIMITED",
          details: {
            limit: rateLimit.limit,
            retryAfterMs:
              rateLimit.windowMs - (currentTime - requestWindowStartedAt),
            windowMs: rateLimit.windowMs
          },
          message: "请求过于频繁，请稍后再试。",
          retryable: true,
          status: 429
        },
        ok: false
      };
    }

    if ((previousSessionCost?.requestCount ?? 0) >= sessionTurnLimit) {
      return {
        cost,
        error: {
          code: "SESSION_TURN_LIMIT_EXCEEDED",
          details: {
            currentTurnCount: previousSessionCost?.requestCount ?? 0,
            limit: sessionTurnLimit,
            sessionId: input.request.sessionId
          },
          message: "当前会话轮次已达上限，请开启新会话。",
          retryable: false,
          status: 429
        },
        ok: false
      };
    }

    requestCountInWindow += 1;
    sessionCosts.set(input.request.sessionId, cost.session);

    return {
      cost,
      ok: true
    };
  }

  return {
    evaluate
  };
}
