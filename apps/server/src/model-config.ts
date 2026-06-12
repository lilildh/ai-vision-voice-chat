export type ModelConfig =
  | {
      ok: true;
      baseUrl: string;
      apiKey: string;
      modelName: string;
    }
  | {
      ok: false;
      missing: string[];
    };

const requiredModelEnvVars = [
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_NAME"
] as const;

export function readModelConfig(env: NodeJS.ProcessEnv): ModelConfig {
  const missing = requiredModelEnvVars.filter((key) => {
    const value = env[key];

    return typeof value !== "string" || value.trim().length === 0;
  });

  if (missing.length > 0) {
    return {
      missing,
      ok: false
    };
  }

  return {
    apiKey: env.MODEL_API_KEY!.trim(),
    baseUrl: env.MODEL_BASE_URL!.trim(),
    modelName: env.MODEL_NAME!.trim(),
    ok: true
  };
}
