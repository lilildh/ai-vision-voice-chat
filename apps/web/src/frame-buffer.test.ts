import { describe, expect, it, vi } from "vitest";

import {
  appendBufferedKeyframe,
  captureBufferedKeyframe,
  defaultFrameBufferOptions,
  toCapturedKeyframes,
  type BufferedKeyframe
} from "./frame-buffer";

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

function createImageData(values: number[]) {
  const data = new Uint8ClampedArray(values.length * 4);

  values.forEach((value, index) => {
    const offset = index * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  });

  return {
    data,
    height: 2,
    width: values.length / 2
  } as ImageData;
}

function createBufferedKeyframe(
  id: string,
  signature: number[]
): BufferedKeyframe {
  return {
    byteLength: 5,
    capturedAt: `2026-06-13T01:00:0${id}.000Z`,
    dataUrl: `data:image/jpeg;base64,${id}`,
    height: 180,
    id: `frame-${id}`,
    previewUrl: `data:image/jpeg;base64,${id}`,
    signature,
    width: 320
  };
}

describe("frame buffer", () => {
  it("uses a one-second sampling interval and three-frame cap by default", () => {
    expect(defaultFrameBufferOptions.sampleIntervalMs).toBe(1000);
    expect(defaultFrameBufferOptions.maxFrames).toBe(3);
  });

  it("captures a low-resolution JPEG sample with a visual signature", () => {
    const video = createVideo();
    const drawImage = vi.fn();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({
        drawImage,
        getImageData: vi.fn(() => createImageData([20, 20, 80, 80]))
      } as unknown as CanvasRenderingContext2D);
    const toDataUrl = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/jpeg;base64,aW1hZ2U=");

    const keyframe = captureBufferedKeyframe(video, {
      id: "frame-1",
      now: () => new Date("2026-06-13T01:00:00.000Z")
    });

    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
    expect(toDataUrl).toHaveBeenCalledWith("image/jpeg", 0.62);
    expect(keyframe).toMatchObject({
      byteLength: 5,
      capturedAt: "2026-06-13T01:00:00.000Z",
      dataUrl: "data:image/jpeg;base64,aW1hZ2U=",
      height: 180,
      id: "frame-1",
      previewUrl: "data:image/jpeg;base64,aW1hZ2U=",
      signature: [20, 20, 80, 80],
      width: 320
    });

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("does not append a visually similar automatic sample", () => {
    const first = createBufferedKeyframe("1", [20, 21, 22, 23]);
    const similar = createBufferedKeyframe("2", [21, 22, 23, 24]);

    const update = appendBufferedKeyframe([first], similar, {
      differenceThreshold: 8
    });

    expect(update.accepted).toBe(false);
    expect(update.frames).toEqual([first]);
  });

  it("appends a changed sample and keeps only the latest three frames", () => {
    const first = createBufferedKeyframe("1", [10, 10, 10, 10]);
    const second = createBufferedKeyframe("2", [40, 40, 40, 40]);
    const third = createBufferedKeyframe("3", [80, 80, 80, 80]);
    const fourth = createBufferedKeyframe("4", [120, 120, 120, 120]);

    const update = appendBufferedKeyframe([first, second, third], fourth, {
      differenceThreshold: 8,
      maxFrames: 3
    });

    expect(update.accepted).toBe(true);
    expect(update.frames.map((frame) => frame.id)).toEqual([
      "frame-2",
      "frame-3",
      "frame-4"
    ]);
  });

  it("strips buffer-only signature data before submitting keyframes", () => {
    const frame = createBufferedKeyframe("1", [10, 10, 10, 10]);

    expect(toCapturedKeyframes([frame])).toEqual([
      {
        byteLength: 5,
        capturedAt: "2026-06-13T01:00:01.000Z",
        dataUrl: "data:image/jpeg;base64,1",
        height: 180,
        id: "frame-1",
        previewUrl: "data:image/jpeg;base64,1",
        width: 320
      }
    ]);
  });
});
