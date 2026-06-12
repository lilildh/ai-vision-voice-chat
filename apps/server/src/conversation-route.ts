import type { Request, Response } from "express";

import {
  createCostControlService,
  readCostControlConfig
} from "./cost-control";
import type {
  ConversationTurnErrorCode,
  ConversationTurnErrorResponse,
  CostStats
} from "./conversation-contract";
import { validateConversationTurnRequest } from "./conversation-validation";
import { readModelConfig } from "./model-config";

function elapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

export type CostControlService = ReturnType<typeof createCostControlService>;

function sendError(
  response: Response,
  status: number,
  startedAt: number,
  cost: CostStats,
  code: ConversationTurnErrorCode,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>
) {
  const body: ConversationTurnErrorResponse = {
    cost,
    error: {
      code,
      details,
      message,
      retryable
    },
    ok: false,
    timing: {
      totalMs: elapsedMs(startedAt)
    }
  };

  response.status(status).json(body);
}

export function createConversationTurnHandler(
  costControlService: CostControlService
) {
  return function handleConversationTurn(request: Request, response: Response) {
    const startedAt = Date.now();
    const validation = validateConversationTurnRequest(request.body);

    if (!validation.ok) {
      sendError(
        response,
        validation.error.status,
        startedAt,
        validation.cost,
        validation.error.code,
        validation.error.message,
        validation.error.retryable,
        validation.error.details
      );
      return;
    }

    const costConfig = readCostControlConfig(process.env);

    if (!costConfig.ok) {
      sendError(
        response,
        503,
        startedAt,
        validation.cost,
        "COST_CONFIG_INVALID",
        "成本估算配置无效，服务端已拒绝本次请求。",
        false,
        {
          invalid: costConfig.error.invalid
        }
      );
      return;
    }

    const costControl = costControlService.evaluate({
      config: costConfig.config,
      request: {
        imageBytes: validation.cost.request.imageBytes,
        keyframeCount: validation.request.keyframes.length,
        sessionId: validation.request.session.sessionId,
        text: validation.request.text
      }
    });

    if (!costControl.ok) {
      sendError(
        response,
        costControl.error.status,
        startedAt,
        costControl.cost,
        costControl.error.code,
        costControl.error.message,
        costControl.error.retryable,
        costControl.error.details
      );
      return;
    }

    const modelConfig = readModelConfig(process.env);

    if (!modelConfig.ok) {
      sendError(
        response,
        503,
        startedAt,
        costControl.cost,
        "MODEL_CONFIG_MISSING",
        "模型配置缺失，无法调用云端多模态模型。",
        true,
        {
          missing: modelConfig.missing
        }
      );
      return;
    }

    sendError(
      response,
      501,
      startedAt,
      costControl.cost,
      "MODEL_PROVIDER_NOT_IMPLEMENTED",
      "模型 provider 尚未实现，本次请求未产生云端调用。",
      false,
      {
        provider: "openai-compatible",
        model: modelConfig.modelName
      }
    );
  };
}

export const handleConversationTurn = createConversationTurnHandler(
  createCostControlService()
);
