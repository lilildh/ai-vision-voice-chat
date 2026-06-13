export const maxKeyframeBytes = 1_000_000;
export const maxKeyframesPerTurn = 3;

export type CapturedKeyframe = {
  byteLength: number;
  capturedAt: string;
  dataUrl: string;
  height: number;
  id: string;
  previewUrl: string;
  width: number;
};

type CaptureOptions = {
  id: string;
  maxBytes?: number;
  now?: () => Date;
};

const fallbackWidth = 640;
const fallbackHeight = 360;
const jpegQuality = 0.82;
const minDimension = 240;
const scaleStep = 0.75;

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

export function captureCompressedKeyframe(
  video: HTMLVideoElement,
  options: CaptureOptions
): CapturedKeyframe {
  const maxBytes = options.maxBytes ?? maxKeyframeBytes;
  const capturedAt = (options.now ?? (() => new Date()))().toISOString();
  let width = video.videoWidth || fallbackWidth;
  let height = video.videoHeight || fallbackHeight;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("当前浏览器无法从视频生成关键帧。");
    }

    context.drawImage(video, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", jpegQuality);
    const byteLength = getBase64ByteLength(dataUrl);

    if (byteLength > 0 && byteLength <= maxBytes) {
      return {
        byteLength,
        capturedAt,
        dataUrl,
        height,
        id: options.id,
        previewUrl: dataUrl,
        width
      };
    }

    const nextWidth = Math.floor(width * scaleStep);
    const nextHeight = Math.floor(height * scaleStep);

    if (nextWidth < minDimension || nextHeight < minDimension) {
      break;
    }

    width = nextWidth;
    height = nextHeight;
  }

  throw new Error("关键帧压缩后仍超过大小限制，请调整画面后重试。");
}
