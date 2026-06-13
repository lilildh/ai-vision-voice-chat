import {
  type FormEvent,
  type UIEvent,
  useEffect,
  useRef,
  useState
} from "react";

import "./App.css";
import cameraFeedUrl from "./assets/camera-feed-reference.png";
import {
  type ConversationMessage,
  type ConversationSessionStats,
  type ConversationTurnResponse,
  type ConversationTurnStatusPhase,
  type ModelConfigStatus,
  getModelConfig,
  putModelConfig,
  streamConversationTurn
} from "./conversation-client";
import { type CapturedKeyframe, maxKeyframesPerTurn } from "./frame-capture";
import {
  type BufferedKeyframe,
  appendBufferedKeyframe,
  captureBufferedKeyframe,
  defaultFrameBufferOptions,
  toCapturedKeyframes
} from "./frame-buffer";

type BackendStatus = "checking" | "online" | "offline";
type SessionStatus = "idle" | "starting" | "active" | "error";
type SpeechStatus =
  | "idle"
  | "unsupported"
  | "listening"
  | "transcribing"
  | "paused"
  | "error";
type TtsStatus = "idle" | "speaking" | "stopped" | "unsupported" | "error";
type SubmitSource = "text" | "voice";
type TurnStatus =
  | "idle"
  | "capturing-frame"
  | "sending"
  | ConversationTurnStatusPhase
  | "error";

type HealthResponse = {
  ok: boolean;
  service: string;
};

type ModelConfigFormState = {
  apiKey: string;
  baseUrl: string;
  maxOutputTokens: string;
  modelName: string;
  timeoutMs: string;
};

const serviceName = "ai-vision-voice-chat-api";
const initialStats: ConversationSessionStats = {
  estimatedUsd: 0,
  keyframeCount: 0,
  requestCount: 0
};
const initialModelConfigForm: ModelConfigFormState = {
  apiKey: "",
  baseUrl: "",
  maxOutputTokens: "512",
  modelName: "",
  timeoutMs: "30000"
};

function stopMediaStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => {
    track.stop();
  });
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "无法访问摄像头，请检查浏览器权限。";
}

function createSessionId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatUsd(value: number) {
  return `$${value.toFixed(6)}`;
}

function getCloudCallLabel(response: ConversationTurnResponse) {
  return response.cost.request?.cloudCallAttempted
    ? "已尝试云端调用"
    : "未尝试云端调用";
}

function toRequestKeyframe(keyframe: CapturedKeyframe) {
  return {
    capturedAt: keyframe.capturedAt,
    dataUrl: keyframe.dataUrl,
    height: keyframe.height,
    id: keyframe.id,
    width: keyframe.width
  };
}

function getSpeechRecognitionConstructor() {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function getModelConfigSourceLabel(status: ModelConfigStatus | null) {
  if (!status) {
    return "未读取";
  }

  if (status.source === "runtime") {
    return "页面临时配置";
  }

  if (status.source === "env") {
    return "环境变量配置";
  }

  if (status.source === "invalid") {
    return "配置无效";
  }

  return "配置缺失";
}

function createFormFromModelConfigStatus(
  status: ModelConfigStatus
): ModelConfigFormState {
  if (status.source === "runtime" || status.source === "env") {
    return {
      apiKey: "",
      baseUrl: status.baseUrl,
      maxOutputTokens: String(status.maxOutputTokens),
      modelName: status.modelName,
      timeoutMs: String(status.timeoutMs)
    };
  }

  return initialModelConfigForm;
}

export function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const messageBottomRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const shouldResumeListeningRef = useRef(false);
  const isRecognitionActiveRef = useRef(false);
  const isSubmittingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const frameBufferIntervalRef = useRef<number | null>(null);
  const keyframesRef = useRef<BufferedKeyframe[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const stoppedMediaStreamsRef = useRef<WeakSet<MediaStream>>(new WeakSet());
  const messagesRef = useRef<ConversationMessage[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const sessionStatsRef = useRef<ConversationSessionStats>(initialStats);
  const sessionStatusRef = useRef<SessionStatus>("idle");
  const speechStatusRef = useRef<SpeechStatus>("idle");
  const [backendStatus, setBackendStatus] =
    useState<BackendStatus>("checking");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [keyframes, setKeyframes] = useState<BufferedKeyframe[]>([]);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStats, setSessionStats] =
    useState<ConversationSessionStats>(initialStats);
  const [sessionStartedAt, setSessionStartedAt] = useState<Date | null>(null);
  const [promptText, setPromptText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCloudCallLabel, setErrorCloudCallLabel] = useState<string | null>(
    null
  );
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle");
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>("idle");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [lastTranscript, setLastTranscript] = useState("");
  const [pendingAssistantText, setPendingAssistantText] = useState("");
  const [turnStatus, setTurnStatus] = useState<TurnStatus>("idle");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isModelConfigSaving, setIsModelConfigSaving] = useState(false);
  const [modelConfigForm, setModelConfigForm] = useState<ModelConfigFormState>(
    initialModelConfigForm
  );
  const [modelConfigStatus, setModelConfigStatus] =
    useState<ModelConfigStatus | null>(null);
  const [modelConfigMessage, setModelConfigMessage] = useState<string | null>(
    null
  );
  const [modelConfigError, setModelConfigError] = useState<string | null>(null);

  const isSessionActive = sessionStatus === "active";
  const isSpeechListening =
    speechStatus === "listening" || speechStatus === "transcribing";
  const cameraStatus =
    sessionStatus === "starting"
      ? "权限检查中"
      : isSessionActive
        ? "实时画面"
        : sessionStatus === "error"
          ? "摄像头不可用"
          : "待启动";
  const streamStatus = isSessionActive ? "LIVE" : "IDLE";
  const mediaSourceLabel = isSessionActive ? "浏览器媒体流" : "本地参考图";
  const backendStatusLabel =
    backendStatus === "checking"
      ? "检测中"
      : backendStatus === "online"
        ? "后端在线"
        : "后端不可用";
  const startedAtLabel = sessionStartedAt
    ? sessionStartedAt.toLocaleTimeString("zh-CN", { hour12: false })
    : "未连接";
  const latencyLabel = latencyMs === null ? "--" : `${latencyMs}ms`;
  const frameCountLabel = `${keyframes.length} / ${maxKeyframesPerTurn}`;
  const modelCostLabel = formatUsd(sessionStats.estimatedUsd);
  const isConversationBusy =
    sessionStatus === "starting" || isSubmitting || ttsStatus === "speaking";
  const conversationControlLabel = isConversationBusy
    ? "处理中"
    : !isSessionActive
      ? "开始对话"
      : isSpeechListening
        ? "暂停监听"
        : "继续监听";
  const conversationControlIcon = isConversationBusy
    ? "icon-video"
    : !isSessionActive
      ? "icon-video"
      : isSpeechListening
        ? "icon-pause"
        : "icon-play";
  const speechStatusLabel =
    speechStatus === "unsupported"
      ? "不支持语音识别"
      : speechStatus === "listening"
        ? "正在监听"
        : speechStatus === "transcribing"
          ? "转写中"
          : speechStatus === "paused"
            ? "语音暂停"
            : speechStatus === "error"
              ? "语音识别出错"
              : "等待语音输入";
  const ttsStatusLabel =
    ttsStatus === "speaking"
      ? "正在播报"
      : ttsStatus === "stopped"
        ? "播报已停止"
        : ttsStatus === "unsupported"
          ? "不支持语音播报"
          : ttsStatus === "error"
            ? "语音播报出错"
            : "等待播报";
  const transcriptPreview = interimTranscript || lastTranscript || "暂无转写";
  const turnStatusLabel =
    turnStatus === "capturing-frame"
      ? "正在截取关键帧"
      : turnStatus === "sending"
        ? "正在发送请求"
        : turnStatus === "validating"
          ? "后端校验中"
          : turnStatus === "estimating-cost"
            ? "正在估算成本"
            : turnStatus === "checking-model"
              ? "检查模型配置"
              : turnStatus === "calling-model"
                ? "连接模型"
                : turnStatus === "streaming-reply"
                  ? "正在生成回复"
                  : turnStatus === "completed"
                    ? "回复完成"
                    : turnStatus === "error"
                      ? "请求失败"
                      : "等待提问";
  const modelConfigSourceLabel = getModelConfigSourceLabel(modelConfigStatus);
  const modelApiKeyLabel = modelConfigStatus?.hasApiKey
    ? "已配置密钥"
    : "未配置密钥";

  function setSpeechStatusState(nextStatus: SpeechStatus) {
    speechStatusRef.current = nextStatus;
    setSpeechStatus(nextStatus);
  }

  function stopTrackedMediaStream(stream: MediaStream | null) {
    if (!stream || stoppedMediaStreamsRef.current.has(stream)) {
      return;
    }

    stoppedMediaStreamsRef.current.add(stream);
    stopMediaStream(stream);
  }

  function stopFrameBuffering() {
    if (frameBufferIntervalRef.current === null) {
      return;
    }

    window.clearInterval(frameBufferIntervalRef.current);
    frameBufferIntervalRef.current = null;
  }

  function setKeyframeBuffer(nextKeyframes: BufferedKeyframe[]) {
    keyframesRef.current = nextKeyframes;
    setKeyframes(nextKeyframes);
  }

  function appendKeyframeToBuffer(
    keyframe: BufferedKeyframe,
    options: { force?: boolean } = {}
  ) {
    if (options.force) {
      setKeyframeBuffer(
        [...keyframesRef.current, keyframe].slice(
          -defaultFrameBufferOptions.maxFrames
        )
      );
      return;
    }

    const update = appendBufferedKeyframe(keyframesRef.current, keyframe);

    if (update.accepted) {
      setKeyframeBuffer(update.frames);
    }
  }

  function sampleBufferedFrame() {
    if (
      sessionStatusRef.current !== "active" ||
      mediaStreamRef.current === null
    ) {
      return;
    }

    const video = videoRef.current;

    if (!video) {
      return;
    }

    try {
      appendKeyframeToBuffer(
        captureBufferedKeyframe(video, {
          id: `frame-${Date.now()}-${keyframesRef.current.length + 1}`
        })
      );
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }

  function openSettings() {
    setIsSettingsOpen(true);
    setModelConfigError(null);
    setModelConfigMessage(null);
  }

  function updateModelConfigField(
    field: keyof ModelConfigFormState,
    value: string
  ) {
    setModelConfigForm((currentForm) => ({
      ...currentForm,
      [field]: value
    }));
    setModelConfigError(null);
    setModelConfigMessage(null);
  }

  function handleChatScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;

    shouldStickToBottomRef.current = distanceFromBottom < 80;
  }

  async function saveModelConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsModelConfigSaving(true);
    setModelConfigError(null);
    setModelConfigMessage(null);

    const timeoutMs = Number(modelConfigForm.timeoutMs);
    const maxOutputTokens = Number(modelConfigForm.maxOutputTokens);

    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      !Number.isFinite(maxOutputTokens) ||
      maxOutputTokens <= 0
    ) {
      setIsModelConfigSaving(false);
      setModelConfigError("MODEL_CONFIG_INVALID：模型配置无效。");
      return;
    }

    try {
      const status = await putModelConfig({
        apiKey: modelConfigForm.apiKey,
        baseUrl: modelConfigForm.baseUrl,
        maxOutputTokens,
        modelName: modelConfigForm.modelName,
        timeoutMs
      });

      setModelConfigStatus(status);
      setModelConfigForm({
        apiKey: "",
        baseUrl: status.baseUrl,
        maxOutputTokens: String(status.maxOutputTokens),
        modelName: status.modelName,
        timeoutMs: String(status.timeoutMs)
      });
      setModelConfigMessage("模型配置已保存");
    } catch (error) {
      setModelConfigError(getErrorMessage(error));
    } finally {
      setIsModelConfigSaving(false);
    }
  }

  useEffect(() => {
    let isMounted = true;
    const startedAt = Date.now();

    async function checkBackendHealth() {
      try {
        const response = await fetch("/api/health");
        const body = (await response.json()) as HealthResponse;

        if (!response.ok || !body.ok || body.service !== serviceName) {
          throw new Error("后端健康检查返回异常。");
        }

        if (isMounted) {
          setBackendStatus("online");
          setLatencyMs(Date.now() - startedAt);
        }
      } catch {
        if (isMounted) {
          setBackendStatus("offline");
          setLatencyMs(null);
        }
      }
    }

    void checkBackendHealth();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    let isMounted = true;

    async function loadModelConfig() {
      try {
        const status = await getModelConfig();

        if (!isMounted) {
          return;
        }

        setModelConfigStatus(status);
        setModelConfigForm(createFormFromModelConfigStatus(status));
        setModelConfigError(null);
      } catch (error) {
        if (isMounted) {
          setModelConfigError(getErrorMessage(error));
        }
      }
    }

    void loadModelConfig();

    return () => {
      isMounted = false;
    };
  }, [isSettingsOpen]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = mediaStream;
    }
  }, [mediaStream]);

  useEffect(() => {
    if (sessionStatus !== "active" || mediaStream === null) {
      stopFrameBuffering();
      return;
    }

    stopFrameBuffering();
    frameBufferIntervalRef.current = window.setInterval(
      sampleBufferedFrame,
      defaultFrameBufferOptions.sampleIntervalMs
    );

    return () => {
      stopFrameBuffering();
    };
  }, [mediaStream, sessionStatus]);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return;
    }

    const scrollIntoView = messageBottomRef.current?.scrollIntoView;

    if (typeof scrollIntoView === "function") {
      scrollIntoView.call(messageBottomRef.current, {
        block: "end"
      });
    }
  }, [messages, pendingAssistantText]);

  useEffect(() => {
    keyframesRef.current = keyframes;
  }, [keyframes]);

  useEffect(() => {
    mediaStreamRef.current = mediaStream;
  }, [mediaStream]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    sessionStatsRef.current = sessionStats;
  }, [sessionStats]);

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

  useEffect(() => {
    return () => {
      stopTrackedMediaStream(mediaStream);
    };
  }, [mediaStream]);

  useEffect(() => {
    return () => {
      stopFrameBuffering();
      stopVoiceRecognition({ clearAutoResume: true });
      window.speechSynthesis?.cancel();
    };
  }, []);

  async function startSession({
    startListening = false
  }: {
    startListening?: boolean;
  } = {}) {
    setErrorMessage(null);
    setErrorCloudCallLabel(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      sessionStatusRef.current = "error";
      setSessionStatus("error");
      setErrorMessage("当前浏览器不支持摄像头访问。");
      return;
    }

    sessionStatusRef.current = "starting";
    setSessionStatus("starting");

    try {
      stopFrameBuffering();
      stopTrackedMediaStream(mediaStreamRef.current ?? mediaStream);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: true
      });
      const nextSessionId = createSessionId();

      mediaStreamRef.current = stream;
      keyframesRef.current = [];
      messagesRef.current = [];
      sessionStatsRef.current = initialStats;
      sessionIdRef.current = nextSessionId;
      sessionStatusRef.current = "active";
      setMediaStream(stream);
      setKeyframes([]);
      setMessages([]);
      setPromptText("");
      setSessionStats(initialStats);
      setSessionId(nextSessionId);
      setSessionStartedAt(new Date());
      setSessionStatus("active");
      setSpeechStatusState("idle");
      setTtsStatus("idle");
      setTurnStatus("idle");
      setInterimTranscript("");
      setLastTranscript("");
      setPendingAssistantText("");
      shouldResumeListeningRef.current = false;

      if (startListening) {
        startVoiceListening();
      }
    } catch (error) {
      mediaStreamRef.current = null;
      sessionIdRef.current = null;
      sessionStatusRef.current = "error";
      setMediaStream(null);
      setSessionId(null);
      setSessionStartedAt(null);
      setSessionStatus("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  function stopSession() {
    stopVoiceRecognition({ clearAutoResume: true });
    stopFrameBuffering();
    window.speechSynthesis?.cancel();
    isSpeakingRef.current = false;
    stopTrackedMediaStream(mediaStreamRef.current ?? mediaStream);
    mediaStreamRef.current = null;
    keyframesRef.current = [];
    messagesRef.current = [];
    sessionStatsRef.current = initialStats;
    sessionIdRef.current = null;
    sessionStatusRef.current = "idle";
    setMediaStream(null);
    setKeyframes([]);
    setMessages([]);
    setPromptText("");
    setSessionStats(initialStats);
    setSessionId(null);
    setSessionStartedAt(null);
    setSessionStatus("idle");
    setSpeechStatusState("idle");
    setTtsStatus("idle");
    setTurnStatus("idle");
    setInterimTranscript("");
    setLastTranscript("");
    setPendingAssistantText("");
    setErrorMessage(null);
    setErrorCloudCallLabel(null);
  }

  function captureFrame(frameIndex: number) {
    if (
      sessionStatusRef.current !== "active" ||
      mediaStreamRef.current === null
    ) {
      throw new Error("请先启动摄像头，再截取关键帧。");
    }

    const video = videoRef.current;

    if (!video) {
      throw new Error("实时视频尚未挂载，请稍后再试。");
    }

    return captureBufferedKeyframe(video, {
      id: `frame-${Date.now()}-${frameIndex + 1}`
    });
  }

  function stopVoiceRecognition({
    clearAutoResume = true
  }: {
    clearAutoResume?: boolean;
  } = {}) {
    if (clearAutoResume) {
      shouldResumeListeningRef.current = false;
    }

    const recognition = recognitionRef.current;

    if (recognition) {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.onstart = null;
      recognition.abort();
    }

    recognitionRef.current = null;
    isRecognitionActiveRef.current = false;

    if (speechStatusRef.current !== "unsupported") {
      setSpeechStatusState("paused");
    }
  }

  function startVoiceListening() {
    setErrorMessage(null);

    if (
      sessionStatusRef.current !== "active" ||
      mediaStreamRef.current === null
    ) {
      shouldResumeListeningRef.current = false;
      setErrorMessage("请先启动摄像头，再开始语音监听。");
      setSpeechStatusState("error");
      return;
    }

    const SpeechRecognitionConstructor = getSpeechRecognitionConstructor();

    if (!SpeechRecognitionConstructor) {
      shouldResumeListeningRef.current = false;
      setSpeechStatusState("unsupported");
      setErrorMessage("当前浏览器不支持语音识别，请使用 Chrome 或继续手动输入。");
      return;
    }

    shouldResumeListeningRef.current = true;

    if (isSubmittingRef.current || isSpeakingRef.current) {
      setSpeechStatusState("paused");
      return;
    }

    if (isRecognitionActiveRef.current) {
      return;
    }

    stopVoiceRecognition({ clearAutoResume: false });

    const recognition = new SpeechRecognitionConstructor();

    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "zh-CN";
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isRecognitionActiveRef.current = true;
      setSpeechStatusState("listening");
    };

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript ?? "";

        if (result.isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }

      const trimmedInterimText = interimText.trim();
      const trimmedFinalText = finalText.trim();

      if (trimmedInterimText) {
        setInterimTranscript(trimmedInterimText);
        setSpeechStatusState("transcribing");
      }

      if (trimmedFinalText) {
        setLastTranscript(trimmedFinalText);
        setInterimTranscript("");
        setPromptText(trimmedFinalText);
        setSpeechStatusState("transcribing");
        isRecognitionActiveRef.current = false;
        void submitQuestionText(trimmedFinalText, "voice");
      }
    };

    recognition.onerror = (event) => {
      isRecognitionActiveRef.current = false;
      shouldResumeListeningRef.current = false;
      setSpeechStatusState("error");
      setErrorMessage(`语音识别失败：${event.error}。请重试或使用文本输入。`);
    };

    recognition.onend = () => {
      isRecognitionActiveRef.current = false;

      if (
        shouldResumeListeningRef.current &&
        !isSubmittingRef.current &&
        !isSpeakingRef.current &&
        sessionStatusRef.current === "active"
      ) {
        startVoiceListening();
        return;
      }

      if (
        speechStatusRef.current !== "unsupported" &&
        speechStatusRef.current !== "error"
      ) {
        setSpeechStatusState("paused");
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
      isRecognitionActiveRef.current = true;
      setSpeechStatusState("listening");
    } catch (error) {
      isRecognitionActiveRef.current = false;
      shouldResumeListeningRef.current = false;
      setSpeechStatusState("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  function toggleVoiceListening() {
    if (isSpeechListening) {
      stopVoiceRecognition({ clearAutoResume: true });
      return;
    }

    startVoiceListening();
  }

  async function handleConversationToggle() {
    if (
      sessionStatusRef.current === "starting" ||
      isSubmittingRef.current ||
      isSpeakingRef.current
    ) {
      return;
    }

    if (sessionStatusRef.current !== "active") {
      await startSession({ startListening: true });
      return;
    }

    toggleVoiceListening();
  }

  function resumeListeningAfterSpeech() {
    isSpeakingRef.current = false;

    if (
      shouldResumeListeningRef.current &&
      sessionStatusRef.current === "active"
    ) {
      startVoiceListening();
    }
  }

  function speakAssistantReply(text: string) {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      setTtsStatus("unsupported");
      setErrorMessage("浏览器不支持语音播报，已显示文本回复。");
      resumeListeningAfterSpeech();
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1;

    utterance.onstart = () => {
      isSpeakingRef.current = true;
      setTtsStatus("speaking");
      setSpeechStatusState("paused");
    };

    utterance.onend = () => {
      isSpeakingRef.current = false;
      setTtsStatus("idle");
      resumeListeningAfterSpeech();
    };

    utterance.onerror = () => {
      isSpeakingRef.current = false;
      setTtsStatus("error");
      setErrorMessage("语音播报失败，已显示文本回复。");
      resumeListeningAfterSpeech();
    };

    isSpeakingRef.current = true;
    setTtsStatus("speaking");
    setSpeechStatusState("paused");
    window.speechSynthesis.speak(utterance);
  }

  function stopSpeaking() {
    if (!window.speechSynthesis) {
      setTtsStatus("unsupported");
      setErrorMessage("浏览器不支持语音播报，已显示文本回复。");
      return;
    }

    window.speechSynthesis.cancel();
    isSpeakingRef.current = false;
    setTtsStatus("stopped");

    if (
      shouldResumeListeningRef.current &&
      sessionStatusRef.current === "active"
    ) {
      startVoiceListening();
    }
  }

  function captureKeyframe() {
    try {
      const keyframe = captureFrame(keyframes.length);

      setErrorMessage(null);
      setErrorCloudCallLabel(null);
      appendKeyframeToBuffer(keyframe, { force: true });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }

  async function submitQuestionText(rawText: string, source: SubmitSource) {
    const text = rawText.trim();

    if (!text) {
      setErrorMessage(
        source === "voice" ? "语音转写为空，请再说一次。" : "请输入文本问题。"
      );
      if (source === "voice") {
        shouldResumeListeningRef.current = false;
        setSpeechStatusState("error");
      }
      return;
    }

    if (
      sessionStatusRef.current !== "active" ||
      mediaStreamRef.current === null
    ) {
      setErrorMessage(
        source === "voice"
          ? "请先启动摄像头，再开始语音提问。"
          : "请先启动摄像头，再发送文本问题。"
      );
      return;
    }

    let requestKeyframes = toCapturedKeyframes(keyframesRef.current);

    if (requestKeyframes.length === 0) {
      try {
        setTurnStatus("capturing-frame");
        const fallbackKeyframe = captureFrame(0);
        const nextKeyframes = [fallbackKeyframe];
        requestKeyframes = toCapturedKeyframes(nextKeyframes);
        setKeyframeBuffer(nextKeyframes);
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
        if (source === "voice") {
          shouldResumeListeningRef.current = false;
          setSpeechStatusState("error");
        }
        return;
      }
    }

    const activeSessionId = sessionIdRef.current ?? createSessionId();
    const requestMessages = messagesRef.current.slice(-6).map((message) => ({
      createdAt: message.createdAt,
      role: message.role,
      text: message.text
    }));

    if (!sessionIdRef.current) {
      sessionIdRef.current = activeSessionId;
      setSessionId(activeSessionId);
    }

    if (source === "voice") {
      setPromptText(text);
      setSpeechStatusState("paused");
    }

    isSubmittingRef.current = true;
    shouldStickToBottomRef.current = true;
    setIsSubmitting(true);
    setErrorMessage(null);
    setErrorCloudCallLabel(null);
    setPendingAssistantText("");
    setTurnStatus("sending");

    try {
      const response = await streamConversationTurn(
        {
          keyframes: requestKeyframes.map(toRequestKeyframe),
          session: {
            messages: requestMessages,
            sessionId: activeSessionId,
            stats: sessionStatsRef.current
          },
          text
        },
        {
          onDelta: (delta) => {
            setPendingAssistantText((currentText) => currentText + delta);
          },
          onError: (errorResponse) => {
            setErrorCloudCallLabel(getCloudCallLabel(errorResponse));
          },
          onStatus: (phase) => {
            setTurnStatus(phase);
          }
        }
      );

      setLatencyMs(response.timing.totalMs);
      sessionStatsRef.current = response.cost.session;
      setSessionStats(response.cost.session);

      if (!response.ok) {
        setErrorMessage(`${response.error.code}：${response.error.message}`);
        setErrorCloudCallLabel(getCloudCallLabel(response));
        setTurnStatus("error");
        if (source === "voice") {
          shouldResumeListeningRef.current = false;
          setSpeechStatusState("error");
        }
        return;
      }

      const now = new Date().toISOString();
      const nextMessages: ConversationMessage[] = [
        ...messagesRef.current,
        {
          createdAt: now,
          role: "user",
          text
        },
        {
          createdAt: new Date().toISOString(),
          role: "assistant",
          text: response.reply.text
        }
      ];

      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setPromptText("");
      setKeyframeBuffer([]);
      setPendingAssistantText("");
      setTurnStatus("completed");
      speakAssistantReply(response.reply.text);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
      setErrorCloudCallLabel(null);
      setTurnStatus("error");
      if (source === "voice") {
        shouldResumeListeningRef.current = false;
        setSpeechStatusState("error");
      }
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  async function submitTextQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitQuestionText(promptText, "text");
  }

  return (
    <div className="workbench">
      <header className="top-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>AI视觉对话助手</h1>
        </div>
        <div className="top-actions">
          <div className={`backend-pill ${backendStatus}`} role="status">
            <span className="status-dot" aria-hidden="true" />
            <span>{backendStatusLabel}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="设置"
            onClick={openSettings}
          >
            <span className="icon-gear" aria-hidden="true" />
          </button>
          <button className="avatar-button" type="button" aria-label="用户">
            <span className="icon-user" aria-hidden="true" />
          </button>
        </div>
      </header>

      {isSettingsOpen ? (
        <div className="settings-backdrop">
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-config-title"
          >
            <div className="settings-header">
              <div>
                <p className="settings-kicker">运行时模型</p>
                <h2 id="model-config-title">模型配置</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭模型配置"
                onClick={() => setIsSettingsOpen(false)}
              >
                <span className="icon-close" aria-hidden="true" />
              </button>
            </div>

            <div className="model-config-status" aria-label="模型配置状态">
              <div>
                <span>来源</span>
                <strong>{modelConfigSourceLabel}</strong>
              </div>
              <div>
                <span>密钥</span>
                <strong>{modelApiKeyLabel}</strong>
              </div>
            </div>

            <form className="settings-form" onSubmit={saveModelConfig}>
              <label>
                <span>模型服务地址</span>
                <input
                  autoComplete="off"
                  value={modelConfigForm.baseUrl}
                  onChange={(event) =>
                    updateModelConfigField("baseUrl", event.target.value)
                  }
                  placeholder="https://your-openai-compatible-host/v1"
                />
              </label>
              <label>
                <span>模型名称</span>
                <input
                  autoComplete="off"
                  value={modelConfigForm.modelName}
                  onChange={(event) =>
                    updateModelConfigField("modelName", event.target.value)
                  }
                  placeholder="vision-model"
                />
              </label>
              <label>
                <span>API Key</span>
                <input
                  autoComplete="off"
                  type="password"
                  value={modelConfigForm.apiKey}
                  onChange={(event) =>
                    updateModelConfigField("apiKey", event.target.value)
                  }
                  placeholder="仅提交到同源后端内存"
                />
              </label>
              <div className="settings-number-row">
                <label>
                  <span>超时时间（毫秒）</span>
                  <input
                    min="1"
                    type="number"
                    value={modelConfigForm.timeoutMs}
                    onChange={(event) =>
                      updateModelConfigField("timeoutMs", event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>最大输出 Token</span>
                  <input
                    min="1"
                    type="number"
                    value={modelConfigForm.maxOutputTokens}
                    onChange={(event) =>
                      updateModelConfigField(
                        "maxOutputTokens",
                        event.target.value
                      )
                    }
                  />
                </label>
              </div>

              {modelConfigMessage ? (
                <div className="settings-success" role="status">
                  {modelConfigMessage}
                </div>
              ) : null}
              {modelConfigError ? (
                <div className="settings-error" role="alert">
                  {modelConfigError}
                </div>
              ) : null}

              <button
                className="settings-save-button"
                disabled={isModelConfigSaving}
                type="submit"
              >
                {isModelConfigSaving ? "保存中" : "保存模型配置"}
              </button>
            </form>
          </section>
        </div>
      ) : null}

      <main className="workspace" aria-label="AI 视觉语音桌面工作台">
        <section className="vision-panel" aria-label="摄像头画面">
          <div className={`camera-feed ${isSessionActive ? "active" : ""}`}>
            {isSessionActive ? (
              <video
                ref={videoRef}
                aria-label="实时摄像头预览"
                autoPlay
                muted
                playsInline
              />
            ) : (
              <img src={cameraFeedUrl} alt="桌面摄像头参考画面" />
            )}
            <div className="scan-overlay" aria-hidden="true" />
            <div className="reticle" aria-hidden="true">
              <span className="corner top-left" />
              <span className="corner top-right" />
              <span className="corner bottom-left" />
              <span className="corner bottom-right" />
            </div>

            <div className="feed-badges top-left-badges">
              <div className="glass-badge">
                <span
                  className={`live-dot ${isSessionActive ? "active" : ""}`}
                  aria-hidden="true"
                />
                <strong>{streamStatus}</strong>
                <span className="divider" aria-hidden="true" />
                <span>{cameraStatus}</span>
              </div>
              <div className="glass-badge timestamp">{startedAtLabel}</div>
            </div>

            <div className="feed-badges top-right-badges">
              <div className="glass-badge quality-badge">
                <span className="sun-icon" aria-hidden="true" />
                <span>{mediaSourceLabel}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="chat-panel" aria-label="语音与文本对话">
          <div
            className="chat-scroll"
            role="log"
            aria-label="对话消息"
            aria-relevant="additions text"
            onScroll={handleChatScroll}
          >
            <div className="session-chip">当前会话</div>

            {isSessionActive ? (
              <>
                <article className="message assistant-message">
                  <div className="assistant-row">
                    <div className="assistant-avatar" aria-hidden="true">
                      <span className="icon-memory" />
                    </div>
                    <div className="message-bubble assistant-bubble">
                      <p>摄像头已连接，可以直接说话提问，也可以输入文本验证视觉链路。</p>
                      <div className="keyframe-strip" aria-label="关键帧预览">
                        {keyframes.length > 0 ? (
                          keyframes.map((keyframe, index) => (
                            <figure className="keyframe-card" key={keyframe.id}>
                              <img
                                src={keyframe.previewUrl}
                                alt={`关键帧 ${index + 1}`}
                              />
                              <figcaption>
                                {new Date(keyframe.capturedAt).toLocaleTimeString(
                                  "zh-CN",
                                  {
                                    hour12: false
                                  }
                                )}
                              </figcaption>
                            </figure>
                          ))
                        ) : (
                          <span className="empty-keyframes">暂无关键帧</span>
                        )}
                      </div>
                    </div>
                  </div>
                </article>

                <div className="message-list">
                  {messages.map((message, index) => (
                    <article
                      className={`message ${
                        message.role === "user"
                          ? "user-message"
                          : "assistant-message"
                      }`}
                      key={`${message.createdAt}-${index}`}
                    >
                      {message.role === "assistant" ? (
                        <div className="assistant-row">
                          <div className="assistant-avatar" aria-hidden="true">
                            <span className="icon-memory" />
                          </div>
                          <div className="message-bubble assistant-bubble">
                            <p>{message.text}</p>
                          </div>
                        </div>
                      ) : (
                        <div className="message-bubble user-bubble">
                          <p>{message.text}</p>
                        </div>
                      )}
                    </article>
                  ))}
                  {pendingAssistantText ? (
                    <article className="message assistant-message">
                      <div className="assistant-row">
                        <div className="assistant-avatar" aria-hidden="true">
                          <span className="icon-memory" />
                        </div>
                        <div className="message-bubble assistant-bubble pending-bubble">
                          <p>{pendingAssistantText}</p>
                        </div>
                      </div>
                    </article>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="empty-session" role="status">
                <p>会话尚未开始</p>
                <span>启动会话后才会接入浏览器摄像头。</span>
              </div>
            )}

            {isSubmitting ? (
              <div className="submitting-note" role="status">
                {turnStatusLabel}
              </div>
            ) : null}

            {errorMessage ? (
              <div className="error-banner" role="alert">
                <span>{errorMessage}</span>
                {errorCloudCallLabel ? <strong>{errorCloudCallLabel}</strong> : null}
              </div>
            ) : null}
            <div
              className="message-bottom-sentinel"
              ref={messageBottomRef}
              aria-hidden="true"
            />
          </div>

          <footer className="control-dock">
            <div className="voice-status-panel" aria-label="语音状态">
              <div className="voice-status-item">
                <span>监听</span>
                <strong>{speechStatusLabel}</strong>
              </div>
              <div className="voice-status-item">
                <span>转写</span>
                <strong>{transcriptPreview}</strong>
              </div>
              <div className="voice-status-item status-with-action">
                <span>播报</span>
                <strong>{ttsStatusLabel}</strong>
                {ttsStatus === "speaking" ? (
                  <button
                    className="status-action-button"
                    type="button"
                    aria-label="停止播报"
                    onClick={stopSpeaking}
                  >
                    停止播报
                  </button>
                ) : null}
              </div>
              <div className="voice-status-item">
                <span>模型</span>
                <strong>{turnStatusLabel}</strong>
              </div>
            </div>

            <form className="prompt-form" onSubmit={submitTextQuestion}>
              <textarea
                aria-label="文本问题"
                className="prompt-textarea"
                disabled={isSubmitting}
                onChange={(event) => setPromptText(event.target.value)}
                placeholder="输入你想让 AI 结合画面回答的问题"
                rows={3}
                value={promptText}
              />
              <button
                className="send-button"
                disabled={isSubmitting || promptText.trim().length === 0}
                type="submit"
                aria-label="发送文本问题"
              >
                <span className="icon-send" aria-hidden="true" />
                <span>{isSubmitting ? "发送中" : "发送"}</span>
              </button>
            </form>

            <div className="control-buttons" aria-label="对话控制">
              <button
                className="round-button utility-button"
                type="button"
                aria-label="截取关键帧"
                onClick={captureKeyframe}
              >
                <span className="icon-camera" aria-hidden="true" />
              </button>
              <button
                className={`round-button conversation-button ${
                  isSpeechListening ? "listening" : ""
                }`}
                type="button"
                aria-label={conversationControlLabel}
                disabled={isConversationBusy}
                onClick={handleConversationToggle}
              >
                <span className={conversationControlIcon} aria-hidden="true" />
              </button>
              <button
                className="round-button end-call-button"
                type="button"
                aria-label="结束对话"
                onClick={stopSession}
              >
                <span className="icon-x" aria-hidden="true" />
              </button>
            </div>

            <dl className="debug-stats" aria-label="调试统计">
              <div>
                <dt>Lat:</dt>
                <dd>{latencyLabel}</dd>
              </div>
              <div>
                <dt>Buffer:</dt>
                <dd>{frameCountLabel}</dd>
              </div>
              <div>
                <dt>Cost:</dt>
                <dd>{modelCostLabel}</dd>
              </div>
            </dl>
          </footer>
        </section>
      </main>
    </div>
  );
}
