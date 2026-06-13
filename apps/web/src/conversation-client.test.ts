import { describe, expect, it, vi } from "vitest";

import { postConversationTurn } from "./conversation-client";

describe("postConversationTurn", () => {
  it("posts the existing conversation-turn contract as JSON", async () => {
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
