import express from "express";

import { isMalformedJsonRequestError } from "./app-error-handler";
import { CONVERSATION_BODY_LIMIT } from "./conversation-contract";
import { createCostControlService } from "./cost-control";
import {
  type CostControlService,
  createConversationTurnHandler,
  createConversationTurnStreamHandler
} from "./conversation-route";
import { createZeroCost } from "./conversation-validation";
import {
  createModelConfigService,
  type ModelConfigService
} from "./model-config";
import {
  createOpenAiCompatibleMultimodalProvider,
  type MultimodalProvider
} from "./multimodal-provider";

type CreateAppOptions = {
  costControlService?: CostControlService;
  modelConfigService?: ModelConfigService;
  multimodalProvider?: MultimodalProvider;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const costControlService =
    options.costControlService ?? createCostControlService();
  const modelConfigService =
    options.modelConfigService ?? createModelConfigService();
  const multimodalProvider =
    options.multimodalProvider ?? createOpenAiCompatibleMultimodalProvider();

  app.use(express.json({ limit: CONVERSATION_BODY_LIMIT }));

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "ai-vision-voice-chat-api"
    });
  });
  app.get("/api/model-config", (_request, response) => {
    response.json(modelConfigService.getStatus());
  });
  app.put("/api/model-config", (request, response) => {
    const result = modelConfigService.setRuntimeConfig(request.body);

    if (!result.ok) {
      response.status(400).json({
        error: {
          code: "MODEL_CONFIG_INVALID",
          invalid: result.invalid,
          message: "模型配置无效。"
        },
        ok: false
      });
      return;
    }

    response.json(result.status);
  });

  app.post(
    "/api/conversation-turn",
    createConversationTurnHandler(
      costControlService,
      multimodalProvider,
      modelConfigService
    )
  );
  app.post(
    "/api/conversation-turn/stream",
    createConversationTurnStreamHandler(
      costControlService,
      multimodalProvider,
      modelConfigService
    )
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
