import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

// ─── JWT secret validation ────────────────────────────────────────────────────
// Fail hard at startup if no secret is configured; never use a default in prod.
const INSECURE_DEFAULT = "usdc-send-secret-key-change-in-prod";
const JWT_SECRET = process.env.JWT_SECRET || INSECURE_DEFAULT;

if (JWT_SECRET === INSECURE_DEFAULT && process.env.NODE_ENV === "production") {
  throw new Error(
    "[auth] JWT_SECRET is set to the insecure default value. " +
    "Set a strong random secret via the JWT_SECRET environment variable before running in production.",
  );
}

if (JWT_SECRET.length < 32) {
  // Warn loudly in any environment; a short secret is cryptographically weak
  console.warn("[auth] WARNING: JWT_SECRET is shorter than 32 characters. Use a securely generated random value.");
}

export interface JwtPayload {
  userId: number;
  email: string;
}

export function generateToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized", message: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.substring(7);
  try {
    const payload = verifyToken(token);
    (req as any).user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
  }
}
