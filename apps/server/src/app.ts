import express from "express";

import { isMalformedJsonRequestError } from "./app-error-handler";
import { CONVERSATION_BODY_LIMIT } from "./conversation-contract";
import { createCostControlService } from "./cost-control";
import {
  type CostControlService,
  createConversationTurnHandler
} from "./conversation-route";
import { createZeroCost } from "./conversation-validation";

type CreateAppOptions = {
  costControlService?: CostControlService;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const costControlService =
    options.costControlService ?? createCostControlService();

  app.use(express.json({ limit: CONVERSATION_BODY_LIMIT }));

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "ai-vision-voice-chat-api"
    });
  });

  app.post(
    "/api/conversation-turn",
    createConversationTurnHandler(costControlService)
  );

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      next: express.NextFunction
    ) => {
      if (!isMalformedJsonRequestError(error)) {
        next(error);
        return;
      }

      response.status(error.status).json({
        cost: createZeroCost(),
        error: {
          code: "MALFORMED_JSON",
          message: "请求体不是合法 JSON，或超过服务端请求体大小限制。",
          retryable: false
        },
        ok: false,
        timing: {
          totalMs: 0
        }
      });
    }
  );

  return app;
}
