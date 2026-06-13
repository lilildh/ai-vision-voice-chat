import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

type MockConversationResponse =
  | {
      ok: true;
      reply: { role: "assistant"; text: string };
      cost: {
        session: {
          estimatedUsd: number;
          keyframeCount: number;
          requestCount: number;
        };
      };
      timing: { totalMs: number };
    }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
      cost: {
        session: {
          estimatedUsd: number;
          keyframeCount: number;
          requestCount: number;
        };
      };
      timing: { totalMs: number };
    };

const successResponse: MockConversationResponse = {
  cost: {
    session: {
      estimatedUsd: 0.00042,
      keyframeCount: 1,
      requestCount: 1
    }
  },
  ok: true,
  reply: {
    role: "assistant",
    text: "我看到一张桌面画面。"
  },
  timing: {
    totalMs: 321
  }
};

function mockApi(conversationResponse = successResponse) {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const requestUrl = typeof url === "string" ? url : url.toString();

    if (requestUrl === "/api/health") {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          service: "ai-vision-voice-chat-api"
        })
      };
    }

    if (requestUrl === "/api/conversation-turn") {
      return {
        ok: conversationResponse.ok,
        json: async () => conversationResponse
      };
    }

    throw new Error(`unexpected fetch: ${requestUrl}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

function mockMediaSession() {
  const stop = vi.fn();
  const mediaStream = {
    getTracks: () => [{ stop }]
  } as unknown as MediaStream;
  const getUserMedia = vi.fn().mockResolvedValue(mediaStream);

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia }
  });

  return {
    getUserMedia,
    mediaStream,
    stop
  };
}

function mockCanvas(dataUrl = "data:image/jpeg;base64,aW1hZ2U=") {
  const drawImage = vi.fn();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({
      drawImage
    } as unknown as CanvasRenderingContext2D);
  const toDataUrl = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue(dataUrl);

  return {
    drawImage,
    getContext,
    toDataUrl
  };
}

function getConversationRequestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.find(
    ([url]) => url === "/api/conversation-turn"
  );

  expect(call).toBeDefined();

  return JSON.parse(call?.[1]?.body as string) as {
    keyframes: Array<{
      capturedAt: string;
      dataUrl: string;
      height: number;
      id: string;
      width: number;
    }>;
    session: {
      messages: Array<{ role: "user" | "assistant"; text: string }>;
      sessionId: string;
      stats: {
        estimatedUsd: number;
        keyframeCount: number;
        requestCount: number;
      };
    };
    text: string;
  };
}

describe("App", () => {
  beforeEach(() => {
    mockApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the vision text workbench scaffold from live UI state", async () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "AI视觉对话助手" })
    ).toBeInTheDocument();
    expect(screen.getByText("待启动")).toBeInTheDocument();
    expect(screen.getByText("当前会话")).toBeInTheDocument();
    expect(screen.getByText("会话尚未开始")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "文本问题" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "发送文本问题" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "截取关键帧" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开始摄像头" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "停止会话" })
    ).toBeInTheDocument();
    expect(screen.getByText("Frames:")).toBeInTheDocument();
    expect(screen.getByText("0 / 3")).toBeInTheDocument();
    expect(screen.queryByText("等待语音输入")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("后端在线")).toBeInTheDocument();
    });
  });

  it("uses a local camera feed reference asset", () => {
    render(<App />);

    const cameraFeed = screen.getByAltText("桌面摄像头参考画面");

    expect(cameraFeed).toHaveAttribute("src");
    expect(cameraFeed.getAttribute("src")).not.toContain("googleusercontent");
  });

  it("starts a video-only browser media session when the user starts the camera", async () => {
    const { getUserMedia } = mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: false,
        video: true
      });
      expect(screen.getByText("实时画面")).toBeInTheDocument();
      expect(screen.getByLabelText("实时摄像头预览")).toBeInTheDocument();
    });
  });

  it("shows a clear error when capturing before media is active", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "截取关键帧" }));

    expect(screen.getByText("请先启动摄像头，再截取关键帧。")).toBeInTheDocument();
  });

  it("captures a compressed JPEG frame from the active video element", async () => {
    mockMediaSession();
    const { drawImage, getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));

    const video = await screen.findByLabelText("实时摄像头预览");

    fireEvent.click(screen.getByRole("button", { name: "截取关键帧" }));

    await waitFor(() => {
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
      expect(toDataUrl).toHaveBeenCalledWith("image/jpeg", 0.82);
      expect(screen.getByAltText("关键帧 1")).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,aW1hZ2U="
      );
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("keeps the keyframe preview capped at three frames", async () => {
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));

    await screen.findByLabelText("实时摄像头预览");

    const captureButton = screen.getByRole("button", { name: "截取关键帧" });

    fireEvent.click(captureButton);
    fireEvent.click(captureButton);
    fireEvent.click(captureButton);

    await waitFor(() => {
      expect(screen.getByAltText("关键帧 3")).toBeInTheDocument();
    });

    fireEvent.click(captureButton);

    expect(screen.getByText("每轮最多保留 3 张关键帧。")).toBeInTheDocument();
    expect(screen.queryByAltText("关键帧 4")).not.toBeInTheDocument();
    expect(screen.getByText("3 / 3")).toBeInTheDocument();

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("auto-captures one frame when submitting text without existing keyframes", async () => {
    const fetchMock = mockApi();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));
    await screen.findByLabelText("实时摄像头预览");

    fireEvent.change(screen.getByRole("textbox", { name: "文本问题" }), {
      target: { value: "你看到了什么？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送文本问题" }));

    await waitFor(() => {
      expect(screen.getByText("我看到一张桌面画面。")).toBeInTheDocument();
    });

    const body = getConversationRequestBody(fetchMock);

    expect(body.text).toBe("你看到了什么？");
    expect(body.keyframes).toHaveLength(1);
    expect(body.keyframes[0]).toMatchObject({
      dataUrl: "data:image/jpeg;base64,aW1hZ2U=",
      height: 360,
      width: 640
    });
    expect(body.session.sessionId).toEqual(expect.any(String));
    expect(body.session.messages).toEqual([]);
    expect(screen.getByText("Frames:")).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(screen.getByText("Cost:")).toBeInTheDocument();
    expect(screen.getByText("$0.000420")).toBeInTheDocument();
    expect(screen.getByText("Lat:")).toBeInTheDocument();
    expect(screen.getByText("321ms")).toBeInTheDocument();
    expect(toDataUrl).toHaveBeenCalledTimes(1);

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("submits existing keyframes without auto-capturing extra frames", async () => {
    const fetchMock = mockApi();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));
    await screen.findByLabelText("实时摄像头预览");

    const captureButton = screen.getByRole("button", { name: "截取关键帧" });
    fireEvent.click(captureButton);
    fireEvent.click(captureButton);

    await waitFor(() => {
      expect(screen.getByAltText("关键帧 2")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("textbox", { name: "文本问题" }), {
      target: { value: "请结合这两张画面说明。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送文本问题" }));

    await waitFor(() => {
      expect(screen.getByText("我看到一张桌面画面。")).toBeInTheDocument();
    });

    const body = getConversationRequestBody(fetchMock);

    expect(body.keyframes).toHaveLength(2);
    expect(toDataUrl).toHaveBeenCalledTimes(2);

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("shows backend errors while preserving text and keyframes for retry", async () => {
    mockApi({
      cost: {
        session: {
          estimatedUsd: 0,
          keyframeCount: 1,
          requestCount: 1
        }
      },
      error: {
        code: "MODEL_CONFIG_MISSING",
        message: "模型配置缺失，无法调用云端多模态模型。",
        retryable: true
      },
      ok: false,
      timing: {
        totalMs: 19
      }
    });
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));
    await screen.findByLabelText("实时摄像头预览");

    fireEvent.change(screen.getByRole("textbox", { name: "文本问题" }), {
      target: { value: "这是什么？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送文本问题" }));

    await waitFor(() => {
      expect(
        screen.getByText("MODEL_CONFIG_MISSING：模型配置缺失，无法调用云端多模态模型。")
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("textbox", { name: "文本问题" })).toHaveValue(
      "这是什么？"
    );
    expect(screen.getByAltText("关键帧 1")).toBeInTheDocument();

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });
});
