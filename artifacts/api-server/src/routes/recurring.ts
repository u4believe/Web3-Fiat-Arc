import { Router, type IRouter } from "express";
import { db, recurringTransfersTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcrypt";
import { requireAuth } from "../lib/auth.js";
import { CreateRecurringBody, CancelRecurringBody } from "@workspace/api-zod";

const router: IRouter = Router();

// GET /api/recurring
router.get("/", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    
    const activeTransfers = await db
      .select()
      .from(recurringTransfersTable)
      .where(eq(recurringTransfersTable.senderUserId, user.userId));

    res.json(
      activeTransfers.map((t) => ({
        id: t.id,
        recipientEmail: t.recipientEmail,
        amount: t.amount.toString(),
        interval: t.interval,
        nextRunAt: t.nextRunAt.toISOString(),
        endDate: t.endDate?.toISOString() ?? null,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
      }))
    );
  } catch (error: any) {
    req.log.error({ err: error }, "[recurring/get] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// POST /api/recurring
router.post("/", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const parsed = CreateRecurringBody.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", message: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const { recipientEmail, amount, interval, endDate } = parsed.data;

    if (recipientEmail === user.email.toLowerCase()) {
      res.status(400).json({ error: "Invalid recipient", message: "You cannot schedule transfers to yourself" });
      return;
    }

    // Enforce transaction password if the user has one set
    const [sender] = await db.select().from(usersTable).where(eq(usersTable.id, user.userId)).limit(1);
    if (sender?.transactionPasswordHash) {
      const txnPwd = typeof req.body.transactionPassword === "string" ? req.body.transactionPassword : "";
      if (!txnPwd) {
        res.status(403).json({ error: "Transaction password required", message: "Please enter your transaction password to authorize this recurring transfer" });
        return;
      }
      const txnPwdValid = await bcrypt.compare(txnPwd, sender.transactionPasswordHash);
      if (!txnPwdValid) {
        res.status(403).json({ error: "Invalid transaction password", message: "The transaction password you entered is incorrect" });
        return;
      }
    }
    
    let nextRunAt = new Date();
    if (interval === "daily") {
      nextRunAt.setDate(nextRunAt.getDate() + 1);
    } else if (interval === "weekly") {
      nextRunAt.setDate(nextRunAt.getDate() + 7);
    } else if (interval === "monthly") {
      nextRunAt.setMonth(nextRunAt.getMonth() + 1);
    }

    let endDt = null;
    if (endDate) {
      endDt = new Date(endDate);
      if (endDt <= new Date()) {
        res.status(400).json({ error: "Invalid execution data", message: "End date must be in the future" });
        return;
      }
    }

    const [newRecurring] = await db
      .insert(recurringTransfersTable)
      .values({
        senderUserId: user.userId,
        senderEmail: user.email,
        recipientEmail,
        amount,
        interval,
        nextRunAt,
        endDate: endDt,
        status: "active",
      })
      .returning();

    res.json({
      success: true,
      recurringId: newRecurring.id,
      message: `Recurring transfer of $${amount} ${interval} created successfully. First execution on ${nextRunAt.toLocaleDateString()}.`
    });
  } catch (error: any) {
    req.log.error({ err: error }, "[recurring/post] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

// DELETE /api/recurring/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const recurringIdRaw = parseInt(req.params["id"] || "");

    if (isNaN(recurringIdRaw) || recurringIdRaw <= 0) {
      res.status(400).json({ error: "Validation error", message: "Invalid recurring transfer ID" });
      return;
    }

    const [existing] = await db
      .select()
      .from(recurringTransfersTable)
      .where(
        and(
          eq(recurringTransfersTable.id, recurringIdRaw),
          eq(recurringTransfersTable.senderUserId, user.userId)
        )
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Not found", message: "Recurring transfer not found" });
      return;
    }
    
    if (existing.status === "cancelled") {
      res.status(400).json({ error: "Validation error", message: "Recurring transfer is already cancelled" });
      return;
    }

    await db
      .update(recurringTransfersTable)
      .set({ status: "cancelled" })
      .where(eq(recurringTransfersTable.id, recurringIdRaw));

    res.json({ success: true, message: "Recurring transfer cancelled successfully." });
  } catch (error: any) {
    req.log.error({ err: error }, "[recurring/delete] Error");
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
});

export default router;
