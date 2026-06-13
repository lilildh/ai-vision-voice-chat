export type ConversationMessage = {
  createdAt: string;
  role: "user" | "assistant";
  text: string;
};

export type ConversationSessionStats = {
  estimatedUsd: number;
  keyframeCount: number;
  requestCount: number;
};

export type ConversationTurnRequest = {
  keyframes: Array<{
    capturedAt: string;
    dataUrl: string;
    height: number;
    id: string;
    width: number;
  }>;
  session: {
    messages: ConversationMessage[];
    sessionId: string;
    stats: ConversationSessionStats;
  };
  text: string;
};

export type ConversationTurnResponse =
  | {
      ok: true;
      reply: { role: "assistant"; text: string };
      cost: { session: ConversationSessionStats };
      timing: { totalMs: number };
    }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
      cost: { session: ConversationSessionStats };
      timing: { totalMs: number };
    };

type FetchFn = typeof fetch;

export async function postConversationTurn(
  body: ConversationTurnRequest,
  fetchFn: FetchFn = fetch
) {
  const response = await fetchFn("/api/conversation-turn", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  return (await response.json()) as ConversationTurnResponse;
}
