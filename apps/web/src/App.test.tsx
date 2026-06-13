import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { defaultFrameBufferOptions } from "./frame-buffer";

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
  options: {
    modelConfigPutOk?: boolean;
    modelConfigPutResponse?: unknown;
    streamDeltas?: string[];
  } = {}
) {
  const fetchMock = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
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

      if (requestUrl === "/api/model-config") {
        const method = init?.method ?? "GET";

        if (method === "PUT") {
          return {
            ok: options.modelConfigPutOk ?? true,
            json: async () =>
              options.modelConfigPutResponse ?? {
                baseUrl: "https://runtime-model.example.test/v1",
                hasApiKey: true,
                maxOutputTokens: 640,
                modelName: "runtime-vision-model",
                ok: true,
                source: "runtime",
                timeoutMs: 25000
              }
          };
        }

        return {
          ok: true,
          json: async () => ({
            hasApiKey: false,
            missing: ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME"],
            ok: true,
            source: "missing"
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
    }
  );

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

function createCanvasImageData(values = [40, 40, 40, 40]) {
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

function mockCanvas(
  dataUrl: string | string[] = "data:image/jpeg;base64,aW1hZ2U=",
  signatures: number[][] = [[40, 40, 40, 40]]
) {
  let captureIndex = 0;
  const dataUrls = Array.isArray(dataUrl) ? dataUrl : [dataUrl];
  const drawImage = vi.fn();
  const getImageData = vi.fn(() =>
    createCanvasImageData(
      signatures[Math.min(captureIndex, signatures.length - 1)]
    )
  );
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({
      drawImage,
      getImageData
    } as unknown as CanvasRenderingContext2D);
  const toDataUrl = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockImplementation(() => {
      const nextDataUrl = dataUrls[Math.min(captureIndex, dataUrls.length - 1)];

      captureIndex += 1;

      return nextDataUrl;
    });

  return {
    drawImage,
    getImageData,
    getContext,
    toDataUrl
  };
}

function mockFrameBufferInterval() {
  const originalSetInterval = window.setInterval.bind(window);
  const originalClearInterval = window.clearInterval.bind(window);
  const intervalId = 113 as unknown as ReturnType<typeof window.setInterval>;
  const callbacks: Array<() => void> = [];
  const setIntervalMock = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (timeout !== defaultFrameBufferOptions.sampleIntervalMs) {
      return originalSetInterval(handler, timeout, ...args);
    }

    callbacks.push(() => {
      if (typeof handler === "function") {
        handler();
      }
    });

    return intervalId;
  }) as typeof window.setInterval;
  const clearIntervalMock = ((
    handle?: Parameters<typeof window.clearInterval>[0]
  ) => {
    if (handle === intervalId) {
      return undefined;
    }

    return originalClearInterval(handle);
  }) as typeof window.clearInterval;
  const setIntervalSpy = vi
    .spyOn(window, "setInterval")
    .mockImplementation(setIntervalMock);
  const clearIntervalSpy = vi
    .spyOn(window, "clearInterval")
    .mockImplementation(clearIntervalMock);

  return {
    callbacks,
    clearIntervalSpy,
    intervalId,
    setIntervalSpy
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

function getModelConfigPutBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => url === "/api/model-config" && init?.method === "PUT"
  );

  expect(call).toBeDefined();

  return JSON.parse(call?.[1]?.body as string) as {
    apiKey: string;
    baseUrl: string;
    maxOutputTokens: number;
    modelName: string;
    timeoutMs: number;
  };
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
      screen.getByRole("button", { name: "开始对话" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "结束对话" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "开始摄像头" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "开始语音监听" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Buffer:")).toBeInTheDocument();
    expect(screen.getByText("0 / 3")).toBeInTheDocument();
    expect(screen.getByText("等待语音输入")).toBeInTheDocument();
    expect(screen.getByText("等待播报")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "停止播报" })
    ).not.toBeInTheDocument();

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

  it("opens model settings and stores sanitized runtime config", async () => {
    const fetchMock = mockApi();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    const dialog = await screen.findByRole("dialog", { name: "模型配置" });

    fireEvent.change(within(dialog).getByLabelText("模型服务地址"), {
      target: { value: "https://runtime-model.example.test/v1" }
    });
    fireEvent.change(within(dialog).getByLabelText("模型名称"), {
      target: { value: "runtime-vision-model" }
    });
    fireEvent.change(within(dialog).getByLabelText("API Key"), {
      target: { value: "runtime-secret" }
    });
    fireEvent.change(within(dialog).getByLabelText("超时时间（毫秒）"), {
      target: { value: "25000" }
    });
    fireEvent.change(within(dialog).getByLabelText("最大输出 Token"), {
      target: { value: "640" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存模型配置" }));

    await waitFor(() => {
      expect(within(dialog).getByText("模型配置已保存")).toBeInTheDocument();
    });

    expect(getModelConfigPutBody(fetchMock)).toEqual({
      apiKey: "runtime-secret",
      baseUrl: "https://runtime-model.example.test/v1",
      maxOutputTokens: 640,
      modelName: "runtime-vision-model",
      timeoutMs: 25000
    });
    expect(within(dialog).getByLabelText("API Key")).toHaveValue("");
    expect(within(dialog).getByText("已配置密钥")).toBeInTheDocument();
  });

  it("shows model settings save errors", async () => {
    mockApi(successResponse, {
      modelConfigPutOk: false,
      modelConfigPutResponse: {
        error: {
          code: "MODEL_CONFIG_INVALID",
          invalid: ["apiKey"],
          message: "模型配置无效。"
        },
        ok: false
      }
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    const dialog = await screen.findByRole("dialog", { name: "模型配置" });

    fireEvent.change(within(dialog).getByLabelText("模型服务地址"), {
      target: { value: "https://runtime-model.example.test/v1" }
    });
    fireEvent.change(within(dialog).getByLabelText("模型名称"), {
      target: { value: "runtime-vision-model" }
    });
    fireEvent.change(within(dialog).getByLabelText("API Key"), {
      target: { value: "runtime-secret" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存模型配置" }));

    await waitFor(() => {
      expect(
        within(dialog).getByText("MODEL_CONFIG_INVALID：模型配置无效。")
      ).toBeInTheDocument();
    });
  });

  it("keeps model config out of conversation requests", async () => {
    const fetchMock = mockApi();

    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    const dialog = await screen.findByRole("dialog", { name: "模型配置" });

    fireEvent.change(within(dialog).getByLabelText("模型服务地址"), {
      target: { value: "https://runtime-model.example.test/v1" }
    });
    fireEvent.change(within(dialog).getByLabelText("模型名称"), {
      target: { value: "runtime-vision-model" }
    });
    fireEvent.change(within(dialog).getByLabelText("API Key"), {
      target: { value: "runtime-secret" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存模型配置" }));

    await screen.findByText("模型配置已保存");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭模型配置" }));

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    fireEvent.change(screen.getByRole("textbox", { name: "文本问题" }), {
      target: { value: "你看到了什么？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送文本问题" }));

    await waitFor(() => {
      expect(screen.getByText("我看到一张桌面画面。")).toBeInTheDocument();
    });

    const body = getConversationRequestBody(fetchMock);
    const serializedBody = JSON.stringify(body);

    expect(serializedBody).not.toContain("runtime-secret");
    expect(serializedBody).not.toContain("runtime-model.example.test");
    expect(serializedBody).not.toContain("runtime-vision-model");

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("starts the camera and Web Speech listening from one conversation control", async () => {
    const Recognition = mockSpeechRecognition();
    const { getUserMedia } = mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: false,
        video: true
      });
      expect(screen.getByText("实时画面")).toBeInTheDocument();
      expect(screen.getByLabelText("实时摄像头预览")).toBeInTheDocument();
      expect(screen.getByText("正在监听")).toBeInTheDocument();
    });

    const recognition = Recognition.instances[0];

    expect(recognition).toBeDefined();
    expect(recognition.start).toHaveBeenCalledTimes(1);
    expect(recognition.lang).toBe("zh-CN");
    expect(recognition.interimResults).toBe(true);
    expect(recognition.continuous).toBe(false);
  });

  it("starts automatic frame buffering after the session starts and clears it on end", async () => {
    const { callbacks, clearIntervalSpy, intervalId, setIntervalSpy } =
      mockFrameBufferInterval();
    mockMediaSession();
    const { drawImage, getContext, toDataUrl } = mockCanvas(
      "data:image/jpeg;base64,YXV0bw==",
      [[24, 24, 24, 24]]
    );

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));

    const video = await screen.findByLabelText("实时摄像头预览");

    await waitFor(() => {
      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        defaultFrameBufferOptions.sampleIntervalMs
      );
      expect(callbacks).toHaveLength(1);
    });

    act(() => {
      callbacks[0]?.();
    });

    await waitFor(() => {
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
      expect(toDataUrl).toHaveBeenCalledWith("image/jpeg", 0.62);
      expect(screen.getByAltText("关键帧 1")).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,YXV0bw=="
      );
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "结束对话" }));

    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("pauses and resumes listening from the same conversation control", async () => {
    const Recognition = mockSpeechRecognition();
    mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));

    await waitFor(() => {
      expect(screen.getByText("正在监听")).toBeInTheDocument();
    });

    const firstRecognition = Recognition.instances[0];

    fireEvent.click(screen.getByRole("button", { name: "暂停监听" }));

    expect(firstRecognition.abort).toHaveBeenCalledTimes(1);
    expect(screen.getByText("语音暂停")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续监听" }));

    await waitFor(() => {
      expect(Recognition.instances).toHaveLength(2);
      expect(Recognition.instances[1].start).toHaveBeenCalledTimes(1);
      expect(screen.getByText("正在监听")).toBeInTheDocument();
    });
  });

  it("ends the whole conversation only from the red close control", async () => {
    const Recognition = mockSpeechRecognition();
    const speechSynthesisMock = mockSpeechSynthesis();
    const { stop } = mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    const recognition = Recognition.instances[0];

    fireEvent.click(screen.getByRole("button", { name: "结束对话" }));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(recognition.abort).toHaveBeenCalledTimes(1);
    expect(speechSynthesisMock.cancel).toHaveBeenCalled();
    expect(screen.getByText("会话尚未开始")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("实时摄像头预览")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开始对话" })
    ).toBeInTheDocument();
  });

  it("shows interim transcription while Web Speech recognition is producing partial text", async () => {
    const Recognition = mockSpeechRecognition();
    mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

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

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

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

  it("submits cached low-resolution frames when final speech transcription arrives", async () => {
    const fetchMock = mockApi();
    const Recognition = mockSpeechRecognition();
    const { callbacks } = mockFrameBufferInterval();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas(
      "data:image/jpeg;base64,Y2FjaGVk",
      [[32, 32, 32, 32]]
    );

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    await waitFor(() => {
      expect(callbacks).toHaveLength(1);
    });

    act(() => {
      callbacks[0]?.();
    });

    await waitFor(() => {
      expect(screen.getByAltText("关键帧 1")).toBeInTheDocument();
    });

    Recognition.instances[0].emitResult([
      {
        isFinal: true,
        transcript: "请看最近的画面。"
      }
    ]);

    await waitFor(() => {
      expect(screen.getByText("我看到一张桌面画面。")).toBeInTheDocument();
    });

    const body = getConversationRequestBody(fetchMock);

    expect(body.text).toBe("请看最近的画面。");
    expect(body.keyframes).toEqual([
      expect.objectContaining({
        dataUrl: "data:image/jpeg;base64,Y2FjaGVk",
        height: 180,
        width: 320
      })
    ]);
    expect("signature" in body.keyframes[0]).toBe(false);
    expect(toDataUrl).toHaveBeenCalledTimes(1);
    expect(screen.getByText("0 / 3")).toBeInTheDocument();

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

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
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

  it("renders messages inside a named log and scrolls new replies into view", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });

    const fetchMock = mockApi();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    fireEvent.change(screen.getByRole("textbox", { name: "文本问题" }), {
      target: { value: "第一轮问题" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送文本问题" }));

    await waitFor(() => {
      expect(screen.getByText("我看到一张桌面画面。")).toBeInTheDocument();
    });

    const log = screen.getByRole("log", { name: "对话消息" });

    expect(within(log).getByText("第一轮问题")).toBeInTheDocument();
    expect(within(log).getByText("我看到一张桌面画面。")).toBeInTheDocument();
    expect(getConversationRequestBodies(fetchMock)).toHaveLength(1);
    expect(scrollIntoView).toHaveBeenCalled();

    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView
      });
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("stops current browser speech synthesis and shows stopped status", async () => {
    const Recognition = mockSpeechRecognition();
    const speechSynthesisMock = mockSpeechSynthesis();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

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

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

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

  it("captures a buffered low-resolution JPEG frame from the active video element", async () => {
    mockMediaSession();
    const { drawImage, getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));

    const video = await screen.findByLabelText("实时摄像头预览");

    fireEvent.click(screen.getByRole("button", { name: "截取关键帧" }));

    await waitFor(() => {
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
      expect(toDataUrl).toHaveBeenCalledWith("image/jpeg", 0.62);
      expect(screen.getByAltText("关键帧 1")).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,aW1hZ2U="
      );
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("keeps the keyframe preview capped at the latest three buffered frames", async () => {
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas(
      [
        "data:image/jpeg;base64,Zmlyc3Q=",
        "data:image/jpeg;base64,c2Vjb25k",
        "data:image/jpeg;base64,dGhpcmQ=",
        "data:image/jpeg;base64,Zm91cnRo"
      ],
      [
        [10, 10, 10, 10],
        [40, 40, 40, 40],
        [80, 80, 80, 80],
        [120, 120, 120, 120]
      ]
    );

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));

    await screen.findByLabelText("实时摄像头预览");

    const captureButton = screen.getByRole("button", { name: "截取关键帧" });

    fireEvent.click(captureButton);
    fireEvent.click(captureButton);
    fireEvent.click(captureButton);

    await waitFor(() => {
      expect(screen.getByAltText("关键帧 3")).toBeInTheDocument();
    });

    fireEvent.click(captureButton);

    expect(screen.queryByAltText("关键帧 4")).not.toBeInTheDocument();
    expect(screen.getByAltText("关键帧 1")).toHaveAttribute(
      "src",
      "data:image/jpeg;base64,c2Vjb25k"
    );
    expect(screen.getByText("3 / 3")).toBeInTheDocument();

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("auto-captures one frame when submitting text without existing keyframes", async () => {
    const fetchMock = mockApi();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
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
      height: 180,
      width: 320
    });
    expect(body.session.sessionId).toEqual(expect.any(String));
    expect(body.session.messages).toEqual([]);
    expect(screen.getByText("Buffer:")).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
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

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
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

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
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
