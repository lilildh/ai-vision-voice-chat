import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { StrictMode } from "react";
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

type MockSpeechTranscriptionResponse =
  | {
      ok: true;
      text: string;
      model: {
        name: string;
        provider: "openai-compatible";
      };
      timing: {
        modelMs: number;
        totalMs: number;
      };
    }
  | {
      ok: false;
      error: {
        code: string;
        details?: Record<string, unknown>;
        message: string;
        retryable: boolean;
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

const successSpeechTranscription: MockSpeechTranscriptionResponse = {
  model: {
    name: "asr-model",
    provider: "openai-compatible"
  },
  ok: true,
  text: "你看到了什么？",
  timing: {
    modelMs: 123,
    totalMs: 180
  }
};

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

let mockAudioLevels: number[] = [];

class MockAnalyserNode {
  fftSize = 32;
  frequencyBinCount = 16;

  getByteTimeDomainData(array: Uint8Array) {
    const level = mockAudioLevels.length > 0 ? mockAudioLevels.shift() ?? 0 : 0;

    array.fill(Math.min(255, 128 + level));
  }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];

  analyser = new MockAnalyserNode();
  close = vi.fn().mockResolvedValue(undefined);
  createAnalyser = vi.fn(() => this.analyser);
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn()
  }));

  constructor() {
    MockAudioContext.instances.push(this);
  }
}

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);

  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onstart: ((event: Event) => void) | null = null;
  state: "inactive" | "paused" | "recording" = "inactive";
  start = vi.fn(() => {
    this.state = "recording";
    this.onstart?.(new Event("start"));
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.onstop?.(new Event("stop"));
  });

  constructor(
    readonly stream: MediaStream,
    readonly options?: MediaRecorderOptions
  ) {
    MockMediaRecorder.instances.push(this);
  }

  emitData(content = "fake-webm-audio") {
    this.ondataavailable?.({
      data: new Blob([content], { type: this.mimeType })
    });
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
    speechTranscriptionResponse?: MockSpeechTranscriptionResponse;
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
                asrModelName: "runtime-asr-model",
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

      if (requestUrl === "/api/speech-transcription") {
        const responseBody =
          options.speechTranscriptionResponse ?? successSpeechTranscription;

        return {
          ok: responseBody.ok,
          json: async () => responseBody
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
  const audioTrack = { kind: "audio", stop } as unknown as MediaStreamTrack;
  const videoTrack = { kind: "video", stop } as unknown as MediaStreamTrack;
  class MockMediaStream {
    constructor(private readonly tracks: MediaStreamTrack[] = []) {}

    getAudioTracks() {
      return this.tracks.filter((track) => track.kind === "audio");
    }

    getTracks() {
      return this.tracks;
    }
  }
  const mediaStream = new MockMediaStream([
    audioTrack,
    videoTrack
  ]) as unknown as MediaStream;
  const getUserMedia = vi.fn().mockResolvedValue(mediaStream);

  vi.stubGlobal("MediaStream", MockMediaStream);

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia }
  });

  return {
    audioTrack,
    getUserMedia,
    mediaStream,
    stop
  };
}

function mockCloudSpeechInput(
  levels: number[] = [40, 0, 0, 0, 0, 0, 0, 0, 0, 0]
) {
  MockMediaRecorder.instances = [];
  MockMediaRecorder.isTypeSupported.mockReturnValue(true);
  MockAudioContext.instances = [];
  mockAudioLevels = [...levels];

  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("webkitAudioContext", MockAudioContext);

  return {
    AudioContext: MockAudioContext,
    MediaRecorder: MockMediaRecorder
  };
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
  const audioIntervalId = 114 as unknown as ReturnType<typeof window.setInterval>;
  const callbacks: Array<() => void> = [];
  const audioCallbacks: Array<() => void> = [];
  const setIntervalMock = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (timeout === defaultFrameBufferOptions.sampleIntervalMs) {
      callbacks.push(() => {
        if (typeof handler === "function") {
          handler();
        }
      });

      return intervalId;
    }

    if (timeout === audioMonitorIntervalMs) {
      audioCallbacks.push(() => {
        if (typeof handler === "function") {
          handler();
        }
      });

      return audioIntervalId;
    }

    return originalSetInterval(handler, timeout, ...args);
  }) as typeof window.setInterval;
  const clearIntervalMock = ((
    handle?: Parameters<typeof window.clearInterval>[0]
  ) => {
    if (handle === intervalId || handle === audioIntervalId) {
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
    audioCallbacks,
    audioIntervalId,
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
    asrModelName?: string;
    apiKey: string;
    baseUrl: string;
    maxOutputTokens: number;
    modelName: string;
    timeoutMs: number;
  };
}

const voiceTurnSilenceMs = 1800;
const audioMonitorIntervalMs = 200;

function finishCloudSpeechSegment(audioCallbacks: Array<() => void>) {
  act(() => {
    audioCallbacks[0]?.();

    for (
      let elapsed = 0;
      elapsed < voiceTurnSilenceMs;
      elapsed += audioMonitorIntervalMs
    ) {
      audioCallbacks[0]?.();
    }
  });
}

describe("App", () => {
  beforeEach(() => {
    mockApi();
    mockSpeechSynthesis();
  });

  afterEach(() => {
    vi.useRealTimers();
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
      screen.queryByRole("button", { name: "截取关键帧" })
    ).not.toBeInTheDocument();
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
    expect(screen.getByText("视觉:")).toBeInTheDocument();
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

  it("keeps the initial speech state idle under React StrictMode", () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );

    expect(screen.getByText("等待语音输入")).toBeInTheDocument();
    expect(screen.queryByText("语音暂停")).not.toBeInTheDocument();
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
    fireEvent.change(within(dialog).getByLabelText("ASR 模型名称"), {
      target: { value: "runtime-asr-model" }
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
      asrModelName: "runtime-asr-model",
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
    fireEvent.change(within(dialog).getByLabelText("ASR 模型名称"), {
      target: { value: "runtime-asr-model" }
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
    fireEvent.change(within(dialog).getByLabelText("ASR 模型名称"), {
      target: { value: "runtime-asr-model" }
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

  it("starts the camera, microphone, and cloud ASR recorder from one conversation control", async () => {
    mockCloudSpeechInput();
    const { audioTrack, getUserMedia, mediaStream } = mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: true,
        video: true
      });
      expect(screen.getByText("实时画面")).toBeInTheDocument();
      expect(screen.getByLabelText("实时摄像头预览")).toBeInTheDocument();
      expect(screen.getByText("正在监听")).toBeInTheDocument();
    });

    const recorder = MockMediaRecorder.instances[0];

    expect(recorder).toBeDefined();
    expect(recorder.stream).not.toBe(mediaStream);
    expect(recorder.stream.getTracks()).toEqual([audioTrack]);
    expect(recorder.start).toHaveBeenCalledWith(250);
    expect(MockAudioContext.instances).toHaveLength(1);
    expect(MockAudioContext.instances[0].createMediaStreamSource).toHaveBeenCalledWith(
      recorder.stream
    );
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
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });
    expect(screen.queryByAltText("关键帧 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "结束对话" }));

    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("pauses and resumes listening from the same conversation control", async () => {
    mockCloudSpeechInput();
    mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));

    await waitFor(() => {
      expect(screen.getByText("正在监听")).toBeInTheDocument();
    });

    const firstRecorder = MockMediaRecorder.instances[0];

    fireEvent.click(screen.getByRole("button", { name: "暂停监听" }));

    expect(firstRecorder.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByText("语音暂停")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续监听" }));

    await waitFor(() => {
      expect(MockMediaRecorder.instances).toHaveLength(2);
      expect(MockMediaRecorder.instances[1].start).toHaveBeenCalledTimes(1);
      expect(screen.getByText("正在监听")).toBeInTheDocument();
    });
  });

  it("ends the whole conversation only from the red close control", async () => {
    mockCloudSpeechInput();
    const speechSynthesisMock = mockSpeechSynthesis();
    const { stop } = mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    const recorder = MockMediaRecorder.instances[0];

    fireEvent.click(screen.getByRole("button", { name: "结束对话" }));

    expect(stop).toHaveBeenCalledTimes(2);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(speechSynthesisMock.cancel).toHaveBeenCalled();
    expect(screen.getByText("会话尚未开始")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("实时摄像头预览")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开始对话" })
    ).toBeInTheDocument();
  });

  it("shows transcribing status while cloud ASR is collecting a voice segment", async () => {
    const fetchMock = mockApi();
    mockCloudSpeechInput([40, 40]);
    const { audioCallbacks } = mockFrameBufferInterval();
    mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    MockMediaRecorder.instances[0].emitData();

    act(() => {
      audioCallbacks[0]?.();
    });

    await waitFor(() => {
      expect(screen.getByText("转写中")).toBeInTheDocument();
    });
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/speech-transcription")
    ).toBe(false);
  });

  it("waits for silence before submitting final speech transcription, speaks the reply, and resumes listening after TTS ends", async () => {
    const fetchMock = mockApi();
    mockCloudSpeechInput([40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const { audioCallbacks } = mockFrameBufferInterval();
    const speechSynthesisMock = mockSpeechSynthesis();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    MockMediaRecorder.instances[0].emitData();

    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/conversation-turn/stream")
    ).toBe(false);

    act(() => {
      audioCallbacks[0]?.();
    });

    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/conversation-turn/stream")
    ).toBe(false);

    finishCloudSpeechSegment(audioCallbacks);

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
      expect(MockMediaRecorder.instances).toHaveLength(2);
      expect(MockMediaRecorder.instances[1].start).toHaveBeenCalledTimes(1);
      expect(screen.getByText("正在监听")).toBeInTheDocument();
    });

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("uploads recorded audio to cloud ASR before submitting the visual turn", async () => {
    const fetchMock = mockApi();
    mockCloudSpeechInput([40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const { audioCallbacks } = mockFrameBufferInterval();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    MockMediaRecorder.instances[0].emitData("cloud-audio");

    finishCloudSpeechSegment(audioCallbacks);

    await waitFor(() => {
      expect(screen.getByText("我看到一张桌面画面。")).toBeInTheDocument();
    });

    const bodies = getConversationRequestBodies(fetchMock);
    const speechCall = fetchMock.mock.calls.find(
      ([url]) => url === "/api/speech-transcription"
    );

    expect(speechCall?.[1]?.body).toBeInstanceOf(FormData);
    expect((speechCall?.[1]?.body as FormData).get("sessionId")).toBe(
      bodies[0].session.sessionId
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0].text).toBe("你看到了什么？");

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("submits cached low-resolution frames after speech silence without showing frame thumbnails", async () => {
    const fetchMock = mockApi();
    mockCloudSpeechInput([40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const { audioCallbacks, callbacks } = mockFrameBufferInterval();
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
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });
    expect(screen.queryByAltText("关键帧 1")).not.toBeInTheDocument();

    MockMediaRecorder.instances[0].emitData();

    finishCloudSpeechSegment(audioCallbacks);

    await waitFor(() => {
      expect(screen.getByText("我看到一张桌面画面。")).toBeInTheDocument();
    });

    const body = getConversationRequestBody(fetchMock);

    expect(body.text).toBe("你看到了什么？");
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
    mockCloudSpeechInput([40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const { audioCallbacks } = mockFrameBufferInterval();
    const speechSynthesisMock = mockSpeechSynthesis();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    MockMediaRecorder.instances[0].emitData();

    finishCloudSpeechSegment(audioCallbacks);

    await screen.findByText("正在播报");

    fireEvent.click(screen.getByRole("button", { name: "停止播报" }));

    expect(speechSynthesisMock.cancel).toHaveBeenCalled();
    expect(screen.getByText("播报已停止")).toBeInTheDocument();

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("does not submit a visual turn when cloud ASR fails", async () => {
    const fetchMock = mockApi(successResponse, {
      speechTranscriptionResponse: {
        error: {
          code: "MODEL_PROVIDER_ERROR",
          details: {
            providerStatus: 404,
            providerText: "model not found"
          },
          message: "ASR 模型名、接口路径或请求格式不兼容。",
          retryable: true
        },
        ok: false,
        timing: { totalMs: 42 }
      }
    });
    mockCloudSpeechInput([40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const { audioCallbacks } = mockFrameBufferInterval();
    mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    MockMediaRecorder.instances[0].emitData();

    finishCloudSpeechSegment(audioCallbacks);

    await waitFor(() => {
      expect(
        screen.getByText(
          "MODEL_PROVIDER_ERROR：ASR 模型名、接口路径或请求格式不兼容。（provider 404）请检查 Base URL、API Key、ASR 模型名称是否支持 OpenAI-compatible audio/transcriptions。provider 返回：model not found"
        )
      ).toBeInTheDocument();
    });
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/conversation-turn/stream")
    ).toBe(false);
  });

  it("does not submit a visual turn when cloud ASR returns empty text", async () => {
    const fetchMock = mockApi(successResponse, {
      speechTranscriptionResponse: {
        error: {
          code: "EMPTY_TRANSCRIPTION",
          message: "云端语音识别没有返回可用文本，请再说一次。",
          retryable: true
        },
        ok: false,
        timing: { totalMs: 42 }
      }
    });
    mockCloudSpeechInput([40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const { audioCallbacks } = mockFrameBufferInterval();
    mockMediaSession();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    MockMediaRecorder.instances[0].emitData();

    finishCloudSpeechSegment(audioCallbacks);

    await waitFor(() => {
      expect(
        screen.getByText("EMPTY_TRANSCRIPTION：云端语音识别没有返回可用文本，请再说一次。")
      ).toBeInTheDocument();
    });
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/conversation-turn/stream")
    ).toBe(false);
  });

  it("shows a clear unsupported message when cloud audio recording is unavailable", async () => {
    const fetchMock = mockApi();
    mockMediaSession();

    vi.stubGlobal("MediaRecorder", undefined);
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    expect(
      screen.getByText("当前浏览器不支持云端语音录制，请使用文本输入。")
    ).toBeInTheDocument();
    expect(screen.getByText("不支持语音识别")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/speech-transcription")
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/conversation-turn/stream")
    ).toBe(false);
  });

  it("does not expose manual frame capture controls", () => {
    render(<App />);

    expect(
      screen.queryByRole("button", { name: "截取关键帧" })
    ).not.toBeInTheDocument();
  });

  it("captures a hidden buffered low-resolution JPEG frame from the active video element", async () => {
    const { callbacks } = mockFrameBufferInterval();
    mockMediaSession();
    const { drawImage, getContext, toDataUrl } = mockCanvas();

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));

    const video = await screen.findByLabelText("实时摄像头预览");

    await waitFor(() => {
      expect(callbacks).toHaveLength(1);
    });

    act(() => {
      callbacks[0]?.();
    });

    await waitFor(() => {
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
      expect(toDataUrl).toHaveBeenCalledWith("image/jpeg", 0.62);
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
    });
    expect(screen.queryByAltText("关键帧 1")).not.toBeInTheDocument();

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("keeps the hidden keyframe buffer capped at the latest three frames", async () => {
    const { callbacks } = mockFrameBufferInterval();
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

    await waitFor(() => {
      expect(callbacks).toHaveLength(1);
    });

    act(() => {
      callbacks[0]?.();
      callbacks[0]?.();
      callbacks[0]?.();
    });

    await waitFor(() => {
      expect(screen.getByText("3 / 3")).toBeInTheDocument();
    });

    act(() => {
      callbacks[0]?.();
    });

    expect(screen.queryByAltText("关键帧 1")).not.toBeInTheDocument();
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
    expect(screen.getByText("视觉:")).toBeInTheDocument();
    expect(screen.getByText("0 / 3")).toBeInTheDocument();
    expect(screen.getByText("成本:")).toBeInTheDocument();
    expect(screen.getByText("$0.000420")).toBeInTheDocument();
    expect(screen.getByText("延迟:")).toBeInTheDocument();
    expect(screen.getByText("321ms")).toBeInTheDocument();
    expect(toDataUrl).toHaveBeenCalledTimes(1);

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });

  it("submits existing hidden buffered keyframes without auto-capturing extra frames", async () => {
    const fetchMock = mockApi();
    const { callbacks } = mockFrameBufferInterval();
    mockMediaSession();
    const { getContext, toDataUrl } = mockCanvas(
      ["data:image/jpeg;base64,Zmlyc3Q=", "data:image/jpeg;base64,c2Vjb25k"],
      [
        [24, 24, 24, 24],
        [80, 80, 80, 80]
      ]
    );

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开始对话" }));
    await screen.findByLabelText("实时摄像头预览");

    await waitFor(() => {
      expect(callbacks).toHaveLength(1);
    });

    act(() => {
      callbacks[0]?.();
      callbacks[0]?.();
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
    expect(screen.queryByAltText("关键帧 1")).not.toBeInTheDocument();

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
    expect(screen.queryByAltText("关键帧 1")).not.toBeInTheDocument();

    getContext.mockRestore();
    toDataUrl.mockRestore();
  });
});
