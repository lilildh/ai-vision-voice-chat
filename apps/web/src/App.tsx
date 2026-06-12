import { useEffect, useRef, useState } from "react";

import "./App.css";
import cameraFeedUrl from "./assets/camera-feed-reference.png";

type BackendStatus = "checking" | "online" | "offline";
type SessionStatus = "idle" | "starting" | "active" | "error";

type HealthResponse = {
  ok: boolean;
  service: string;
};

type Keyframe = {
  capturedAt: Date;
  id: string;
  src: string;
};

const serviceName = "ai-vision-voice-chat-api";
const maxKeyframesPerTurn = 3;

function stopMediaStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => {
    track.stop();
  });
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "无法访问摄像头或麦克风，请检查浏览器权限。";
}

export function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [backendStatus, setBackendStatus] =
    useState<BackendStatus>("checking");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [sessionStartedAt, setSessionStartedAt] = useState<Date | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isSessionActive = sessionStatus === "active";
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
  const modelCostLabel = "$0.000";

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
    if (videoRef.current) {
      videoRef.current.srcObject = mediaStream;
    }
  }, [mediaStream]);

  useEffect(() => {
    return () => {
      stopMediaStream(mediaStream);
    };
  }, [mediaStream]);

  async function startSession() {
    setErrorMessage(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setSessionStatus("error");
      setErrorMessage("当前浏览器不支持摄像头或麦克风访问。");
      return;
    }

    setSessionStatus("starting");

    try {
      stopMediaStream(mediaStream);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });

      setMediaStream(stream);
      setKeyframes([]);
      setSessionStartedAt(new Date());
      setSessionStatus("active");
    } catch (error) {
      setMediaStream(null);
      setSessionStartedAt(null);
      setSessionStatus("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  function stopSession() {
    stopMediaStream(mediaStream);
    setMediaStream(null);
    setKeyframes([]);
    setSessionStartedAt(null);
    setSessionStatus("idle");
    setErrorMessage(null);
  }

  function captureKeyframe() {
    if (!isSessionActive || !mediaStream) {
      setErrorMessage("请先启动会话，再截取关键帧。");
      return;
    }

    if (keyframes.length >= maxKeyframesPerTurn) {
      setErrorMessage(`每轮最多保留 ${maxKeyframesPerTurn} 张关键帧。`);
      return;
    }

    const video = videoRef.current;

    if (!video) {
      setErrorMessage("实时视频尚未挂载，请稍后再试。");
      return;
    }

    const width = video.videoWidth || 640;
    const height = video.videoHeight || 360;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");

    if (!context) {
      setErrorMessage("当前浏览器无法从视频生成关键帧。");
      return;
    }

    context.drawImage(video, 0, 0, width, height);

    try {
      const capturedAt = new Date();
      const src = canvas.toDataURL("image/png");

      setErrorMessage(null);
      setKeyframes((currentKeyframes) => [
        ...currentKeyframes,
        {
          capturedAt,
          id: `${capturedAt.getTime()}-${currentKeyframes.length + 1}`,
          src
        }
      ]);
    } catch {
      setErrorMessage("关键帧生成失败，请确认摄像头画面可用。");
    }
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
          <button className="icon-button" type="button" aria-label="设置">
            <span className="icon-gear" aria-hidden="true" />
          </button>
          <button className="avatar-button" type="button" aria-label="用户">
            <span className="icon-user" aria-hidden="true" />
          </button>
        </div>
      </header>

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

        <section className="chat-panel" aria-label="语音对话">
          <div className="chat-scroll">
            <div className="session-chip">当前会话</div>

            {isSessionActive ? (
              <article className="message assistant-message">
                <div className="assistant-row">
                  <div className="assistant-avatar" aria-hidden="true">
                    <span className="icon-memory" />
                  </div>
                  <div className="message-bubble assistant-bubble">
                    <p>摄像头和麦克风已连接，等待真实语音输入。</p>
                    <div className="keyframe-strip" aria-label="关键帧预览">
                      {keyframes.length > 0 ? (
                        keyframes.map((keyframe, index) => (
                          <figure className="keyframe-card" key={keyframe.id}>
                            <img
                              src={keyframe.src}
                              alt={`关键帧 ${index + 1}`}
                            />
                            <figcaption>
                              {keyframe.capturedAt.toLocaleTimeString("zh-CN", {
                                hour12: false
                              })}
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
            ) : (
              <div className="empty-session" role="status">
                <p>会话尚未开始</p>
                <span>启动会话后才会接入浏览器摄像头和麦克风。</span>
              </div>
            )}

            {isSessionActive ? (
              <div className="listening-indicator">
                <span className="equalizer" aria-hidden="true" />
                <span>等待语音输入</span>
              </div>
            ) : null}

            {errorMessage ? (
              <div className="error-banner" role="alert">
                {errorMessage}
              </div>
            ) : null}
          </div>

          <footer className="control-dock">
            <div className="control-buttons">
              <button
                className="round-button ghost-button"
                type="button"
                aria-label="截取关键帧"
                onClick={captureKeyframe}
              >
                <span className="icon-camera" aria-hidden="true" />
              </button>
              <button
                className="round-button mic-button"
                type="button"
                aria-label={sessionStatus === "starting" ? "启动中" : "开始会话"}
                disabled={sessionStatus === "starting"}
                onClick={startSession}
              >
                <span className="icon-mic" aria-hidden="true" />
              </button>
              <button
                className="round-button ghost-button danger-button"
                type="button"
                aria-label="停止会话"
                onClick={stopSession}
              >
                <span className="icon-stop" aria-hidden="true" />
              </button>
            </div>

            <dl className="debug-stats" aria-label="调试统计">
              <div>
                <dt>Lat:</dt>
                <dd>{latencyLabel}</dd>
              </div>
              <div>
                <dt>Frames:</dt>
                <dd>{keyframes.length}</dd>
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
