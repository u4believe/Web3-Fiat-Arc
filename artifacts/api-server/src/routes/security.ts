/**
 * Security routes — transaction password, PAK, and password changes.
 *
 * All routes require authentication (JWT).
 *
 * Transaction password
 * ─────────────────────
 *  POST /api/security/txn-password/request-otp   — sends OTP to email
 *  POST /api/security/txn-password/set            — verifies OTP + sets the password
 *
 * Personal Authorization Key (PAK)
 * ─────────────────────────────────
 *  GET  /api/security/status                      — returns security status flags
 *  POST /api/security/pak/request-otp             — checks 6-month rule, sends OTP
 *  POST /api/security/pak/generate                — verifies OTP, creates PAK, returns plaintext ONCE
 *  POST /api/security/pak/confirm-copied          — marks pakCopiedAt; key is permanently masked after
 *
 * Password changes (require PAK + OTP)
 * ─────────────────────────────────────
 *  POST /api/security/change-login-password/request-otp  — verifies PAK, sends OTP
 *  POST /api/security/change-login-password/confirm      — verifies OTP, updates login password
 *  POST /api/security/change-txn-password/request-otp   — verifies PAK, sends OTP
 *  POST /api/security/change-txn-password/confirm        — verifies OTP, updates txn password
 */

import { Router, type IRouter } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { db, usersTable, otpCodesTable } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { sendSecurityOtpEmail } from "../lib/email.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ── Constants ────────────────────────────────────────────────────────────────

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000; // approx. 6 calendar months
const PAK_CHARSET   = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no 0/O/I/1
const PAK_LENGTH    = 40;
const BCRYPT_ROUNDS = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function issueOtp(userId: number, type: string): Promise<string> {
  const code      = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.insert(otpCodesTable).values({ userId, code, type, expiresAt });
  return code;
}

async function verifyOtp(userId: number, code: string, type: string): Promise<boolean> {
  const [otp] = await db
    .select()
    .from(otpCodesTable)
    .where(
      and(
        eq(otpCodesTable.userId, userId),
        eq(otpCodesTable.code, code.trim()),
        eq(otpCodesTable.type, type),
        eq(otpCodesTable.used, false),
        gt(otpCodesTable.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!otp) return false;
  await db.update(otpCodesTable).set({ used: true }).where(eq(otpCodesTable.id, otp.id));
  return true;
}

function generatePak(): string {
  const bytes = crypto.randomBytes(PAK_LENGTH);
  let pak = "";
  for (let i = 0; i < PAK_LENGTH; i++) {
    pak += PAK_CHARSET[bytes[i] % PAK_CHARSET.length];
  }
  return pak;
}

function maskPak(prefix: string, suffix: string): string {
  return `${prefix}${"*".repeat(PAK_LENGTH - prefix.length - suffix.length)}${suffix}`;
}

// ── GET /api/security/status ─────────────────────────────────────────────────

router.get("/status", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) { res.status(404).json({ error: "Not found", message: "User not found" }); return; }

    const hasPak = !!user.pakHash;
    const pakCopied = !!user.pakCopiedAt;
    let pakCanRegenerate = !hasPak; // if no PAK, can always create one
    let nextPakAllowedAt: string | null = null;

    if (hasPak && user.pakCreatedAt) {
      const elapsed = Date.now() - user.pakCreatedAt.getTime();
      pakCanRegenerate = elapsed >= SIX_MONTHS_MS;
      if (!pakCanRegenerate) {
        nextPakAllowedAt = new Date(user.pakCreatedAt.getTime() + SIX_MONTHS_MS).toISOString();
      }
    }

    res.json({
      hasTransactionPassword: !!user.transactionPasswordHash,
      hasPak,
      pakCopied,
      pakPreview: hasPak && user.pakPrefix && user.pakSuffix
        ? maskPak(user.pakPrefix, user.pakSuffix)
        : null,
      pakCreatedAt: user.pakCreatedAt?.toISOString() ?? null,
      pakCanRegenerate,
      nextPakAllowedAt,
    });
  } catch (err: any) {
    logger.error({ err }, "[security/status]");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ── POST /api/security/txn-password/request-otp ──────────────────────────────

router.post("/txn-password/request-otp", requireAuth, async (req, res) => {
  try {
    const { userId, email } = (req as any).user;
    const code = await issueOtp(userId, "txn-pwd");
    await sendSecurityOtpEmail(email, code, "txn-pwd");
    res.json({ sent: true, message: "Verification code sent to your email." });
  } catch (err: any) {
    logger.error({ err }, "[security/txn-password/request-otp]");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ── POST /api/security/txn-password/set ──────────────────────────────────────

router.post("/txn-password/set", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { otp, password } = req.body as { otp?: unknown; password?: unknown };

    if (typeof otp !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Validation error", message: "otp and password are required" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: "Validation error", message: "Transaction password must be at least 6 characters" });
      return;
    }

    const valid = await verifyOtp(userId, otp, "txn-pwd");
    if (!valid) {
      res.status(401).json({ error: "Invalid code", message: "OTP is invalid or has expired" });
      return;
    }

    const transactionPasswordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await db.update(usersTable).set({ transactionPasswordHash }).where(eq(usersTable.id, userId));

    res.json({ success: true, message: "Transaction password set successfully." });
  } catch (err: any) {
    logger.error({ err }, "[security/txn-password/set]");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ── POST /api/security/pak/request-otp ───────────────────────────────────────

router.post("/pak/request-otp", requireAuth, async (req, res) => {
  try {
    const { userId, email } = (req as any).user;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) { res.status(404).json({ error: "Not found", message: "User not found" }); return; }

    // Enforce 6-month regeneration lock
    if (user.pakHash && user.pakCreatedAt) {
      const elapsed = Date.now() - user.pakCreatedAt.getTime();
      if (elapsed < SIX_MONTHS_MS) {
        const nextAllowed = new Date(user.pakCreatedAt.getTime() + SIX_MONTHS_MS).toISOString();
        res.status(429).json({
          error: "Too soon",
          message: "Your PAK can only be regenerated once every 6 months.",
          nextPakAllowedAt: nextAllowed,
        });
        return;
      }
    }

    const code = await issueOtp(userId, "pak-gen");
    await sendSecurityOtpEmail(email, code, "pak-gen");
    res.json({ sent: true, message: "Verification code sent to your email." });
  } catch (err: any) {
    logger.error({ err }, "[security/pak/request-otp]");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ── POST /api/security/pak/generate ──────────────────────────────────────────
// Returns the full PAK plaintext exactly once. After pakCopiedAt is set the
// full key is permanently irretrievable — not even the server can recover it.

router.post("/pak/generate", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { otp } = req.body as { otp?: unknown };

    if (typeof otp !== "string") {
      res.status(400).json({ error: "Validation error", message: "otp is required" });
      return;
    }

    const valid = await verifyOtp(userId, otp, "pak-gen");
    if (!valid) {
      res.status(401).json({ error: "Invalid code", message: "OTP is invalid or has expired" });
      return;
    }

    const pak    = generatePak();
    const pakHash = await bcrypt.hash(pak, BCRYPT_ROUNDS);
    const pakPrefix = pak.slice(0, 3);
    const pakSuffix = pak.slice(-4);

    await db.update(usersTable)
      .set({ pakHash, pakPrefix, pakSuffix, pakCreatedAt: new Date(), pakCopiedAt: null })
      .where(eq(usersTable.id, userId));

    // Return the full PAK in plaintext — this is the ONLY time it will be available.
    res.json({
      success: true,
      pak,
      pakPreview: maskPak(pakPrefix, pakSuffix),
      message: "PAK generated. Copy it now — it will not be shown again.",
    });
  } catch (err: any) {
    logger.error({ err }, "[security/pak/generate]");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ── POST /api/security/pak/confirm-copied ─────────────────────────────────────
// The client calls this once the user confirms they have securely stored the PAK.
// After this, the full key is permanently unavailable.

router.post("/pak/confirm-copied", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user?.pakHash) {
      res.status(400).json({ error: "No PAK", message: "No PAK has been generated yet" });
      return;
    }
    await db.update(usersTable).set({ pakCopiedAt: new Date() }).where(eq(usersTable.id, userId));
    res.json({ success: true, message: "PAK confirmed. The full key is now permanently hidden." });
  } catch (err: any) {
    logger.error({ err }, "[security/pak/confirm-copied]");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ── POST /api/security/change-login-password/request-otp ─────────────────────
// Step 1: verify PAK, then send OTP.

router.post("/change-login-password/request-otp", requireAuth, async (req, res) => {
  try {
    const { userId, email } = (req as any).user;
    const { pak } = req.body as { pak?: unknown };

    if (typeof pak !== "string" || !pak.trim()) {
      res.status(400).json({ error: "Validation error", message: "pak is required" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user?.pakHash) {
      res.status(400).json({ error: "No PAK", message: "You must generate a PAK before changing your password" });
      return;
    }

    const pakValid = await bcrypt.compare(pak.trim(), user.pakHash);
    if (!pakValid) {
      res.status(401).json({ error: "Invalid PAK", message: "The authorization key you entered is incorrect" });
      return;
    }

    const code = await issueOtp(userId, "chg-login");
    await sendSecurityOtpEmail(email, code, "chg-login");
    res.json({ sent: true, message: "Verification code sent to your email." });
  } catch (err: any) {
    logger.error({ err }, "[security/change-login-password/request-otp]");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ── POST /api/security/change-login-password/confirm ─────────────────────────
// Step 2: verify PAK again + OTP, then update the login password.

router.post("/change-login-password/confirm", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { pak, newPassword, otp } = req.body as { pak?: unknown; newPassword?: unknown; otp?: unknown };

    if (typeof pak !== "string" || typeof newPassword !== "string" || typeof otp !== "string") {
      res.status(400).json({ error: "Validation error", message: "pak, newPassword, and otp are required" });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: "Validation error", message: "New password must be at least 8 characters" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user?.pakHash) {
      res.status(400).json({ error: "No PAK", message: "You must generate a PAK before changing your password" });
      return;
    }

    const pakValid = await bcrypt.compare(pak.trim(), user.pakHash);
    if (!pakValid) {
      res.status(401).json({ error: "Invalid PAK", message: "The authorization key you entered is incorrect" });
      return;
    }

    const otpValid = await verifyOtp(userId, otp, "chg-login");
    if (!otpValid) {
      res.status(401).json({ error: "Invalid code", message: "OTP is invalid or has expired" });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, userId));

    res.json({ success: true, message: "Login password updated successfully." });
  } catch (err: any) {
    logger.error({ err }, "[security/change-login-password/confirm]");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ── POST /api/security/change-txn-password/request-otp ───────────────────────
// Step 1: verify PAK, then send OTP.

router.post("/change-txn-password/request-otp", requireAuth, async (req, res) => {
  try {
    const { userId, email } = (req as any).user;
    const { pak } = req.body as { pak?: unknown };

    if (typeof pak !== "string" || !pak.trim()) {
      res.status(400).json({ error: "Validation error", message: "pak is required" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user?.pakHash) {
      res.status(400).json({ error: "No PAK", message: "You must generate a PAK before changing your transaction password" });
      return;
    }

    const pakValid = await bcrypt.compare(pak.trim(), user.pakHash);
    if (!pakValid) {
      res.status(401).json({ error: "Invalid PAK", message: "The authorization key you entered is incorrect" });
      return;
    }

    const code = await issueOtp(userId, "chg-txn-pwd");
    await sendSecurityOtpEmail(email, code, "chg-txn-pwd");
    res.json({ sent: true, message: "Verification code sent to your email." });
  } catch (err: any) {
    logger.error({ err }, "[security/change-txn-password/request-otp]");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

// ── POST /api/security/change-txn-password/confirm ───────────────────────────
// Step 2: verify PAK again + OTP, then update the transaction password.

router.post("/change-txn-password/confirm", requireAuth, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { pak, newPassword, otp } = req.body as { pak?: unknown; newPassword?: unknown; otp?: unknown };

    if (typeof pak !== "string" || typeof newPassword !== "string" || typeof otp !== "string") {
      res.status(400).json({ error: "Validation error", message: "pak, newPassword, and otp are required" });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: "Validation error", message: "Transaction password must be at least 6 characters" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user?.pakHash) {
      res.status(400).json({ error: "No PAK", message: "You must generate a PAK before changing your transaction password" });
      return;
    }

    const pakValid = await bcrypt.compare(pak.trim(), user.pakHash);
    if (!pakValid) {
      res.status(401).json({ error: "Invalid PAK", message: "The authorization key you entered is incorrect" });
      return;
    }

    const otpValid = await verifyOtp(userId, otp, "chg-txn-pwd");
    if (!otpValid) {
      res.status(401).json({ error: "Invalid code", message: "OTP is invalid or has expired" });
      return;
    }

    const transactionPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await db.update(usersTable).set({ transactionPasswordHash }).where(eq(usersTable.id, userId));

    res.json({ success: true, message: "Transaction password updated successfully." });
  } catch (err: any) {
    logger.error({ err }, "[security/change-txn-password/confirm]");
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
});

export default router;
