import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

function mockHealthResponse() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        service: "ai-vision-voice-chat-api"
      })
    })
  );
}

describe("App", () => {
  beforeEach(() => {
    mockHealthResponse();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the vision voice workbench scaffold from live UI state", async () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "AI视觉对话助手" })
    ).toBeInTheDocument();
    expect(screen.getByText("待启动")).toBeInTheDocument();
    expect(screen.getByText("当前会话")).toBeInTheDocument();
    expect(screen.getByText("会话尚未开始")).toBeInTheDocument();
    expect(screen.queryByText("你看到了什么？")).not.toBeInTheDocument();
    expect(
      screen.queryByText("我看到了你的桌面上有一杯咖啡，旁边是一个键盘。光线看起来很适合工作。")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "截取关键帧" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开始会话" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "停止会话" })
    ).toBeInTheDocument();
    expect(screen.getByText("Lat:")).toBeInTheDocument();
    expect(screen.getByText("Frames:")).toBeInTheDocument();
    expect(screen.getByText("Cost:")).toBeInTheDocument();

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

  it("starts a real browser media session when the user starts the session", async () => {
    const mediaStream = {
      getTracks: () => [{ stop: vi.fn() }]
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(mediaStream);

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始会话" }));

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
      expect(screen.getByText("实时画面")).toBeInTheDocument();
      expect(screen.getByLabelText("实时摄像头预览")).toBeInTheDocument();
    });
  });

  it("shows a clear error when capturing before media is active", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "截取关键帧" }));

    expect(screen.getByText("请先启动会话，再截取关键帧。")).toBeInTheDocument();
  });

  it("captures a real frame from the active video element", async () => {
    const mediaStream = {
      getTracks: () => [{ stop: vi.fn() }]
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(mediaStream);
    const drawImage = vi.fn();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({
        drawImage
      } as unknown as CanvasRenderingContext2D);
    const toDataUrl = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/png;base64,real-frame");

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始会话" }));

    const video = await screen.findByLabelText("实时摄像头预览");

    fireEvent.click(screen.getByRole("button", { name: "截取关键帧" }));

    await waitFor(() => {
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
      expect(toDataUrl).toHaveBeenCalledWith("image/png");
      expect(screen.getByAltText("关键帧 1")).toHaveAttribute(
        "src",
        "data:image/png;base64,real-frame"
      );
    });

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });
});
