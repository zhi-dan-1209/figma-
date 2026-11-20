import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import QRCode from "qrcode";
import { WebSocketServer, WebSocket } from "ws";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
const sessionTtlMs = Number(process.env.SESSION_TTL_MINUTES || 120) * 60 * 1000;
const maxSessions = Number(process.env.MAX_SESSIONS || 1000);
const maxImageBytes = Number(process.env.MAX_IMAGE_MB || 12) * 1024 * 1024;
const sessions = new Map();
const createRateLimits = new Map();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Frame-Name, X-Frame-Width, X-Frame-Height, X-Frame-Scale, X-Frame-Stage");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(dirname, "public"), { extensions: ["html"] }));

function requestOrigin(req) {
  if (publicBaseUrl) return publicBaseUrl;
  const forwardedProto = req.headers["x-forwarded-proto"]?.split(",")[0];
  return `${forwardedProto || req.protocol}://${req.get("host")}`;
}

function wsOrigin(httpOrigin) {
  return httpOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function createId() {
  return crypto.randomBytes(16).toString("base64url");
}

function createSession(token, now = Date.now()) {
  return {
    token,
    expiresAt: now + sessionTtlMs,
    lastFrame: null,
    frameBuffer: null,
    frameMimeType: "image/jpeg",
    version: 0,
    publisher: null,
    viewers: new Set()
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "monkey-view", activeSessions: sessions.size });
});

app.post("/api/sessions", (req, res) => {
  const now = Date.now();
  const ip = req.ip || "unknown";
  const rate = createRateLimits.get(ip);
  if (!rate || rate.resetAt <= now) {
    createRateLimits.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
  } else if (rate.count >= 30) {
    res.status(429).json({ error: "Too many sessions; try again later" });
    return;
  } else {
    rate.count += 1;
  }
  if (sessions.size >= maxSessions) {
    res.status(503).json({ error: "Session capacity reached" });
    return;
  }
  const id = createId();
  const token = crypto.randomBytes(24).toString("base64url");
  const origin = requestOrigin(req);
  sessions.set(id, createSession(token, now));
  res.status(201).json({
    id,
    publisherToken: token,
    viewerUrl: `${origin}/s/${id}`,
    publisherWsUrl: `${wsOrigin(origin)}/ws/publish/${id}?token=${token}`,
    expiresAt: now + sessionTtlMs
  });
});

function tokenMatches(received, expected) {
  const a = Buffer.from(received || "");
  const b = Buffer.from(expected || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.put(
  "/api/sessions/:id/frame",
  express.raw({ type: ["image/jpeg", "image/png"], limit: `${Math.ceil(maxImageBytes / 1024 / 1024)}mb` }),
  (req, res) => {
    const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
    let session = sessions.get(req.params.id);
    if (!session || session.expiresAt <= Date.now() || !tokenMatches(token, session.token)) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Image body required" });
      return;
    }

    session.frameBuffer = req.body;
    session.frameMimeType = req.get("content-type") || "image/jpeg";
    session.version += 1;
    session.lastFrame = JSON.stringify({
      type: "frame",
      imageUrl: `/api/sessions/${req.params.id}/frame?v=${session.version}`,
      width: Number(req.get("x-frame-width")) || 0,
      height: Number(req.get("x-frame-height")) || 0,
      scale: Number(req.get("x-frame-scale")) || 1,
      stage: req.get("x-frame-stage") || "fast",
      name: decodeURIComponent(req.get("x-frame-name") || "Figma Frame"),
      updatedAt: Date.now()
    });

    for (const viewer of session.viewers) {
      if (viewer.readyState === WebSocket.OPEN) viewer.send(session.lastFrame);
    }
    sendJson(session.publisher, { type: "delivered", viewers: session.viewers.size, version: session.version });
    res.json({ ok: true, version: session.version, viewers: session.viewers.size });
  }
);

app.delete("/api/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!session || !tokenMatches(token, session.token)) {
    res.status(401).json({ error: "Invalid session" });
    return;
  }
  session.publisher?.close(4001, "Session stopped");
  for (const viewer of session.viewers) viewer.close(4001, "Session stopped");
  sessions.delete(req.params.id);
  res.status(204).end();
});

app.get("/api/sessions/:id/frame", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session?.frameBuffer || session.expiresAt <= Date.now()) {
    res.status(404).end();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.type(session.frameMimeType);
  res.send(session.frameBuffer);
});

app.get("/api/qr", async (req, res) => {
  const text = typeof req.query.text === "string" ? req.query.text : "";
  if (!text || text.length > 2048) {
    res.status(400).json({ error: "Invalid QR content" });
    return;
  }
  res.type("png");
  res.send(await QRCode.toBuffer(text, { width: 360, margin: 2 }));
});

app.get("/s/:id", (req, res) => {
  res.sendFile(path.join(dirname, "public", "preview.html"));
});

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") {
    res.status(413).json({ error: "Image exceeds the configured size limit" });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });

function sendJson(socket, value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function parseSocketPath(url) {
  const parsed = new URL(url, "http://localhost");
  const match = parsed.pathname.match(/^\/ws\/(publish|view)\/([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  return { role: match[1], id: match[2], token: parsed.searchParams.get("token") };
}

server.on("upgrade", (req, socket, head) => {
  const target = parseSocketPath(req.url || "");
  let session = target && sessions.get(target.id);
  const authorized = session && session.expiresAt > Date.now() &&
    (target.role === "view" || tokenMatches(target.token, session.token));

  if (!target || !authorized) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req, target, session);
  });
});

wss.on("connection", (socket, _req, target, session) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
  if (target.role === "publish") {
    if (session.publisher && session.publisher.readyState === WebSocket.OPEN) {
      session.publisher.close(4001, "Replaced by a new publisher");
    }
    session.publisher = socket;
    sendJson(socket, { type: "ready" });

    socket.on("message", raw => {
      if (raw.length > 20 * 1024 * 1024) return;
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type !== "frame" || typeof message.dataUrl !== "string") return;
      session.lastFrame = JSON.stringify({
        type: "frame",
        dataUrl: message.dataUrl,
        width: Number(message.width) || 0,
        height: Number(message.height) || 0,
        name: String(message.name || "Figma Frame"),
        updatedAt: Date.now()
      });
      for (const viewer of session.viewers) {
        if (viewer.readyState === WebSocket.OPEN) viewer.send(session.lastFrame);
      }
      sendJson(socket, { type: "delivered", viewers: session.viewers.size });
    });

    socket.on("close", () => {
      if (session.publisher === socket) session.publisher = null;
    });
  } else {
    session.viewers.add(socket);
    sendJson(socket, { type: "status", connected: Boolean(session.publisher) });
    if (session.lastFrame) socket.send(session.lastFrame);
    socket.on("close", () => session.viewers.delete(socket));
  }
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 25_000);
heartbeat.unref();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt > now) continue;
    session.publisher?.close(4000, "Session expired");
    for (const viewer of session.viewers) viewer.close(4000, "Session expired");
    sessions.delete(id);
  }
  for (const [ip, rate] of createRateLimits) {
    if (rate.resetAt <= now) createRateLimits.delete(ip);
  }
}, 60_000).unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`Figma Android Preview running at http://localhost:${port}`);
  if (publicBaseUrl) console.log(`Public preview base URL: ${publicBaseUrl}`);
});

function shutdown() {
  for (const session of sessions.values()) {
    session.publisher?.close(1012, "Service restarting");
    for (const viewer of session.viewers) viewer.close(1012, "Service restarting");
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
