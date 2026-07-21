// Opt-in round-up email via Resend. The whole thing is inert unless
// RESEND_API_KEY is set — the package is imported lazily so `next build` and
// runtime never require the key. Never logs the key or recipient content.

/** True when email delivery is configured (key present). Cheap; safe on client via a server prop. */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

const DEFAULT_FROM = "dlectroflow <onboarding@resend.dev>";

export type EmailResult =
  { ok: true } | { ok: false; reason: "disabled" | "no-recipient" | "error" };

/**
 * Send the round-up email. No-ops (without throwing) when Resend isn't
 * configured or there's no recipient, so callers can always call it safely.
 */
export async function sendRoundupEmail(
  to: string | null | undefined,
  subject: string,
  html: string,
): Promise<EmailResult> {
  if (!emailConfigured()) return { ok: false, reason: "disabled" };
  const recipient = (to ?? "").trim();
  if (!recipient) return { ok: false, reason: "no-recipient" };

  try {
    // Lazy import: only pulled in when actually sending.
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.ROUNDUP_FROM_EMAIL || DEFAULT_FROM;
    const { error } = await resend.emails.send({
      from,
      to: recipient,
      subject,
      html,
    });
    if (error) return { ok: false, reason: "error" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Minimal, warm HTML wrapper for the recap narrative. */
export function roundupEmailHtml(opts: {
  narrative: string;
  stepsDone: number;
  focusMin: number;
  sessions: number;
  points: number;
  streakDay: number;
  spark?: string | null;
}): string {
  const stat = (label: string, value: string | number) =>
    `<td style="padding:8px 14px;background:#faf7f2;border-radius:10px;text-align:center">
       <div style="font-size:20px;font-weight:600;color:#b45309">${value}</div>
       <div style="font-size:11px;color:#78716c">${label}</div>
     </td>`;
  const narrativeHtml = opts.narrative
    .split(/\n{2,}/)
    .map(
      (p) => `<p style="margin:0 0 12px;line-height:1.6">${escapeHtml(p)}</p>`,
    )
    .join("");
  return `<div style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#1c1917">
    <h1 style="font-size:20px;margin:0 0 4px">🌇 Your day, wrapped</h1>
    <div style="font-size:15px;color:#44403c;margin-bottom:18px">${narrativeHtml}</div>
    <table role="presentation" cellspacing="8" style="margin:0 0 18px"><tr>
      ${stat("steps done", opts.stepsDone)}
      ${stat("focus mins", opts.focusMin)}
      ${stat("sessions", opts.sessions)}
      ${stat("points", opts.points)}
      ${stat("streak", `${opts.streakDay}${opts.streakDay > 0 ? "🔥" : ""}`)}
    </tr></table>
    ${opts.spark ? `<p style="font-size:14px;color:#78716c;font-style:italic">✨ ${escapeHtml(opts.spark)}</p>` : ""}
    <p style="font-size:12px;color:#a8a29e;margin-top:24px">Sent by dlectroflow · you enabled the daily round-up email.</p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
