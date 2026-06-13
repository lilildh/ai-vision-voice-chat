import {
  type CapturedKeyframe,
  maxKeyframeBytes,
  maxKeyframesPerTurn
} from "./frame-capture";

export type BufferedKeyframe = CapturedKeyframe & {
  signature: number[];
};

export type FrameBufferOptions = {
  differenceThreshold: number;
  height: number;
  jpegQuality: number;
  maxBytes: number;
  maxFrames: number;
  sampleIntervalMs: number;
  width: number;
};

type CaptureBufferedKeyframeOptions = Partial<
  Pick<FrameBufferOptions, "height" | "jpegQuality" | "maxBytes" | "width">
> & {
  id: string;
  now?: () => Date;
};

type AppendBufferedKeyframeOptions = Partial<
  Pick<FrameBufferOptions, "differenceThreshold" | "maxFrames">
>;

export const defaultFrameBufferOptions: FrameBufferOptions = {
  differenceThreshold: 8,
  height: 180,
  jpegQuality: 0.62,
  maxBytes: maxKeyframeBytes,
  maxFrames: maxKeyframesPerTurn,
  sampleIntervalMs: 1000,
  width: 320
};

function getBase64ByteLength(dataUrl: string) {
  const payload = dataUrl.split(",")[1] ?? "";
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;

  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  return canvas;
}

function createSignature(imageData: ImageData) {
  const signature: number[] = [];

  for (let index = 0; index < imageData.data.length; index += 4) {
    const red = imageData.data[index] ?? 0;
    const green = imageData.data[index + 1] ?? 0;
    const blue = imageData.data[index + 2] ?? 0;

    signature.push(Math.round((red + green + blue) / 3));
  }

  return signature;
}

function getSignatureDifference(current: number[], next: number[]) {
  const length = Math.min(current.length, next.length);

  if (length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  let totalDifference = 0;

  for (let index = 0; index < length; index += 1) {
    totalDifference += Math.abs((current[index] ?? 0) - (next[index] ?? 0));
  }

  return totalDifference / length;
}

export function captureBufferedKeyframe(
  video: HTMLVideoElement,
  options: CaptureBufferedKeyframeOptions
): BufferedKeyframe {
  const width = options.width ?? defaultFrameBufferOptions.width;
  const height = options.height ?? defaultFrameBufferOptions.height;
  const jpegQuality =
    options.jpegQuality ?? defaultFrameBufferOptions.jpegQuality;
  const maxBytes = options.maxBytes ?? defaultFrameBufferOptions.maxBytes;
  const capturedAt = (options.now ?? (() => new Date()))().toISOString();
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("当前浏览器无法从视频生成关键帧。");
  }

  context.drawImage(video, 0, 0, width, height);

  const imageData = context.getImageData(0, 0, width, height);
  const signature = createSignature(imageData);
  const dataUrl = canvas.toDataURL("image/jpeg", jpegQuality);
  const byteLength = getBase64ByteLength(dataUrl);

  if (byteLength <= 0 || byteLength > maxBytes) {
    throw new Error("关键帧压缩后仍超过大小限制，请调整画面后重试。");
  }

  return {
    byteLength,
    capturedAt,
    dataUrl,
    height,
    id: options.id,
    previewUrl: dataUrl,
    signature,
    width
  };
}

export function appendBufferedKeyframe(
  currentFrames: BufferedKeyframe[],
  nextFrame: BufferedKeyframe,
  options: AppendBufferedKeyframeOptions = {}
) {
  const maxFrames = options.maxFrames ?? defaultFrameBufferOptions.maxFrames;
  const differenceThreshold =
    options.differenceThreshold ??
    defaultFrameBufferOptions.differenceThreshold;
  const previousFrame = currentFrames.at(-1);
  const difference = previousFrame
    ? getSignatureDifference(previousFrame.signature, nextFrame.signature)
    : Number.POSITIVE_INFINITY;

  if (difference < differenceThreshold) {
    return {
      accepted: false,
      difference,
      frames: currentFrames
    };
  }

  return {
    accepted: true,
    difference,
    frames: [...currentFrames, nextFrame].slice(-maxFrames)
  };
}

export function toCapturedKeyframes(
  bufferedKeyframes: BufferedKeyframe[]
): CapturedKeyframe[] {
  return bufferedKeyframes.map(({ signature: _signature, ...keyframe }) => ({
    ...keyframe
  }));
}
