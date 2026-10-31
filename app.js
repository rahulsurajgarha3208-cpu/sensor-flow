import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import readingRoutes from "./routes/readingRoutes.js";
import { analyzeReadings } from "./controllers/aiController.js";
import { login, me, requireAuth } from "./auth.js";

// FRONTEND_URL may hold several comma-separated origins. For localhost we also
// accept 127.0.0.1 (and the reverse) because both open the same dev server.
function allowedOrigins() {
  const configured = (process.env.FRONTEND_URL || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const extra = configured.flatMap((origin) => [
    origin.replace("//localhost", "//127.0.0.1"),
    origin.replace("//127.0.0.1", "//localhost"),
  ]);
  return new Set([...configured, ...extra]);
}

export function createApp() {
  const app = express();
  const origins = allowedOrigins();

  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "1");

  // Middleware order matters: CORS and JSON parsing must come before the routes.
  app.use(
    cors({
      origin(origin, callback) {
        // Requests without an Origin header (curl, same-origin proxy) are allowed
        if (!origin || origins.has(origin)) return callback(null, true);
        callback(null, false);
      },
    })
  );
  app.use(express.json({ limit: "20kb" }));
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  // Public: used by the dashboard to show real system status
  app.get("/api/health", (req, res) => {
    const key = process.env.GEMINI_API_KEY;
    res.json({
      status: "ok",
      database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      ai: key && key !== "your_gemini_api_key_here" ? "configured" : "not configured",
      time: new Date().toISOString(),
    });
  });

  app.post("/api/auth/login", login);
  app.get("/api/auth/me", requireAuth, me);

  app.use("/api/readings", requireAuth, readingRoutes);
  app.post("/api/ai/analyze", requireAuth, analyzeReadings);

  // Unknown URL
  app.use((req, res) => {
    res.status(404).json({ error: "Route not found" });
  });

  // Catches other errors, such as malformed JSON in a request body
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Request body is not valid JSON" });
    }
    if (err.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body is too large" });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  });

  return app;
}
