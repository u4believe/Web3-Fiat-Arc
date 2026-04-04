import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// ─── Security headers (helmet) ───────────────────────────────────────────────
// Sets: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection,
// Strict-Transport-Security (HSTS), Referrer-Policy, and more.
app.use(
  helmet({
    // HSTS: tell browsers to always use HTTPS for 1 year, include subdomains
    hsts: {
      maxAge: 31_536_000, // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
    // Allow inline scripts for Vite dev only — restrict in prod
    contentSecurityPolicy: false, // API server; CSP belongs on the frontend
    crossOriginResourcePolicy: { policy: "cross-origin" }, // allow Vite frontend to fetch
  }),
);

// ─── CORS ────────────────────────────────────────────────────────────────────
// In production, only allow the same Replit domain; in dev allow all.
const allowedOrigins: string[] = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, server-to-server, mobile)
      if (!origin) return callback(null, true);
      // In dev (no ALLOWED_ORIGINS set) allow all
      if (allowedOrigins.length === 0) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS: origin '${origin}' is not allowed`));
    },
    credentials: true,
  }),
);

// ─── Request logging ─────────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0], // strip query strings from logs
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// ─── Body parsing ─────────────────────────────────────────────────────────────
// The `verify` callback captures the raw body buffer on every request.
// Webhook signature validators (Paystack, Monnify) read req.rawBody to verify
// HMAC integrity before the parsed JSON is used.
app.use(
  express.json({
    limit: "64kb",
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "64kb" }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api", router);

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled error");
  const status = err.status ?? err.statusCode ?? 500;
  const message =
    process.env.NODE_ENV === "production" ? "Internal server error" : (err.message ?? "Internal server error");
  res.status(status).json({ error: "Internal server error", message });
});

export default app;
