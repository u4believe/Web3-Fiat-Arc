import nodemailer from "nodemailer";

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = parseInt(process.env.SMTP_PORT ?? "587", 10);

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    family: 4, // force IPv4 — WSL2 cannot reach IPv6 SMTP servers
  });
}

const FROM = process.env.SMTP_FROM ?? "USDC Send <no-reply@usdcsend.app>";

export async function sendRecurringSuccessEmail(
  to: string,
  amount: string,
  recipientEmail: string,
  newBalance: string,
  nextRunAt: Date,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">

        <!-- Logo -->
        <tr><td align="center" style="padding-bottom:24px;">
          <div style="width:48px;height:48px;background:linear-gradient(135deg,#2563eb,#7c3aed);border-radius:14px;display:inline-flex;align-items:center;justify-content:center;">
            <span style="color:#fff;font-size:22px;">↗</span>
          </div>
          <p style="margin:8px 0 0;font-weight:700;font-size:18px;color:#0f172a;">USDC Send</p>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#fff;border-radius:20px;padding:40px 36px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
          <!-- Status badge -->
          <div style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:99px;background:#dcfce7;margin-bottom:20px;">
            <span style="width:8px;height:8px;border-radius:50%;background:#16a34a;display:inline-block;"></span>
            <span style="font-size:12px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.5px;">Transfer Successful</span>
          </div>

          <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;">Recurring transfer sent</p>
          <p style="margin:0 0 28px;color:#64748b;font-size:15px;line-height:1.6;">
            Your scheduled transfer was processed successfully.
          </p>

          <!-- Amount block -->
          <div style="background:#f1f5f9;border-radius:14px;padding:20px 24px;margin-bottom:24px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <span style="color:#64748b;font-size:13px;">Amount sent</span>
              <span style="font-size:20px;font-weight:800;color:#0f172a;">$${parseFloat(amount).toFixed(2)} USD</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <span style="color:#64748b;font-size:13px;">Recipient</span>
              <span style="font-size:13px;font-weight:600;color:#1e293b;">${recipientEmail}</span>
            </div>
            <div style="height:1px;background:#e2e8f0;margin:10px 0;"></div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <span style="color:#64748b;font-size:13px;">New balance</span>
              <span style="font-size:13px;font-weight:600;color:#1e293b;">$${parseFloat(newBalance).toFixed(2)} USD</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="color:#64748b;font-size:13px;">Next transfer</span>
              <span style="font-size:13px;font-weight:600;color:#1e293b;">${nextRunAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
            </div>
          </div>

          <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
            The recipient will be notified and can claim the funds from their USDC Send account.<br>
            You can manage or cancel your recurring transfers from your dashboard.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 0;text-align:center;">
          <p style="margin:0;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} USDC Send. All rights reserved.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const transporter = getTransporter();

  if (!transporter) {
    console.log(`\n──────────────────────────────────────────────`);
    console.log(`  RECURRING TRANSFER SUCCESS for ${to}`);
    console.log(`  Sent $${amount} to ${recipientEmail} | New balance: $${newBalance}`);
    console.log(`  Next run: ${nextRunAt.toISOString()}`);
    console.log(`  (Configure SMTP_HOST/SMTP_USER/SMTP_PASS to send real emails)`);
    console.log(`──────────────────────────────────────────────\n`);
    return;
  }

  await transporter.sendMail({
    from: FROM,
    to,
    subject: `Recurring transfer of $${parseFloat(amount).toFixed(2)} sent to ${recipientEmail}`,
    html,
  });
}

export async function sendRecurringFailureEmail(
  to: string,
  amount: string,
  recipientEmail: string,
  currentBalance: string,
  nextRunAt: Date,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">

        <!-- Logo -->
        <tr><td align="center" style="padding-bottom:24px;">
          <div style="width:48px;height:48px;background:linear-gradient(135deg,#2563eb,#7c3aed);border-radius:14px;display:inline-flex;align-items:center;justify-content:center;">
            <span style="color:#fff;font-size:22px;">↗</span>
          </div>
          <p style="margin:8px 0 0;font-weight:700;font-size:18px;color:#0f172a;">USDC Send</p>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#fff;border-radius:20px;padding:40px 36px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
          <!-- Status badge -->
          <div style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:99px;background:#fef3c7;margin-bottom:20px;">
            <span style="width:8px;height:8px;border-radius:50%;background:#d97706;display:inline-block;"></span>
            <span style="font-size:12px;font-weight:700;color:#d97706;text-transform:uppercase;letter-spacing:0.5px;">Transfer Skipped</span>
          </div>

          <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;">Insufficient balance</p>
          <p style="margin:0 0 28px;color:#64748b;font-size:15px;line-height:1.6;">
            Your recurring transfer was skipped because your balance is too low. We'll try again at the next scheduled interval.
          </p>

          <!-- Amount block -->
          <div style="background:#fef9f0;border:1px solid #fde68a;border-radius:14px;padding:20px 24px;margin-bottom:24px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <span style="color:#92400e;font-size:13px;">Required amount</span>
              <span style="font-size:20px;font-weight:800;color:#0f172a;">$${parseFloat(amount).toFixed(2)} USD</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <span style="color:#92400e;font-size:13px;">Your balance</span>
              <span style="font-size:13px;font-weight:600;color:#dc2626;">$${parseFloat(currentBalance).toFixed(2)} USD</span>
            </div>
            <div style="height:1px;background:#fde68a;margin:10px 0;"></div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <span style="color:#92400e;font-size:13px;">Recipient</span>
              <span style="font-size:13px;font-weight:600;color:#1e293b;">${recipientEmail}</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="color:#92400e;font-size:13px;">Next attempt</span>
              <span style="font-size:13px;font-weight:600;color:#1e293b;">${nextRunAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
            </div>
          </div>

          <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
            To ensure future transfers succeed, please top up your balance before ${nextRunAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}.<br>
            You can also cancel this recurring transfer from your dashboard if you no longer need it.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 0;text-align:center;">
          <p style="margin:0;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} USDC Send. All rights reserved.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const transporter = getTransporter();

  if (!transporter) {
    console.log(`\n──────────────────────────────────────────────`);
    console.log(`  RECURRING TRANSFER SKIPPED for ${to}`);
    console.log(`  Needed $${amount} but only have $${currentBalance} | Recipient: ${recipientEmail}`);
    console.log(`  Next attempt: ${nextRunAt.toISOString()}`);
    console.log(`  (Configure SMTP_HOST/SMTP_USER/SMTP_PASS to send real emails)`);
    console.log(`──────────────────────────────────────────────\n`);
    return;
  }

  await transporter.sendMail({
    from: FROM,
    to,
    subject: `Recurring transfer to ${recipientEmail} was skipped — insufficient balance`,
    html,
  });
}

export async function sendOtpEmail(to: string, code: string, type: "register" | "login"): Promise<void> {
  const subject = type === "register"
    ? "Verify your USDC Send account"
    : "Your USDC Send sign-in code";

  const action = type === "register" ? "create your account" : "sign in";

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">

        <!-- Logo -->
        <tr><td align="center" style="padding-bottom:24px;">
          <div style="width:48px;height:48px;background:linear-gradient(135deg,#2563eb,#7c3aed);border-radius:14px;display:inline-flex;align-items:center;justify-content:center;">
            <span style="color:#fff;font-size:22px;">↗</span>
          </div>
          <p style="margin:8px 0 0;font-weight:700;font-size:18px;color:#0f172a;">USDC Send</p>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#fff;border-radius:20px;padding:40px 36px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
          <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;">
            ${type === "register" ? "Verify your email" : "Your sign-in code"}
          </p>
          <p style="margin:0 0 32px;color:#64748b;font-size:15px;line-height:1.6;">
            Use the code below to ${action}. It expires in <strong>10 minutes</strong>.
          </p>

          <!-- OTP code -->
          <div style="background:#f1f5f9;border-radius:14px;padding:24px;text-align:center;margin-bottom:32px;">
            <span style="font-family:'Courier New',monospace;font-size:40px;font-weight:800;letter-spacing:12px;color:#1e293b;">${code}</span>
          </div>

          <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
            If you didn't request this, you can safely ignore this email.<br>
            Never share this code with anyone.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 0;text-align:center;">
          <p style="margin:0;color:#94a3b8;font-size:12px;">
            &copy; ${new Date().getFullYear()} USDC Send. All rights reserved.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const transporter = getTransporter();

  if (!transporter) {
    console.log(`\n──────────────────────────────────────────────`);
    console.log(`  OTP CODE for ${to}`);
    console.log(`  Code: ${code}  (type: ${type})`);
    console.log(`  (Configure SMTP_HOST/SMTP_USER/SMTP_PASS to send real emails)`);
    console.log(`──────────────────────────────────────────────\n`);
    return;
  }

  await transporter.sendMail({
    from: FROM,
    to,
    subject,
    html,
  });
}

const SECURITY_ACTION_LABELS: Record<string, { subject: string; heading: string; desc: string }> = {
  "txn-pwd":     { subject: "Set your transaction password",         heading: "Set transaction password", desc: "to set your transaction password" },
  "pak-gen":     { subject: "Generate your Personal Authorization Key", heading: "Generate PAK",          desc: "to generate your Personal Authorization Key (PAK)" },
  "chg-login":   { subject: "Change your sign-in password",          heading: "Change sign-in password",  desc: "to change your sign-in password" },
  "chg-txn-pwd": { subject: "Change your transaction password",      heading: "Change transaction password", desc: "to change your transaction password" },
};

export async function sendSecurityOtpEmail(to: string, code: string, actionType: string): Promise<void> {
  const meta = SECURITY_ACTION_LABELS[actionType] ?? {
    subject: "Security verification code",
    heading: "Verification required",
    desc: "to complete this action",
  };

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">

        <!-- Logo -->
        <tr><td align="center" style="padding-bottom:24px;">
          <div style="width:48px;height:48px;background:linear-gradient(135deg,#2563eb,#7c3aed);border-radius:14px;display:inline-flex;align-items:center;justify-content:center;">
            <span style="color:#fff;font-size:22px;">↗</span>
          </div>
          <p style="margin:8px 0 0;font-weight:700;font-size:18px;color:#0f172a;">USDC Send</p>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#fff;border-radius:20px;padding:40px 36px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
          <!-- Security badge -->
          <div style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:99px;background:#ede9fe;margin-bottom:20px;">
            <span style="font-size:12px;">🔒</span>
            <span style="font-size:12px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:0.5px;">Security Action</span>
          </div>

          <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;">${meta.heading}</p>
          <p style="margin:0 0 32px;color:#64748b;font-size:15px;line-height:1.6;">
            Use the code below ${meta.desc}. It expires in <strong>10 minutes</strong>.
          </p>

          <!-- OTP code -->
          <div style="background:#f1f5f9;border-radius:14px;padding:24px;text-align:center;margin-bottom:32px;">
            <span style="font-family:'Courier New',monospace;font-size:40px;font-weight:800;letter-spacing:12px;color:#1e293b;">${code}</span>
          </div>

          <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:12px;padding:16px;margin-bottom:24px;">
            <p style="margin:0;color:#92400e;font-size:13px;line-height:1.6;">
              <strong>⚠ Security notice:</strong> If you did not initiate this action, your account may be at risk. Do not share this code with anyone — USDC Send will never ask for it.
            </p>
          </div>

          <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
            This code was requested for your USDC Send account.<br>
            If you didn't request this, you can safely ignore this email.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 0;text-align:center;">
          <p style="margin:0;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} USDC Send. All rights reserved.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const transporter = getTransporter();

  if (!transporter) {
    console.log(`\n──────────────────────────────────────────────`);
    console.log(`  SECURITY OTP for ${to}  [${actionType}]`);
    console.log(`  Code: ${code}  (expires in 10 minutes)`);
    console.log(`  (Configure SMTP_HOST/SMTP_USER/SMTP_PASS to send real emails)`);
    console.log(`──────────────────────────────────────────────\n`);
    return;
  }

  await transporter.sendMail({ from: FROM, to, subject: meta.subject, html });
}
