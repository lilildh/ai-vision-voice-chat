import { createRequest, createResponse } from "node-mocks-http";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";

describe("GET /api/health", () => {
  it("returns the API health payload", async () => {
    const request = createRequest({
      method: "GET",
      url: "/api/health"
    });
    const response = createResponse();

    createApp().handle(request, response);

    expect(response._getStatusCode()).toBe(200);
    expect(response._getJSONData()).toEqual({
      ok: true,
      service: "ai-vision-voice-chat-api"
    });
  });
});
