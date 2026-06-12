import {
  type ConversationMessage,
  type ConversationTurnErrorCode,
  type ConversationTurnRequest,
  type CostStats,
  MAX_KEYFRAME_BYTES,
  MAX_KEYFRAMES
} from "./conversation-contract";

type ValidationError = {
  code: ConversationTurnErrorCode;
  message: string;
  retryable: boolean;
  status: number;
  details?: Record<string, unknown>;
};

type ValidatedKeyframe = ConversationTurnRequest["keyframes"][number] & {
  byteLength: number;
};

export type ValidationResult =
  | {
      ok: true;
      request: ConversationTurnRequest;
      keyframes: ValidatedKeyframe[];
      cost: CostStats;
    }
  | {
      ok: false;
      error: ValidationError;
      cost: CostStats;
    };

const allowedImageMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function createEmptyCost(body: unknown, imageBytes = 0): CostStats {
  const text = isRecord(body) && typeof body.text === "string" ? body.text : "";
  const keyframeCount =
    isRecord(body) && Array.isArray(body.keyframes) ? body.keyframes.length : 0;

  return {
    request: {
      cloudCallAttempted: false,
      estimatedInputTokens: Math.ceil(text.trim().length / 4),
      estimatedOutputTokens: 0,
      estimatedUsd: 0,
      imageBytes,
      inputTextChars: text.trim().length,
      keyframeCount
    },
    session: {
      estimatedUsd: 0,
      keyframeCount,
      requestCount: 0
    }
  };
}

function createValidatedCost(
  request: ConversationTurnRequest,
  imageBytes: number
): CostStats {
  const previousStats = request.session.stats;
  const requestEstimatedUsd = 0;

  return {
    request: {
      cloudCallAttempted: false,
      estimatedInputTokens: Math.ceil(request.text.trim().length / 4),
      estimatedOutputTokens: 0,
      estimatedUsd: requestEstimatedUsd,
      imageBytes,
      inputTextChars: request.text.trim().length,
      keyframeCount: request.keyframes.length
    },
    session: {
      estimatedUsd: (previousStats?.estimatedUsd ?? 0) + requestEstimatedUsd,
      keyframeCount:
        (previousStats?.keyframeCount ?? 0) + request.keyframes.length,
      requestCount: (previousStats?.requestCount ?? 0) + 1
    }
  };
}

function invalid(
  body: unknown,
  status: number,
  code: ConversationTurnErrorCode,
  message: string,
  details?: Record<string, unknown>,
  imageBytes = 0
): ValidationResult {
  return {
    cost: createEmptyCost(body, imageBytes),
    error: {
      code,
      details,
      message,
      retryable: false,
      status
    },
    ok: false
  };
}

function validateMessage(value: unknown): value is ConversationMessage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.role === "user" || value.role === "assistant") &&
    isNonEmptyString(value.text) &&
    isValidIsoDate(value.createdAt)
  );
}

function validateSession(value: unknown) {
  if (!isRecord(value) || !isNonEmptyString(value.sessionId)) {
    return false;
  }

  if (!Array.isArray(value.messages) || !value.messages.every(validateMessage)) {
    return false;
  }

  if (value.stats !== undefined) {
    if (!isRecord(value.stats)) {
      return false;
    }

    if (
      !isFiniteNonNegativeNumber(value.stats.requestCount) ||
      !isFiniteNonNegativeNumber(value.stats.keyframeCount) ||
      !isFiniteNonNegativeNumber(value.stats.estimatedUsd)
    ) {
      return false;
    }
  }

  return true;
}

function decodeImageDataUrl(
  dataUrl: string,
  index: number
):
  | { ok: true; byteLength: number }
  | { ok: false; details: Record<string, unknown> } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(
    dataUrl
  );

  if (!match) {
    return {
      details: {
        index,
        reason: "dataUrl must be a base64 image data URL"
      },
      ok: false
    };
  }

  const [, mimeType, base64Payload] = match;

  if (!allowedImageMimeTypes.has(mimeType)) {
    return {
      details: {
        index,
        mimeType,
        reason: "unsupported image MIME type"
      },
      ok: false
    };
  }

  if (base64Payload.length === 0 || base64Payload.length % 4 !== 0) {
    return {
      details: {
        index,
        reason: "invalid base64 payload"
      },
      ok: false
    };
  }

  const byteLength = Buffer.from(base64Payload, "base64").byteLength;

  if (byteLength === 0) {
    return {
      details: {
        index,
        reason: "image payload is empty"
      },
      ok: false
    };
  }

  return {
    byteLength,
    ok: true
  };
}

function validateKeyframe(
  value: unknown,
  index: number
):
  | { ok: true; keyframe: ValidatedKeyframe }
  | { ok: false; details: Record<string, unknown> }
  | { ok: false; tooLarge: true; byteLength: number } {
  if (!isRecord(value)) {
    return {
      details: {
        index,
        reason: "keyframe must be an object"
      },
      ok: false
    };
  }

  if (!isNonEmptyString(value.id) || !isValidIsoDate(value.capturedAt)) {
    return {
      details: {
        index,
        reason: "keyframe id and capturedAt are required"
      },
      ok: false
    };
  }

  if (value.width !== undefined && !isPositiveNumber(value.width)) {
    return {
      details: {
        index,
        reason: "keyframe width must be positive"
      },
      ok: false
    };
  }

  if (value.height !== undefined && !isPositiveNumber(value.height)) {
    return {
      details: {
        index,
        reason: "keyframe height must be positive"
      },
      ok: false
    };
  }

  if (!isNonEmptyString(value.dataUrl)) {
    return {
      details: {
        index,
        reason: "dataUrl must be a non-empty string"
      },
      ok: false
    };
  }

  const dataUrl = value.dataUrl;
  const decoded = decodeImageDataUrl(dataUrl, index);

  if (!decoded.ok) {
    return decoded;
  }

  if (decoded.byteLength > MAX_KEYFRAME_BYTES) {
    return {
      byteLength: decoded.byteLength,
      ok: false,
      tooLarge: true
    };
  }

  return {
    keyframe: {
      capturedAt: value.capturedAt,
      dataUrl,
      height: value.height,
      id: value.id,
      width: value.width,
      byteLength: decoded.byteLength
    },
    ok: true
  };
}

export function validateConversationTurnRequest(body: unknown): ValidationResult {
  if (!isRecord(body)) {
    return invalid(
      body,
      400,
      "INVALID_SESSION_CONTEXT",
      "请求体必须是 JSON 对象。"
    );
  }

  if (!isNonEmptyString(body.text)) {
    return invalid(body, 400, "EMPTY_TEXT", "文本不能为空。");
  }

  if (!Array.isArray(body.keyframes) || body.keyframes.length === 0) {
    return invalid(
      body,
      400,
      "NO_KEYFRAMES",
      "至少需要上传 1 张关键帧。"
    );
  }

  if (body.keyframes.length > MAX_KEYFRAMES) {
    return invalid(
      body,
      400,
      "TOO_MANY_KEYFRAMES",
      `每轮最多上传 ${MAX_KEYFRAMES} 张关键帧。`,
      {
        actual: body.keyframes.length,
        limit: MAX_KEYFRAMES
      }
    );
  }

  if (!validateSession(body.session)) {
    return invalid(
      body,
      400,
      "INVALID_SESSION_CONTEXT",
      "会话上下文缺失或格式不正确。"
    );
  }

  const validatedKeyframes: ValidatedKeyframe[] = [];
  let imageBytes = 0;

  for (const [index, keyframe] of body.keyframes.entries()) {
    const validation = validateKeyframe(keyframe, index);

    if (!validation.ok) {
      if ("tooLarge" in validation) {
        return invalid(
          body,
          413,
          "IMAGE_TOO_LARGE",
          `单张关键帧不能超过 ${MAX_KEYFRAME_BYTES} 字节。`,
          {
            actualBytes: validation.byteLength,
            index,
            limitBytes: MAX_KEYFRAME_BYTES
          },
          imageBytes + validation.byteLength
        );
      }

      return invalid(
        body,
        400,
        "INVALID_KEYFRAME",
        "关键帧格式不正确。",
        validation.details,
        imageBytes
      );
    }

    validatedKeyframes.push(validation.keyframe);
    imageBytes += validation.keyframe.byteLength;
  }

  const request: ConversationTurnRequest = {
    keyframes: body.keyframes as ConversationTurnRequest["keyframes"],
    session: body.session as ConversationTurnRequest["session"],
    text: body.text
  };

  return {
    cost: createValidatedCost(request, imageBytes),
    keyframes: validatedKeyframes,
    ok: true,
    request
  };
}

export function createZeroCost(): CostStats {
  return createEmptyCost({});
}
