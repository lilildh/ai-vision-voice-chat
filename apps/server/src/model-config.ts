export type ResolvedModelConfig = {
  apiKey: string;
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

const defaultModelTimeoutMs = 30_000;
const defaultMaxOutputTokens = 512;

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
    baseUrl: env.MODEL_BASE_URL!.trim(),
    maxOutputTokens: optionalConfig.maxOutputTokens,
    modelName: env.MODEL_NAME!.trim(),
    ok: true,
    timeoutMs: optionalConfig.timeoutMs
  };
}
