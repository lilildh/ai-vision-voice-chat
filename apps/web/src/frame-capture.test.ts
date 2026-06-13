import { describe, expect, it, vi } from "vitest";

import { captureCompressedKeyframe } from "./frame-capture";

function createVideo(width = 1280, height = 720) {
  const video = document.createElement("video");

  Object.defineProperty(video, "videoWidth", {
    configurable: true,
    value: width
  });
  Object.defineProperty(video, "videoHeight", {
    configurable: true,
    value: height
  });

  return video;
}

describe("captureCompressedKeyframe", () => {
  it("captures the current video frame as a compressed JPEG data URL", () => {
    const video = createVideo();
    const drawImage = vi.fn();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({
        drawImage
      } as unknown as CanvasRenderingContext2D);
    const toDataUrl = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/jpeg;base64,aW1hZ2U=");

    const keyframe = captureCompressedKeyframe(video, {
      id: "frame-1",
      maxBytes: 1_000_000,
      now: () => new Date("2026-06-13T01:00:00.000Z")
    });

    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
    expect(toDataUrl).toHaveBeenCalledWith("image/jpeg", 0.82);
    expect(keyframe).toEqual({
      byteLength: 5,
      capturedAt: "2026-06-13T01:00:00.000Z",
      dataUrl: "data:image/jpeg;base64,aW1hZ2U=",
      height: 720,
      id: "frame-1",
      previewUrl: "data:image/jpeg;base64,aW1hZ2U=",
      width: 1280
    });

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("downscales when the first JPEG exceeds the byte limit", () => {
    const video = createVideo(2000, 1000);
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({
        drawImage: vi.fn()
      } as unknown as CanvasRenderingContext2D);
    const largePayload = "x".repeat(1_600_000);
    const toDataUrl = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValueOnce(`data:image/jpeg;base64,${largePayload}`)
      .mockReturnValueOnce("data:image/jpeg;base64,aW1hZ2U=");

    const keyframe = captureCompressedKeyframe(video, {
      id: "frame-1",
      maxBytes: 1_000_000,
      now: () => new Date("2026-06-13T01:00:00.000Z")
    });

    expect(keyframe.byteLength).toBe(5);
    expect(keyframe.width).toBeLessThan(2000);
    expect(keyframe.height).toBeLessThan(1000);

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });
});
