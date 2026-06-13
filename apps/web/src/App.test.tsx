import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

type MockConversationResponse =
  | {
      ok: true;
      reply: { role: "assistant"; text: string };
      cost: {
        request?: {
          cloudCallAttempted: boolean;
        };
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
        request?: {
          cloudCallAttempted: boolean;
        };
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
    request: {
      cloudCallAttempted: true
    },
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

type MockRecognitionResultInput = {
  isFinal: boolean;
  transcript: string;
};

class MockSpeechRecognition {
  static instances: MockSpeechRecognition[] = [];

  continuous = true;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onend: ((event: Event) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: {
    resultIndex: number;
    results: Array<{
      0: { confidence: number; transcript: string };
      isFinal: boolean;
      length: number;
    }>;
  }) => void) | null = null;
  onstart: ((event: Event) => void) | null = null;
  start = vi.fn(() => {
    this.onstart?.(new Event("start"));
  });
  stop = vi.fn(() => {
    this.onend?.(new Event("end"));
  });
  abort = vi.fn();

  constructor() {
    MockSpeechRecognition.instances.push(this);
  }

  emitResult(results: MockRecognitionResultInput[]) {
    this.onresult?.({
      resultIndex: 0,
      results: results.map((result) => ({
        0: {
          confidence: 0.92,
          transcript: result.transcript
        },
        isFinal: result.isFinal,
        length: 1
      }))
    });
  }

  emitError(error: string) {
    this.onerror?.({ error });
  }
}

class MockSpeechSynthesisUtterance {
  static instances: MockSpeechSynthesisUtterance[] = [];

  lang = "";
  onend: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstart: ((event: Event) => void) | null = null;
  rate = 1;
  text: string;

  constructor(text = "") {
    this.text = text;
    MockSpeechSynthesisUtterance.instances.push(this);
  }
}

function createSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createStreamResponse(chunks: string[]) {
  const encoder = new TextEncoder();

  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    }),
    ok: true
  } as Response;
}

function mockApi(
  conversationResponse = successResponse,
  options: { streamDeltas?: string[] } = {}
) {
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

    if (requestUrl === "/api/conversation-turn/stream") {
      if (!conversationResponse.ok) {
        return createStreamResponse([
          createSse("status", { phase: "validating" }),
          createSse("error", { response: conversationResponse, status: 503 })
        ]);
      }

      const deltas = options.streamDeltas ?? [conversationResponse.reply.text];

      return createStreamResponse([
        createSse("status", { phase: "validating" }),
        createSse("status", { phase: "calling-model" }),
        createSse("status", { phase: "streaming-reply" }),
        ...deltas.map((delta) => createSse("delta", { text: delta })),
        createSse("status", { phase: "completed" }),
        createSse("complete", conversationResponse)
      ]);
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

function mockSpeechRecognition() {
  MockSpeechRecognition.instances = [];
  vi.stubGlobal("SpeechRecognition", MockSpeechRecognition);
  vi.stubGlobal("webkitSpeechRecognition", MockSpeechRecognition);

  return MockSpeechRecognition;
}

function mockSpeechSynthesis() {
  MockSpeechSynthesisUtterance.instances = [];
  const speechSynthesisMock = {
    cancel: vi.fn(),
    speak: vi.fn((utterance: MockSpeechSynthesisUtterance) => {
      utterance.onstart?.(new Event("start"));
    })
  };

  vi.stubGlobal("SpeechSynthesisUtterance", MockSpeechSynthesisUtterance);
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: speechSynthesisMock
  });

  return speechSynthesisMock;
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
    ([url]) => url === "/api/conversation-turn/stream"
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

function getConversationRequestBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([url]) => url === "/api/conversation-turn/stream")
    .map((call) => JSON.parse(call[1]?.body as string)) as ReturnType<
    typeof getConversationRequestBody
  >[];
}

describe("App", () => {
  beforeEach(() => {
    mockApi();
    mockSpeechSynthesis();
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
    expect(screen.getByText("等待语音输入")).toBeInTheDocument();
    expect(screen.getByText("等待播报")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开始语音监听" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "停止播报" })
    ).toBeInTheDocument();

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

  it("starts Web Speech listening from the independent microphone control", async () => {
    const Recognition = mockSpeechRecognition();
    mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));
    await screen.findByLabelText("实时摄像头预览");

    fireEvent.click(screen.getByRole("button", { name: "开始语音监听" }));

    await waitFor(() => {
      expect(screen.getByText("正在监听")).toBeInTheDocument();
    });

    const recognition = Recognition.instances[0];

    expect(recognition).toBeDefined();
    expect(recognition.start).toHaveBeenCalledTimes(1);
    expect(recognition.lang).toBe("zh-CN");
    expect(recognition.interimResults).toBe(true);
    expect(recognition.continuous).toBe(false);
  });

  it("shows interim transcription while Web Speech recognition is producing partial text", async () => {
    const Recognition = mockSpeechRecognition();
    mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));
    await screen.findByLabelText("实时摄像头预览");
    fireEvent.click(screen.getByRole("button", { name: "开始语音监听" }));

    Recognition.instances[0].emitResult([
      {
        isFinal: false,
        transcript: "你看到"
      }
    ]);

    await waitFor(() => {
      expect(screen.getByText("转写中")).toBeInTheDocument();
      expect(screen.getByText("你看到")).toBeInTheDocument();
    });
  });

  it("auto-submits final speech transcription, speaks the reply, and resumes listening after TTS ends", async () => {
    const fetchMock = mockApi();
    const Recognition = mockSpeechRecognition();
    const speechSynthesisMock = mockSpeechSynthesis();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));
    await screen.findByLabelText("实时摄像头预览");
    fireEvent.click(screen.getByRole("button", { name: "开始语音监听" }));

    Recognition.instances[0].emitResult([
      {
        isFinal: true,
        transcript: "你看到了什么？"
      }
    ]);

    await waitFor(() => {
      expect(screen.getByText("我看到一张桌面画面。")).toBeInTheDocument();
      expect(screen.getByText("正在播报")).toBeInTheDocument();
    });

    const body = getConversationRequestBody(fetchMock);

    expect(body.text).toBe("你看到了什么？");
    expect(body.keyframes).toHaveLength(1);
    expect(speechSynthesisMock.cancel).toHaveBeenCalled();
    expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    expect(MockSpeechSynthesisUtterance.instances[0]).toMatchObject({
      lang: "zh-CN",
      text: "我看到一张桌面画面。"
    });

    MockSpeechSynthesisUtterance.instances[0].onend?.(new Event("end"));

    await waitFor(() => {
      expect(Recognition.instances).toHaveLength(2);
      expect(Recognition.instances[1].start).toHaveBeenCalledTimes(1);
      expect(screen.getByText("正在监听")).toBeInTheDocument();
    });

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("shows streaming assistant deltas before completion and speaks only after complete", async () => {
    const speechSynthesisMock = mockSpeechSynthesis();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
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

      if (requestUrl === "/api/conversation-turn/stream") {
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            }
          }),
          ok: true
        } as Response;
      }

      throw new Error(`unexpected fetch: ${requestUrl}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));
    await screen.findByLabelText("实时摄像头预览");

    fireEvent.change(screen.getByRole("textbox", { name: "文本问题" }), {
      target: { value: "你看到了什么？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送文本问题" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === "/api/conversation-turn/stream"
        )
      ).toBe(true);
    });

    streamController.enqueue(
      encoder.encode(createSse("status", { phase: "streaming-reply" }))
    );
    streamController.enqueue(encoder.encode(createSse("delta", { text: "我看到" })));

    await waitFor(() => {
      expect(screen.getByText("我看到")).toBeInTheDocument();
      expect(screen.getAllByText("正在生成回复").length).toBeGreaterThan(0);
    });
    expect(speechSynthesisMock.speak).not.toHaveBeenCalled();

    streamController.enqueue(encoder.encode(createSse("complete", successResponse)));
    streamController.close();

    await waitFor(() => {
      expect(screen.getByText("我看到一张桌面画面。")).toBeInTheDocument();
      expect(speechSynthesisMock.speak).toHaveBeenCalledTimes(1);
    });

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("stops current browser speech synthesis and shows stopped status", async () => {
    const Recognition = mockSpeechRecognition();
    const speechSynthesisMock = mockSpeechSynthesis();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));
    await screen.findByLabelText("实时摄像头预览");
    fireEvent.click(screen.getByRole("button", { name: "开始语音监听" }));

    Recognition.instances[0].emitResult([
      {
        isFinal: true,
        transcript: "请说明画面。"
      }
    ]);

    await screen.findByText("正在播报");

    fireEvent.click(screen.getByRole("button", { name: "停止播报" }));

    expect(speechSynthesisMock.cancel).toHaveBeenCalled();
    expect(screen.getByText("播报已停止")).toBeInTheDocument();

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("shows a clear unsupported message when Web Speech recognition is unavailable", async () => {
    const fetchMock = mockApi();
    mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));
    await screen.findByLabelText("实时摄像头预览");
    fireEvent.click(screen.getByRole("button", { name: "开始语音监听" }));

    expect(
      screen.getByText("当前浏览器不支持语音识别，请使用 Chrome 或继续手动输入。")
    ).toBeInTheDocument();
    expect(screen.getByText("不支持语音识别")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/conversation-turn/stream")
    ).toBe(false);
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
    expect(screen.getByText("0 / 3")).toBeInTheDocument();
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

  it("sends only the latest six short-term context messages", async () => {
    const fetchMock = mockApi();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始摄像头" }));
    await screen.findByLabelText("实时摄像头预览");

    for (let index = 1; index <= 5; index += 1) {
      fireEvent.change(screen.getByRole("textbox", { name: "文本问题" }), {
        target: { value: `问题 ${index}` }
      });
      fireEvent.click(screen.getByRole("button", { name: "发送文本问题" }));

      await waitFor(() => {
        expect(getConversationRequestBodies(fetchMock)).toHaveLength(index);
      });
    }

    const bodies = getConversationRequestBodies(fetchMock);
    const lastBody = bodies[4];

    expect(lastBody.session.messages.map((message) => message.text)).toEqual([
      "问题 2",
      "我看到一张桌面画面。",
      "问题 3",
      "我看到一张桌面画面。",
      "问题 4",
      "我看到一张桌面画面。"
    ]);
    expect(toDataUrl).toHaveBeenCalledTimes(5);

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("shows backend errors while preserving text and keyframes for retry", async () => {
    mockApi({
      cost: {
        request: {
          cloudCallAttempted: false
        },
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
        screen.getByText(
          "MODEL_CONFIG_MISSING：模型配置缺失，无法调用云端多模态模型。"
        )
      ).toBeInTheDocument();
      expect(screen.getByText("未尝试云端调用")).toBeInTheDocument();
    });

    expect(screen.getByRole("textbox", { name: "文本问题" })).toHaveValue(
      "这是什么？"
    );
    expect(screen.getByAltText("关键帧 1")).toBeInTheDocument();

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });
});
