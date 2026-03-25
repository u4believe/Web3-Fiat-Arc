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
  });
}

const FROM = process.env.SMTP_FROM ?? "USDC Send <no-reply@usdcsend.app>";

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
