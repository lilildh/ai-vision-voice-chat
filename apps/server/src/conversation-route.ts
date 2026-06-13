import { randomUUID } from "node:crypto";

import type { Request, Response } from "express";

import {
  createCostControlService,
  readCostControlConfig
} from "./cost-control";
import type {
  ConversationTurnErrorCode,
  ConversationTurnErrorResponse,
  ConversationTurnSuccessResponse,
  CostStats
} from "./conversation-contract";
import { validateConversationTurnRequest } from "./conversation-validation";
import { readModelConfig } from "./model-config";
import {
  MultimodalProviderError,
  createOpenAiCompatibleMultimodalProvider,
  type MultimodalProvider
} from "./multimodal-provider";

function elapsedMs(startedAt: number) {
  return Date.now() - startedAt;
}

export type CostControlService = ReturnType<typeof createCostControlService>;

type StreamStatusPhase =
  | "validating"
  | "estimating-cost"
  | "checking-model"
  | "calling-model"
  | "streaming-reply"
  | "completed";

function markCloudCallAttempted(cost: CostStats): CostStats {
  return {
    request: {
      ...cost.request,
      cloudCallAttempted: true
    },
    session: {
      ...cost.session
    }
  };
}

function createErrorBody(
  startedAt: number,
  cost: CostStats,
  code: ConversationTurnErrorCode,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>
): ConversationTurnErrorResponse {
  return {
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
}

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
  response
    .status(status)
    .json(createErrorBody(startedAt, cost, code, message, retryable, details));
}

function createSuccessBody(input: {
  completion: Awaited<ReturnType<MultimodalProvider["complete"]>>;
  cost: CostStats;
  sessionId: string;
  startedAt: number;
}): ConversationTurnSuccessResponse {
  return {
    cost: input.cost,
    model: {
      name: input.completion.modelName,
      provider: input.completion.provider,
      ...(input.completion.usage ? { usage: input.completion.usage } : {})
    },
    ok: true,
    reply: {
      role: "assistant",
      text: input.completion.text
    },
    session: {
      sessionId: input.sessionId,
      turnId: randomUUID()
    },
    timing: {
      modelMs: input.completion.modelMs,
      totalMs: elapsedMs(input.startedAt)
    }
  };
}

function startSseResponse(response: Response) {
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
}

function writeSseEvent(
  response: Response,
  event: "status" | "delta" | "complete" | "error",
  data: unknown
) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSseStatus(response: Response, phase: StreamStatusPhase) {
  writeSseEvent(response, "status", { phase });
}

function writeSseError(
  response: Response,
  status: number,
  body: ConversationTurnErrorResponse
) {
  writeSseEvent(response, "error", {
    response: body,
    status
  });
}

export function createConversationTurnHandler(
  costControlService: CostControlService,
  multimodalProvider: MultimodalProvider = createOpenAiCompatibleMultimodalProvider()
) {
  return async function handleConversationTurn(
    request: Request,
    response: Response
  ) {
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
      if (modelConfig.reason === "invalid") {
        sendError(
          response,
          503,
          startedAt,
          costControl.cost,
          "MODEL_CONFIG_INVALID",
          "模型配置无效，无法调用云端多模态模型。",
          false,
          {
            invalid: modelConfig.invalid
          }
        );
        return;
      }

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

    const attemptedCost = markCloudCallAttempted(costControl.cost);

    try {
      const completion = await multimodalProvider.complete({
        config: modelConfig,
        keyframes: validation.keyframes,
        messages: validation.request.session.messages,
        text: validation.request.text
      });

      const body: ConversationTurnSuccessResponse = createSuccessBody({
        completion,
        cost: attemptedCost,
        sessionId: validation.request.session.sessionId,
        startedAt
      });

      response.json(body);
    } catch (error) {
      if (error instanceof MultimodalProviderError) {
        sendError(
          response,
          error.status,
          startedAt,
          attemptedCost,
          error.code,
          error.message,
          error.retryable,
          error.details
        );
        return;
      }

      sendError(
        response,
        502,
        startedAt,
        attemptedCost,
        "MODEL_PROVIDER_ERROR",
        "模型 provider 调用失败。",
        true
      );
    }
  };
}

export function createConversationTurnStreamHandler(
  costControlService: CostControlService,
  multimodalProvider: MultimodalProvider = createOpenAiCompatibleMultimodalProvider()
) {
  return async function handleConversationTurnStream(
    request: Request,
    response: Response
  ) {
    const startedAt = Date.now();

    startSseResponse(response);
    writeSseStatus(response, "validating");

    const validation = validateConversationTurnRequest(request.body);

    if (!validation.ok) {
      writeSseError(
        response,
        validation.error.status,
        createErrorBody(
          startedAt,
          validation.cost,
          validation.error.code,
          validation.error.message,
          validation.error.retryable,
          validation.error.details
        )
      );
      response.end();
      return;
    }

    writeSseStatus(response, "estimating-cost");

    const costConfig = readCostControlConfig(process.env);

    if (!costConfig.ok) {
      writeSseError(
        response,
        503,
        createErrorBody(
          startedAt,
          validation.cost,
          "COST_CONFIG_INVALID",
          "成本估算配置无效，服务端已拒绝本次请求。",
          false,
          {
            invalid: costConfig.error.invalid
          }
        )
      );
      response.end();
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
      writeSseError(
        response,
        costControl.error.status,
        createErrorBody(
          startedAt,
          costControl.cost,
          costControl.error.code,
          costControl.error.message,
          costControl.error.retryable,
          costControl.error.details
        )
      );
      response.end();
      return;
    }

    writeSseStatus(response, "checking-model");

    const modelConfig = readModelConfig(process.env);

    if (!modelConfig.ok) {
      if (modelConfig.reason === "invalid") {
        writeSseError(
          response,
          503,
          createErrorBody(
            startedAt,
            costControl.cost,
            "MODEL_CONFIG_INVALID",
            "模型配置无效，无法调用云端多模态模型。",
            false,
            {
              invalid: modelConfig.invalid
            }
          )
        );
        response.end();
        return;
      }

      writeSseError(
        response,
        503,
        createErrorBody(
          startedAt,
          costControl.cost,
          "MODEL_CONFIG_MISSING",
          "模型配置缺失，无法调用云端多模态模型。",
          true,
          {
            missing: modelConfig.missing
          }
        )
      );
      response.end();
      return;
    }

    const attemptedCost = markCloudCallAttempted(costControl.cost);

    writeSseStatus(response, "calling-model");
    writeSseStatus(response, "streaming-reply");

    try {
      const completion = await multimodalProvider.completeStream(
        {
          config: modelConfig,
          keyframes: validation.keyframes,
          messages: validation.request.session.messages,
          text: validation.request.text
        },
        (delta) => {
          writeSseEvent(response, "delta", { text: delta });
        }
      );

      writeSseStatus(response, "completed");
      writeSseEvent(
        response,
        "complete",
        createSuccessBody({
          completion,
          cost: attemptedCost,
          sessionId: validation.request.session.sessionId,
          startedAt
        })
      );
      response.end();
    } catch (error) {
      if (error instanceof MultimodalProviderError) {
        writeSseError(
          response,
          error.status,
          createErrorBody(
            startedAt,
            attemptedCost,
            error.code,
            error.message,
            error.retryable,
            error.details
          )
        );
        response.end();
        return;
      }

      writeSseError(
        response,
        502,
        createErrorBody(
          startedAt,
          attemptedCost,
          "MODEL_PROVIDER_ERROR",
          "模型 provider 调用失败。",
          true
        )
      );
      response.end();
    }
  };
}

export const handleConversationTurn = createConversationTurnHandler(
  createCostControlService()
);
