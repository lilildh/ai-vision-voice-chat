import express from "express";

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      service: "ai-vision-voice-chat-api"
    });
  });

  return app;
}
