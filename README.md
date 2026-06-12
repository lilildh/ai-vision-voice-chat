# AI 视觉语音对话应用

这是一个面向 Web 浏览器的 AI 视觉语音对话应用设计仓库。

项目目标是让用户在浏览器中打开摄像头和麦克风后，通过语音向 AI 提问；应用在每轮提问结束后截取摄像头关键帧，将语音转写文本和画面内容发送到后端，由真实云端多模态模型生成回复，并在前端展示文本与语音播报。

## 当前状态

当前仓库已具备最小前后端 TypeScript 脚手架，但尚未进入业务功能实现。

已完成内容：

- 产品定位与首版范围
- 用户故事与非目标场景
- 前端与后端职责划分
- OpenAI-compatible 多模态 provider 适配方案
- 浏览器 Web Speech API 与浏览器 TTS 策略
- 关键帧采样、成本控制与隐私边界
- 错误处理与验收标准
- Vite + React + TypeScript 前端基础工程
- Node/Express + TypeScript 后端基础工程
- 根目录 `npm run dev`、`npm test`、`npm run build`、`npm run typecheck` 脚本

尚未完成内容：

- 摄像头预览、麦克风采集和语音转写
- 多模态模型 provider 真实调用
- ASR、TTS 的端到端联调
- 限流、成本估算和会话上下文管理

## 本地运行

安装依赖：

```bash
npm install
```

启动前后端开发服务：

```bash
npm run dev
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

后端当前仅提供健康检查接口：

```text
GET /api/health
```

返回：

```json
{
  "ok": true,
  "service": "ai-vision-voice-chat-api"
}
```

## 核心设计

首版采用“语音轮次 + 视频关键帧理解”的混合模式，而不是连续视频流实时理解。

每轮交互流程：

1. 用户打开摄像头和麦克风。
2. 用户用语音提出问题。
3. 浏览器通过 Web Speech API 生成语音转写。
4. 前端在用户说完后截取 1 张默认关键帧，必要时最多补充到 3 张。
5. 前端压缩关键帧，并将文本、关键帧和短期上下文发送到后端。
6. 后端执行 schema 校验、限流、预算检查和模型调用。
7. 前端展示 AI 文本回复，并用浏览器 TTS 播报。

## 技术方向

- 前端：Vite + React + TypeScript
- 后端：Node.js + Express
- ASR：优先使用浏览器 Web Speech API
- TTS：优先使用浏览器 `speechSynthesis`
- 模型：通过后端 OpenAI-compatible 多模态 provider 调用
- 配置：通过环境变量配置模型服务地址、模型名和 API Key

前端不得持有模型 API Key。

## 文档

完整设计文档见：

- [AI 视觉语音对话应用设计文档](docs/superpowers/specs/2026-06-12-ai-vision-voice-chat-design.md)

## 后续实现顺序

建议后续按以下顺序推进：

1. 创建 Vite + React + TypeScript 前端和 Node/Express 后端骨架。
2. 实现摄像头预览、权限状态和错误提示。
3. 实现 Web Speech API 转写和浏览器兼容性提示。
4. 实现关键帧截取、压缩和本地预览。
5. 实现后端请求 schema、限流和成本估算。
6. 实现 OpenAI-compatible 多模态 provider。
7. 实现对话 UI、短期上下文和 TTS 播报。
8. 实现调试区和成本统计。
9. 补充端到端手工验收脚本和自动化测试。
10. 根据真实实现结果更新设计文档中的当前实现记录和验收状态。
