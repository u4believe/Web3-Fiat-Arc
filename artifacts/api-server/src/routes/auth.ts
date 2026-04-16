import { Router, type IRouter } from "express";
import bcrypt from "bcrypt";
import { db, usersTable, otpCodesTable } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import { generateToken, requireAuth } from "../lib/auth.js";
import { hashEmail } from "../lib/escrow.js";
import { createUserCircleWallet } from "../lib/circle.js";
import { sendOtpEmail, sendVerificationEmail } from "../lib/email.js";
import { randomUUID } from "node:crypto";
import {
  RegisterUserBody,
  LoginUserBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function issueOtp(userId: number, type: "register" | "login"): Promise<string> {
  const code = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await db.insert(otpCodesTable).values({ userId, code, type, expiresAt });
  return code;
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────
// Creates user account and sends an email verification link.
// The user must click the link before they can perform any transactions.
router.post("/register", async (req, res) => {
  try {
    const parsed = RegisterUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.message });
      return;
    }

    const { email, password, name } = parsed.data;

    const existing = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "Conflict", message: "Email already registered" });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const emailHash = hashEmail(normalizedEmail);
    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = randomUUID();

    const [user] = await db.insert(usersTable).values({
      email: normalizedEmail,
      emailHash,
      passwordHash,
      name,
      emailVerified: false,
      emailVerificationToken: verificationToken,
    } as any).returning();

    // Provision Circle wallet in background
    (async () => {
      try {
        const { walletId, address, walletIdsJson } = await createUserCircleWallet(user.id);
        await db.update(usersTable)
          .set({ circleWalletId: walletId, circleWalletAddress: address, circleWalletIdsJson: walletIdsJson } as any)
          .where(eq(usersTable.id, user.id));
      } catch (e: any) {
        console.warn(`[Circle] Wallet provisioning failed for user ${user.id}:`, e?.message || e);
      }
    })();

    const appUrl = process.env.APP_URL?.replace(/\/$/, "") || `http://localhost:${process.env.PORT || 3001}`;
    const verificationUrl = `${appUrl}/api/auth/verify-email?token=${verificationToken}`;

    res.status(201).json({ requiresEmailVerification: true, email: normalizedEmail });
    sendVerificationEmail(normalizedEmail, verificationUrl).catch((e) =>
      req.log.error({ err: e }, "Failed to send verification email"),
    );
  } catch (error: any) {
    req.log.error({ err: error }, "Registration error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── GET /api/auth/verify-email ───────────────────────────────────────────────
// Clicked from the link in the verification email. Marks email as verified and
// redirects the user to the login page with a ?verified=true flag.
router.get("/verify-email", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";

  if (!token) {
    res.redirect("/login?error=missing-token");
    return;
  }

  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq((usersTable as any).emailVerificationToken, token))
      .limit(1);

    if (!user) {
      res.redirect("/login?error=invalid-token");
      return;
    }

    if ((user as any).emailVerified) {
      // Already verified — just redirect to login
      res.redirect("/login?verified=already");
      return;
    }

    await db.update(usersTable)
      .set({ emailVerified: true, emailVerificationToken: null } as any)
      .where(eq(usersTable.id, user.id));

    req.log.info({ userId: user.id }, "[auth] Email verified");
    res.redirect("/login?verified=true");
  } catch (error: any) {
    req.log.error({ err: error }, "Email verification error");
    res.redirect("/login?error=server-error");
  }
});

// ─── POST /api/auth/resend-verification ──────────────────────────────────────
// Sends a fresh verification email for an unverified account.
router.post("/resend-verification", async (req, res) => {
  const { email } = req.body as { email?: unknown };
  if (typeof email !== "string" || !email.trim()) {
    res.status(400).json({ error: "Validation error", message: "email is required" });
    return;
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);

    // Always return success to avoid email enumeration
    res.json({ success: true, message: "If that email exists and is unverified, a new link has been sent." });

    if (!user || (user as any).emailVerified) return;

    const verificationToken = randomUUID();
    await db.update(usersTable)
      .set({ emailVerificationToken: verificationToken } as any)
      .where(eq(usersTable.id, user.id));

    const appUrl = process.env.APP_URL?.replace(/\/$/, "") || `http://localhost:${process.env.PORT || 3001}`;
    const verificationUrl = `${appUrl}/api/auth/verify-email?token=${verificationToken}`;
    sendVerificationEmail(normalizedEmail, verificationUrl).catch(console.error);
  } catch (error: any) {
    req.log.error({ err: error }, "Resend verification error");
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
// Step 1: validates credentials, sends OTP.
// Returns { requiresOtp: true, userId } — JWT issued after verify-otp.
router.post("/login", async (req, res) => {
  try {
    const parsed = LoginUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.message });
      return;
    }

    const { email, password } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);
    if (!user) {
      res.status(401).json({ error: "Unauthorized", message: "Invalid email or password" });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Unauthorized", message: "Invalid email or password" });
      return;
    }

    if (!user.emailHash) {
      await db.update(usersTable)
        .set({ emailHash: hashEmail(normalizedEmail) })
        .where(eq(usersTable.id, user.id));
    }

    if (!user.circleWalletAddress) {
      (async () => {
        try {
          const { walletId, address, walletIdsJson } = await createUserCircleWallet(user.id);
          await db.update(usersTable)
            .set({ circleWalletId: walletId, circleWalletAddress: address, circleWalletIdsJson: walletIdsJson } as any)
            .where(eq(usersTable.id, user.id));
        } catch (e: any) {
          console.warn(`[Circle] Wallet backfill failed for user ${user.id}:`, e?.message || e);
        }
      })();
    }

    const code = await issueOtp(user.id, "login");
    res.json({ requiresOtp: true, userId: user.id });
    sendOtpEmail(normalizedEmail, code, "login").catch((e) =>
      req.log.error({ err: e }, "Failed to send login OTP email"),
    );
  } catch (error: any) {
    req.log.error({ err: error }, "Login error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/auth/verify-otp ────────────────────────────────────────────────
// Step 2 (both flows): verifies OTP, issues JWT.
router.post("/verify-otp", async (req, res) => {
  try {
    const { userId, code, type } = req.body as { userId?: unknown; code?: unknown; type?: unknown };

    if (typeof userId !== "number" || typeof code !== "string" || (type !== "register" && type !== "login")) {
      res.status(400).json({ error: "Validation error", message: "userId (number), code (string), and type (register|login) are required" });
      return;
    }

    const now = new Date();
    const [otp] = await db
      .select()
      .from(otpCodesTable)
      .where(
        and(
          eq(otpCodesTable.userId, userId),
          eq(otpCodesTable.type, type),
          eq(otpCodesTable.used, false),
          gt(otpCodesTable.expiresAt, now),
        )
      )
      .orderBy(otpCodesTable.createdAt)
      .limit(1);

    if (!otp) {
      res.status(401).json({ error: "Invalid code", message: "OTP is invalid or has expired. Please request a new one." });
      return;
    }

    if (otp.code !== code.trim()) {
      res.status(401).json({ error: "Invalid code", message: "Incorrect verification code. Please try again." });
      return;
    }

    await db.update(otpCodesTable).set({ used: true }).where(eq(otpCodesTable.id, otp.id));

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) {
      res.status(404).json({ error: "Not found", message: "User not found" });
      return;
    }

    const token = generateToken({ userId: user.id, email: user.email });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        walletAddress: user.walletAddress,
        circleWalletAddress: user.circleWalletAddress,
        createdAt: user.createdAt,
      },
    });
  } catch (error: any) {
    req.log.error({ err: error }, "Verify OTP error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── POST /api/auth/resend-otp ────────────────────────────────────────────────
// Resend OTP for a pending verification.
router.post("/resend-otp", async (req, res) => {
  try {
    const { userId, type } = req.body as { userId?: unknown; type?: unknown };

    if (typeof userId !== "number" || (type !== "register" && type !== "login")) {
      res.status(400).json({ error: "Validation error", message: "userId and type are required" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) {
      res.status(404).json({ error: "Not found", message: "User not found" });
      return;
    }

    const code = await issueOtp(userId, type);
    res.json({ success: true, message: "A new verification code has been sent to your email." });
    sendOtpEmail(user.email, code, type).catch((e) =>
      req.log.error({ err: e }, "Failed to resend OTP email"),
    );
  } catch (error: any) {
    req.log.error({ err: error }, "Resend OTP error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1);
    if (!dbUser) {
      res.status(401).json({ error: "Unauthorized", message: "User not found" });
      return;
    }

    if (!dbUser.circleWalletAddress) {
      (async () => {
        try {
          const { walletId, address, walletIdsJson } = await createUserCircleWallet(dbUser.id);
          await db.update(usersTable)
            .set({ circleWalletId: walletId, circleWalletAddress: address, circleWalletIdsJson: walletIdsJson } as any)
            .where(eq(usersTable.id, dbUser.id));
        } catch (e: any) {
          console.warn(`[Circle] Wallet backfill failed for user ${dbUser.id}:`, e?.message || e);
        }
      })();
    }

    const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
    const hasPak = !!dbUser.pakHash;
    let pakCanRegenerate = !hasPak;
    let nextPakAllowedAt: string | null = null;
    if (hasPak && dbUser.pakCreatedAt) {
      const elapsed = Date.now() - dbUser.pakCreatedAt.getTime();
      pakCanRegenerate = elapsed >= SIX_MONTHS_MS;
      if (!pakCanRegenerate) {
        nextPakAllowedAt = new Date(dbUser.pakCreatedAt.getTime() + SIX_MONTHS_MS).toISOString();
      }
    }

    res.json({
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      walletAddress: dbUser.walletAddress,
      circleWalletAddress: dbUser.circleWalletAddress,
      createdAt: dbUser.createdAt,
      emailVerified: !!(dbUser as any).emailVerified,
      // Security status
      hasTransactionPassword: !!dbUser.transactionPasswordHash,
      hasPak,
      pakCopied: !!dbUser.pakCopiedAt,
      pakPreview: hasPak && dbUser.pakPrefix && dbUser.pakSuffix
        ? `${dbUser.pakPrefix}${"*".repeat(33)}${dbUser.pakSuffix}`
        : null,
      pakCreatedAt: dbUser.pakCreatedAt?.toISOString() ?? null,
      pakCanRegenerate,
      nextPakAllowedAt,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "Get current user error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

export default router;
