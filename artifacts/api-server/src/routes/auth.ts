import { Router, type IRouter } from "express";
import bcrypt from "bcrypt";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { generateToken, requireAuth } from "../lib/auth.js";
import {
  RegisterUserBody,
  LoginUserBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/register", async (req, res) => {
  try {
    const parsed = RegisterUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.message });
      return;
    }

    const { email, password, name } = parsed.data;

    // Check if email already exists
    const existing = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "Conflict", message: "Email already registered" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [user] = await db.insert(usersTable).values({
      email: email.toLowerCase(),
      passwordHash,
      name,
    }).returning();

    const token = generateToken({ userId: user.id, email: user.email });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        walletAddress: user.walletAddress,
        createdAt: user.createdAt,
      },
    });
  } catch (error: any) {
    req.log.error({ err: error }, "Registration error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const parsed = LoginUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.message });
      return;
    }

    const { email, password } = parsed.data;

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
    if (!user) {
      res.status(401).json({ error: "Unauthorized", message: "Invalid email or password" });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Unauthorized", message: "Invalid email or password" });
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
        createdAt: user.createdAt,
      },
    });
  } catch (error: any) {
    req.log.error({ err: error }, "Login error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1);
    if (!dbUser) {
      res.status(401).json({ error: "Unauthorized", message: "User not found" });
      return;
    }

    res.json({
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      walletAddress: dbUser.walletAddress,
      createdAt: dbUser.createdAt,
    });
  } catch (error: any) {
    req.log.error({ err: error }, "Get current user error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

export default router;
