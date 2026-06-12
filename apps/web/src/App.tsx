import "./App.css";

export function App() {
  return (
    <main className="app-shell">
      <section className="scaffold-panel" aria-labelledby="app-title">
        <p className="eyebrow">Vite + React + TypeScript</p>
        <h1 id="app-title">AI 视觉语音对话应用</h1>
        <p className="status">脚手架已启动</p>
        <p className="description">
          当前只包含前后端基础工程、开发脚本和测试入口，摄像头、语音和模型调用尚未实现。
        </p>
      </section>
    </main>
  );
}
