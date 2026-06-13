# AI 视觉语音对话应用

这是一个面向 Web 浏览器的 AI 视觉语音对话应用设计仓库。

项目目标是让用户在浏览器中打开摄像头和麦克风后，通过语音向 AI 提问；应用在每轮提问结束后截取摄像头关键帧，将语音转写文本和画面内容发送到后端，由真实云端多模态模型生成回复，并在前端展示文本与语音播报。

## 当前状态

当前仓库已具备首版流式多模态对话闭环。前端通过浏览器摄像头、`MediaRecorder`、Web Audio 和 `speechSynthesis` 完成采集与播报；后端通过 OpenAI-compatible provider 代理真实云端 ASR 和多模态模型，并负责校验、限流、会话轮次限制和成本估算。

已完成内容：

- 产品定位与首版范围
- 用户故事与非目标场景
- 摄像头预览、关键帧截取、压缩和每轮 3 张上限
- 云端 ASR 语音转写、手动文本提问和浏览器 TTS 播报
- `POST /api/speech-transcription` 云端语音转写接口
- 流式 `/api/conversation-turn/stream` 多模态对话接口
- 保留非流式 `/api/conversation-turn` 兼容接口
- OpenAI-compatible 多模态 provider，支持非流式和 `stream: true`
- 最近 6 条短期上下文发送策略
- 服务端请求校验、限流、会话轮次限制、成本估算和明确错误码
- 前端状态流转、错误展示、延迟和成本展示
- 根目录 `npm run dev`、`npm test`、`npm run build`、`npm run typecheck` 脚本

尚未完成内容：

- 真实 Chrome 麦克风权限和识别质量的人工验收
- 真实系统语音播报声音的人工验收
- 配置真实 `MODEL_*` 后的云端多模态质量验收

## 本地运行

安装依赖：

```bash
npm install
```

启动前后端开发服务：

```bash
npm run dev
```

真实模型调用需要在启动后端前设置：

```bash
export MODEL_BASE_URL="https://your-openai-compatible-host/v1"
export MODEL_API_KEY="your-api-key"
export MODEL_NAME="your-vision-model"
export MODEL_ASR_NAME="your-speech-to-text-model"
export MODEL_TIMEOUT_MS=30000
export MODEL_MAX_OUTPUT_TOKENS=512
```

也可以在页面右上角“设置”中提交模型配置。页面配置会写入同源后端的进程内存，并优先于 `MODEL_*` 环境变量用于后续请求；API Key 不会返回给前端，也不会写入浏览器本地存储。重启后端后，这份页面临时配置会清空。

可选成本估算配置：

```bash
export COST_IMAGE_TOKENS_PER_KEYFRAME=850
export COST_INPUT_USD_PER_1M_TOKENS=5
export COST_OUTPUT_USD_PER_1M_TOKENS=15
```

运行测试：

```bash
npm test
```

类型检查：

```bash
npm run typecheck
```

构建：

```bash
npm run build
```

后端接口：

```text
GET /api/health
GET /api/model-config
PUT /api/model-config
POST /api/conversation-turn
POST /api/conversation-turn/stream
POST /api/speech-transcription
```

健康检查返回：

```json
{
  "ok": true,
  "service": "ai-vision-voice-chat-api"
}
```

`POST /api/conversation-turn/stream` 返回 `text/event-stream`：

```text
event: status
data: {"phase":"validating"}

event: delta
data: {"text":"我看到"}

event: complete
data: {"ok":true,"reply":{"role":"assistant","text":"我看到..."}}
```

真实模型 smoke test：

1. 设置 `MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_NAME`、`MODEL_ASR_NAME`。
2. 运行 `npm run dev`。
3. 用 Chrome 打开 Vite 页面，允许摄像头和麦克风权限。
4. 点击开始对话后直接说话提问三轮，包含一次“它/左边那个”等指代追问。
5. 确认回复文本流式出现、TTS 在完成后播报、错误/限流/成本状态可见。

## 核心设计

首版采用“语音轮次 + 视频关键帧理解”的混合模式，而不是连续视频流实时理解。

每轮交互流程：

1. 用户打开摄像头和麦克风。
2. 用户用语音提出问题。
3. 浏览器用 `MediaRecorder` 录制本轮语音，并通过 Web Audio 静默检测判断一轮结束。
4. 前端将音频片段发送到后端云端 ASR 接口生成语音转写。
5. 前端在用户说完后截取 1 张默认关键帧，必要时最多补充到 3 张。
6. 前端压缩关键帧，并将文本、关键帧和短期上下文发送到后端。
7. 后端执行 schema 校验、限流、预算检查和模型调用。
8. 前端展示 AI 文本回复，并用浏览器 TTS 播报。

## 技术方向

- 前端：Vite + React + TypeScript
- 后端：Node.js + Express
- ASR：浏览器录音 + 后端 OpenAI-compatible `audio/transcriptions`
- TTS：优先使用浏览器 `speechSynthesis`
- 模型：通过后端 OpenAI-compatible 多模态 provider 调用
- 配置：通过环境变量配置模型服务地址、模型名和 API Key

前端不得持有模型 API Key。

## 文档

完整设计文档见：

- [AI 视觉语音对话应用设计文档](docs/superpowers/specs/2026-06-12-ai-vision-voice-chat-design.md)

## 后续实现顺序

建议后续按以下顺序推进：

1. 配置真实 `MODEL_*` 环境变量并做 Chrome 手工 smoke test。
2. 验证三轮语音问答、指代追问、流式文本、TTS 播报和错误展示。
3. 根据真实模型延迟和 token usage 调整 `MODEL_MAX_OUTPUT_TOKENS` 与成本估算参数。
4. 记录目标 provider 对 `stream_options.include_usage` 的兼容性。
5. 根据演示反馈决定是否增加云端 TTS 或多模型路由。
