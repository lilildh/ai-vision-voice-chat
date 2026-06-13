export type ResolvedModelConfig = {
  apiKey: string;
  asrModelName?: string;
  baseUrl: string;
  maxOutputTokens: number;
  modelName: string;
  timeoutMs: number;
};

type InvalidModelConfigValue = {
  name: string;
  value: string;
};

export type ModelConfig =
  | {
      ok: true;
    } & ResolvedModelConfig
  | {
      invalid: InvalidModelConfigValue[];
      ok: false;
      reason: "invalid";
    }
  | {
      missing: string[];
      ok: false;
      reason: "missing";
    };

const requiredModelEnvVars = [
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_NAME"
] as const;

export const defaultModelTimeoutMs = 30_000;
export const defaultMaxOutputTokens = 512;

const optionalPositiveNumberEnvVars = {
  MODEL_MAX_OUTPUT_TOKENS: "maxOutputTokens",
  MODEL_TIMEOUT_MS: "timeoutMs"
} as const;

function parsePositiveNumber(value: string) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseRuntimePositiveNumber(
  value: unknown,
  defaultValue: number
): number | null {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

type ConfiguredModelConfigStatus<TSource extends "runtime" | "env"> = {
  ok: true;
  source: TSource;
  baseUrl: string;
  hasApiKey: true;
  maxOutputTokens: number;
  modelName: string;
  asrModelName?: string;
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
      invalid: InvalidModelConfigValue[];
    };

export type RuntimeModelConfigResult =
  | {
      ok: true;
      status: RuntimeModelConfigStatus;
    }
  | {
      invalid: string[];
      ok: false;
    };

export function readModelConfig(env: NodeJS.ProcessEnv): ModelConfig {
  const missing = requiredModelEnvVars.filter((key) => {
    const value = env[key];

    return typeof value !== "string" || value.trim().length === 0;
  });

  if (missing.length > 0) {
    return {
      missing,
      ok: false,
      reason: "missing"
    };
  }

  const optionalConfig = {
    maxOutputTokens: defaultMaxOutputTokens,
    timeoutMs: defaultModelTimeoutMs
  };
  const invalid: InvalidModelConfigValue[] = [];

  for (const [envName, configKey] of Object.entries(
    optionalPositiveNumberEnvVars
  )) {
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

    optionalConfig[configKey] = parsed;
  }

  if (invalid.length > 0) {
    return {
      invalid,
      ok: false,
      reason: "invalid"
    };
  }

  return {
    apiKey: env.MODEL_API_KEY!.trim(),
    ...(isNonEmptyString(env.MODEL_ASR_NAME)
      ? { asrModelName: env.MODEL_ASR_NAME.trim() }
      : {}),
    baseUrl: env.MODEL_BASE_URL!.trim(),
    maxOutputTokens: optionalConfig.maxOutputTokens,
    modelName: env.MODEL_NAME!.trim(),
    ok: true,
    timeoutMs: optionalConfig.timeoutMs
  };
}

function toConfiguredStatus<TSource extends "runtime" | "env">(
  source: TSource,
  config: ResolvedModelConfig
): ConfiguredModelConfigStatus<TSource> {
  return {
    ...(config.asrModelName ? { asrModelName: config.asrModelName } : {}),
    baseUrl: config.baseUrl,
    hasApiKey: true,
    maxOutputTokens: config.maxOutputTokens,
    modelName: config.modelName,
    ok: true,
    source,
    timeoutMs: config.timeoutMs
  };
}

function validateRuntimeModelConfig(body: unknown): RuntimeModelConfigResult {
  const invalid: string[] = [];

  if (!isRecord(body)) {
    return {
      invalid: ["baseUrl", "apiKey", "modelName"],
      ok: false
    };
  }

  if (!isNonEmptyString(body.baseUrl)) {
    invalid.push("baseUrl");
  }

  if (!isNonEmptyString(body.apiKey)) {
    invalid.push("apiKey");
  }

  if (!isNonEmptyString(body.modelName)) {
    invalid.push("modelName");
  }

  if (
    body.asrModelName !== undefined &&
    body.asrModelName !== null &&
    body.asrModelName !== "" &&
    !isNonEmptyString(body.asrModelName)
  ) {
    invalid.push("asrModelName");
  }

  const timeoutMs = parseRuntimePositiveNumber(
    body.timeoutMs,
    defaultModelTimeoutMs
  );
  const maxOutputTokens = parseRuntimePositiveNumber(
    body.maxOutputTokens,
    defaultMaxOutputTokens
  );

  if (timeoutMs === null) {
    invalid.push("timeoutMs");
  }

  if (maxOutputTokens === null) {
    invalid.push("maxOutputTokens");
  }

  if (invalid.length > 0) {
    return {
      invalid,
      ok: false
    };
  }

  const config: ResolvedModelConfig = {
    apiKey: String(body.apiKey).trim(),
    ...(isNonEmptyString(body.asrModelName)
      ? { asrModelName: String(body.asrModelName).trim() }
      : {}),
    baseUrl: String(body.baseUrl).trim(),
    maxOutputTokens: maxOutputTokens ?? defaultMaxOutputTokens,
    modelName: String(body.modelName).trim(),
    timeoutMs: timeoutMs ?? defaultModelTimeoutMs
  };

  return {
    ok: true,
    status: toConfiguredStatus("runtime", config)
  };
}

export function createModelConfigService(env: NodeJS.ProcessEnv = process.env) {
  let runtimeConfig: ResolvedModelConfig | null = null;

  function getConfig() {
    if (runtimeConfig) {
      return {
        config: runtimeConfig,
        ok: true as const,
        source: "runtime" as const
      };
    }

    const envConfig = readModelConfig(env);

    if (!envConfig.ok) {
      return envConfig;
    }

    return {
      config: envConfig,
      ok: true as const,
      source: "env" as const
    };
  }

  function getStatus(): ModelConfigStatus {
    const config = getConfig();

    if (config.ok) {
      return toConfiguredStatus(config.source, config.config);
    }

    if (config.reason === "invalid") {
      return {
        hasApiKey: isNonEmptyString(env.MODEL_API_KEY),
        invalid: config.invalid,
        ok: true,
        source: "invalid"
      };
    }

    return {
      hasApiKey: isNonEmptyString(env.MODEL_API_KEY),
      missing: config.missing,
      ok: true,
      source: "missing"
    };
  }

  function setRuntimeConfig(body: unknown): RuntimeModelConfigResult {
    const validation = validateRuntimeModelConfig(body);

    if (!validation.ok) {
      return validation;
    }

    const input = body as Record<string, unknown>;
    runtimeConfig = {
      apiKey: String(input.apiKey).trim(),
      ...(isNonEmptyString(input.asrModelName)
        ? { asrModelName: String(input.asrModelName).trim() }
        : {}),
      baseUrl: String(input.baseUrl).trim(),
      maxOutputTokens: validation.status.maxOutputTokens,
      modelName: String(input.modelName).trim(),
      timeoutMs: validation.status.timeoutMs
    };

    return {
      ok: true,
      status: toConfiguredStatus("runtime", runtimeConfig)
    };
  }

  return {
    getConfig,
    getStatus,
    setRuntimeConfig
  };
}

export type ModelConfigService = ReturnType<typeof createModelConfigService>;
