import { createRequest, createResponse } from "node-mocks-http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";

const originalModelEnv = {
  MODEL_ASR_NAME: process.env.MODEL_ASR_NAME,
  MODEL_API_KEY: process.env.MODEL_API_KEY,
  MODEL_BASE_URL: process.env.MODEL_BASE_URL,
  MODEL_MAX_OUTPUT_TOKENS: process.env.MODEL_MAX_OUTPUT_TOKENS,
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
  delete process.env.MODEL_ASR_NAME;
  delete process.env.MODEL_API_KEY;
  delete process.env.MODEL_BASE_URL;
  delete process.env.MODEL_MAX_OUTPUT_TOKENS;
  delete process.env.MODEL_NAME;
  delete process.env.MODEL_TIMEOUT_MS;
}

function setModelEnv(overrides: NodeJS.ProcessEnv = {}) {
  process.env.MODEL_API_KEY = "env-key";
  process.env.MODEL_ASR_NAME = "env-asr-model";
  process.env.MODEL_BASE_URL = "https://env-model.example.test/v1";
  process.env.MODEL_NAME = "env-vision-model";

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function requestJson(method: "GET" | "PUT", url: string, body?: unknown) {
  const app = createApp();
  const request = createRequest({
    body,
    headers: {
      "content-type": "application/json"
    },
    method,
    url
  });
  const response = createResponse();

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

describe("model config routes", () => {
  beforeEach(() => {
    clearModelEnv();
  });

  afterEach(() => {
    restoreModelEnv();
  });

  it("reports missing model config without exposing an API key", () => {
    const response = requestJson("GET", "/api/model-config");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      hasApiKey: false,
      missing: ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME"],
      ok: true,
      source: "missing"
    });
    expect(response.body).not.toHaveProperty("apiKey");
  });

  it("reports env model config without exposing the API key", () => {
    setModelEnv({
      MODEL_MAX_OUTPUT_TOKENS: "1024",
      MODEL_TIMEOUT_MS: "45000"
    });

    const response = requestJson("GET", "/api/model-config");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      baseUrl: "https://env-model.example.test/v1",
      asrModelName: "env-asr-model",
      hasApiKey: true,
      maxOutputTokens: 1024,
      modelName: "env-vision-model",
      ok: true,
      source: "env",
      timeoutMs: 45000
    });
    expect(response.body).not.toHaveProperty("apiKey");
  });

  it("reports invalid env model config without exposing the API key", () => {
    setModelEnv({
      MODEL_TIMEOUT_MS: "soon"
    });

    const response = requestJson("GET", "/api/model-config");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      hasApiKey: true,
      invalid: [
        {
          name: "MODEL_TIMEOUT_MS",
          value: "soon"
        }
      ],
      ok: true,
      source: "invalid"
    });
    expect(response.body).not.toHaveProperty("apiKey");
  });

  it("rejects invalid runtime model config payloads", () => {
    const response = requestJson("PUT", "/api/model-config", {
      apiKey: "   ",
      baseUrl: "",
      maxOutputTokens: -1,
      modelName: "vision-model",
      timeoutMs: 0
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "MODEL_CONFIG_INVALID",
        invalid: ["baseUrl", "apiKey", "timeoutMs", "maxOutputTokens"],
        message: "模型配置无效。"
      },
      ok: false
    });
  });

  it("stores runtime model config in memory and returns only sanitized state", () => {
    const app = createApp();
    app.use((_request, fallbackResponse) => {
      fallbackResponse.status(404).json({
        error: {
          code: "NOT_FOUND"
        },
        ok: false
      });
    });
    const putRequest = createRequest({
      body: {
        apiKey: "runtime-secret",
        asrModelName: "runtime-asr-model",
        baseUrl: "https://runtime-model.example.test/v1",
        maxOutputTokens: 640,
        modelName: "runtime-vision-model",
        timeoutMs: 25000
      },
      headers: {
        "content-type": "application/json"
      },
      method: "PUT",
      url: "/api/model-config"
    });
    const putResponse = createResponse();

    app.handle(putRequest, putResponse);

    expect(putResponse._getStatusCode()).toBe(200);
    expect(putResponse._getJSONData()).toMatchObject({
      baseUrl: "https://runtime-model.example.test/v1",
      asrModelName: "runtime-asr-model",
      hasApiKey: true,
      maxOutputTokens: 640,
      modelName: "runtime-vision-model",
      ok: true,
      source: "runtime",
      timeoutMs: 25000
    });
    expect(putResponse._getJSONData()).not.toHaveProperty("apiKey");

    const getRequest = createRequest({
      method: "GET",
      url: "/api/model-config"
    });
    const getResponse = createResponse();

    app.handle(getRequest, getResponse);

    expect(getResponse._getStatusCode()).toBe(200);
    expect(getResponse._getJSONData()).toMatchObject({
      baseUrl: "https://runtime-model.example.test/v1",
      asrModelName: "runtime-asr-model",
      hasApiKey: true,
      maxOutputTokens: 640,
      modelName: "runtime-vision-model",
      ok: true,
      source: "runtime",
      timeoutMs: 25000
    });
    expect(getResponse._getJSONData()).not.toHaveProperty("apiKey");
  });
});
