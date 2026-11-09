// shared/emailProvider.js - RTS Email System (Brevo-only, self-loading, diagnostic)
//
// [FIX-EMAIL-ATTACH] **Attachment support for PDF reports.**
//
//   sendEmail(to, subject, htmlContent, options?) now accepts:
//     • options.attachments — array of { filename, content: Buffer|base64 }
//     • options.cc          — array of cc email addresses
//
//   The attachments are base64-encoded and passed to Brevo via the
//   `attachment` field of their SMTP API. Existing callers pass 3 args
//   and are unchanged — options defaults to {} and no attachments are
//   built.
//
//   **Fallback behaviour**: if a send with attachments fails with an
//   attachment-related error (size, format, quota), the file automatically
//   retries once WITHOUT attachments. The report content (HTML body) still
//   delivers, and the return value includes `warning: 'Attachments dropped: ...'`
//   so the caller can detect that the PDF didn't make it.
//
//   **Size limits**: Brevo caps single attachments at 10 MB and total
//   at 25 MB. This file enforces 10 MB single / 20 MB total as a safety
//   margin. Oversized PDFs are skipped with a stderr log; smaller
//   attachments still go through.
//
//   **Timeout bumped 15s → 30s** — a PDF attachment makes the request
//   heavier. 15s was cutting off real reports on slow networks.

const path = require('path');

// Load .env from project root, no matter who requires this file
try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) { /* dotenv optional; env can be injected externally */ }

const axios = require('axios');

/* =========================================================
   CONFIG
========================================================= */

const APP_NAME = 'VIRALOOP';
const APP_URL = process.env.APP_URL || 'https://voxtraapp.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'esilesirayland@gmail.com';

// Brevo attachment limits (conservative — Brevo's documented limit is
// 10 MB single / 25 MB total).
const MAX_SINGLE_ATTACHMENT_BYTES = 10 * 1024 * 1024;   // 10 MB
const MAX_TOTAL_ATTACHMENT_BYTES  = 20 * 1024 * 1024;   // 20 MB

// Read at send-time, not module-load-time, so late env injection works
function getBrevoKey() {
    return process.env.BREVO_API_KEY || '';
}

/* =========================================================
   EMAIL WRAPPER  (unchanged)
========================================================= */

function getEmailWrapper(content, title) {
    return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${title} - ${APP_NAME}</title>
<style>
body { font-family: Arial, sans-serif; background:#f5f5f5; margin:0; padding:0; }
.container { max-width:520px; margin:auto; background:#fff; padding:20px; border-radius:10px; }
.header { text-align:center; padding:20px; border-bottom:2px solid #22c55e; }
.header h1 { color:#22c55e; margin:0; }
.content { padding:20px; line-height:1.6; }
.button { background:#22c55e; color:#fff; padding:12px 20px; text-decoration:none; border-radius:6px; display:inline-block; margin:10px 0; }
.warning { background:#fef3c7; padding:10px; border-radius:6px; font-size:12px; color:#92400e; margin-top:15px; }
.footer { text-align:center; font-size:12px; color:#888; padding:20px; border-top:1px solid #eee; margin-top:20px; }
.footer a { color:#22c55e; text-decoration:none; }
</style>
</head>
<body>
<div class="container">
    <div class="header"><h1>${APP_NAME}</h1></div>
    <div class="content">${content}</div>
    <div class="footer">
        <p>
            <a href="${APP_URL}/privacy">Privacy</a> |
            <a href="${APP_URL}/terms">Terms</a> |
            <a href="mailto:${SUPPORT_EMAIL}">Support</a>
        </p>
        <p>© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
    </div>
</div>
</body>
</html>
`;
}

/* =========================================================
   [FIX-EMAIL-ATTACH] Attachment normalization
========================================================= */

/**
 * Convert caller-provided attachments into Brevo's expected format.
 * Brevo expects: [{ name: 'file.pdf', content: '<base64-string>' }]
 *
 * Accepts:
 *   • content as Buffer
 *   • content as base64 string
 *   • content as Uint8Array
 *
 * Enforces size limits, skipping oversized files with a stderr log.
 * Returns null if no valid attachments remain.
 */
function buildBrevoAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return null;

    const out = [];
    let totalBytes = 0;

    for (const a of attachments) {
        if (!a || !a.filename || !a.content) {
            console.warn(`[emailProvider] Skipping invalid attachment (missing filename or content)`);
            continue;
        }

        let buf;
        try {
            if (Buffer.isBuffer(a.content)) {
                buf = a.content;
            } else if (typeof a.content === 'string') {
                // Assume base64
                buf = Buffer.from(a.content, 'base64');
            } else if (a.content instanceof Uint8Array) {
                buf = Buffer.from(a.content);
            } else {
                console.warn(`[emailProvider] Skipping attachment ${a.filename}: unsupported content type`);
                continue;
            }
        } catch (err) {
            console.warn(`[emailProvider] Skipping attachment ${a.filename}: ${err.message}`);
            continue;
        }

        if (buf.length > MAX_SINGLE_ATTACHMENT_BYTES) {
            console.error(
                `[emailProvider] Skipping attachment ${a.filename}: ` +
                `${buf.length} bytes exceeds ${MAX_SINGLE_ATTACHMENT_BYTES} byte limit`
            );
            continue;
        }

        if (totalBytes + buf.length > MAX_TOTAL_ATTACHMENT_BYTES) {
            console.error(
                `[emailProvider] Stopping attachments at ${out.length}: ` +
                `total would exceed ${MAX_TOTAL_ATTACHMENT_BYTES} bytes`
            );
            break;
        }

        totalBytes += buf.length;
        out.push({
            name: a.filename,
            content: buf.toString('base64'),
        });
    }

    return out.length > 0 ? out : null;
}

/* =========================================================
   BREVO SENDER  (surface HTTP status + body on error)
   [FIX-EMAIL-ATTACH] Now accepts `options` and forwards attachments.
========================================================= */

async function sendViaBrevo(to, subject, html, options = {}) {
    const key = getBrevoKey();

    if (!key) {
        const err = new Error('BREVO_API_KEY is not set. Add BREVO_API_KEY=xkeysib-... to .env');
        err.httpStatus = 'NO_KEY';
        throw err;
    }

    const payload = {
        sender: {
            name: APP_NAME,
            email: SUPPORT_EMAIL
        },
        to: [{ email: to }],
        subject,
        htmlContent: html
    };

    // [FIX-EMAIL-ATTACH] Optional cc
    if (Array.isArray(options.cc) && options.cc.length > 0) {
        payload.cc = options.cc
            .filter(e => typeof e === 'string' && e.includes('@'))
            .map(e => ({ email: e }));
        if (payload.cc.length === 0) delete payload.cc;
    }

    // [FIX-EMAIL-ATTACH] Optional attachments
    const brevoAttachments = buildBrevoAttachments(options.attachments);
    if (brevoAttachments) {
        payload.attachment = brevoAttachments;
    }

    try {
        const response = await axios.post(
            'https://api.brevo.com/v3/smtp/email',
            payload,
            {
                headers: {
                    'api-key': key,
                    'Content-Type': 'application/json'
                },
                // [FIX-EMAIL-ATTACH] 30s (was 15s) — PDF uploads take longer
                timeout: 30000,
                maxBodyLength: 25 * 1024 * 1024,   // allow large request bodies
                maxContentLength: 25 * 1024 * 1024,
            }
        );
        return response.data;
    } catch (err) {
        if (err.response) {
            const body = err.response.data;
            const detail = (typeof body === 'string') ? body : JSON.stringify(body);
            const wrapped = new Error(`Brevo HTTP ${err.response.status}: ${detail}`);
            wrapped.httpStatus = err.response.status;
            wrapped.brevoBody = body;
            throw wrapped;
        }
        throw err;
    }
}

/* =========================================================
   CORE EMAIL SENDER  (Brevo only, with diagnostics)
   [FIX-EMAIL-ATTACH] Accepts optional 4th arg `options`.
     - Existing 3-arg callers work identically.
     - On attachment-specific errors, retries WITHOUT attachments so
       the HTML content still delivers.
========================================================= */

async function sendEmail(to, subject, htmlContent, options = {}) {
    const html = getEmailWrapper(htmlContent, subject);
    const key = getBrevoKey();
    const hasAttachments = !!(options.attachments && options.attachments.length);

    const diagnostics = {
        provider: 'brevo',
        sender: SUPPORT_EMAIL,
        recipient: to,
        keyPresent: !!key,
        keyPrefix: key ? (key.slice(0, 8) + '...') : '(none)',
        keyLength: key.length,
        attachments: hasAttachments ? options.attachments.length : 0,
    };

    if (!key) {
        const msg = 'BREVO_API_KEY is not set. Add BREVO_API_KEY=xkeysib-... to .env';
        console.error(`❌ ${msg}`);
        console.error(`   Diagnostics: ${JSON.stringify(diagnostics)}`);
        return { success: false, provider: 'brevo', error: msg, diagnostics };
    }

    try {
        const data = await sendViaBrevo(to, subject, html, options);
        console.log(
            `📧 Email sent via Brevo to ${to} ` +
            `(messageId=${data.messageId || 'n/a'}, attachments=${diagnostics.attachments})`
        );
        return { success: true, provider: 'brevo', messageId: data.messageId, diagnostics };
    } catch (err) {
        const status = err.httpStatus || '';
        console.error(`❌ Email send failed to ${to}: ${err.message}`);
        console.error(`   Diagnostics: ${JSON.stringify(diagnostics)}`);

        // [FIX-EMAIL-ATTACH] Fallback: if attachments were included and
        // the error looks attachment-related, retry once without them.
        // The report content still delivers.
        if (hasAttachments && looksLikeAttachmentError(err.message)) {
            console.warn(`[emailProvider] Retrying WITHOUT attachments — original error: ${err.message}`);
            try {
                const retryOptions = { ...options, attachments: [] };
                const retryData = await sendViaBrevo(to, subject, html, retryOptions);
                console.warn(`⚠️  Delivered WITHOUT attachments. Attachment error was: ${err.message}`);
                return {
                    success: true,
                    provider: 'brevo',
                    messageId: retryData.messageId,
                    diagnostics: { ...diagnostics, attachmentsDropped: true },
                    warning: `Attachments dropped due to provider error: ${err.message}`,
                };
            } catch (retryErr) {
                console.error(`❌ Retry without attachments also failed: ${retryErr.message}`);
                // fall through to report the original failure
            }
        }

        if (status === 401 || status === 403) {
            console.error('   => BREVO_API_KEY is wrong or revoked. Regenerate it in Brevo dashboard.');
        }
        if (status === 400) {
            console.error('   => Common causes: SUPPORT_EMAIL sender is not verified in Brevo, invalid recipient, or account limit hit.');
        }
        if (status === 'NO_KEY') {
            console.error('   => Add BREVO_API_KEY to .env');
        }
        if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout/i.test(err.message)) {
            console.error('   => Cannot reach api.brevo.com. Check firewall / DNS / internet.');
        }

        return {
            success: false,
            provider: 'brevo',
            error: err.message,
            httpStatus: status,
            diagnostics
        };
    }
}

/**
 * [FIX-EMAIL-ATTACH] Heuristic: does this error message indicate the
 * attachment caused the failure (vs. credentials / network / recipient)?
 * Used to decide whether to retry without attachments.
 */
function looksLikeAttachmentError(msg) {
    if (!msg) return false;
    const s = String(msg).toLowerCase();
    return (
        s.includes('attachment') ||
        s.includes('file size') ||
        s.includes('too large') ||
        s.includes('payload') ||
        s.includes('content length') ||
        s.includes('base64')
    );
}

/* =========================================================
   TEMPLATED EMAILS  (unchanged)
========================================================= */

async function sendVerificationEmail(email, token) {
    const url = `${APP_URL}/api/auth/verify-email?token=${token}`;
    return sendEmail(email, `Verify Your Email - ${APP_NAME}`, `
        <h2>Welcome to ${APP_NAME}! 🚀</h2>
        <p>Thank you for signing up. Please verify your email address to get started:</p>
        <p style="text-align: center;">
            <a href="${url}" class="button">✅ Verify My Account</a>
        </p>
        <p style="margin-top: 20px; font-size: 12px; color: #666;">
            Or copy and paste this link: ${url}
        </p>
        <div class="warning">
            ⚠️ <strong>Check your spam folder!</strong> If you don't see our email in your inbox, please check your spam/junk folder and mark it as "Not Spam".
        </div>
        <p style="margin-top: 20px; font-size: 12px; color: #999;">
            This link expires in 24 hours. If you didn't create this account, please ignore this email.
        </p>
    `);
}

async function sendWelcomeEmail(email, name) {
    return sendEmail(email, `Welcome to ${APP_NAME}! 🎉`, `
        <h2>Welcome ${name || 'there'}! 👋</h2>
        <p>Your email has been successfully verified. You're now ready to use ${APP_NAME}!</p>
        <p>Here's what you can do:</p>
        <ul>
            <li>📘 Connect your Facebook pages</li>
            <li>📅 Schedule posts in advance</li>
            <li>🤖 Use AI to generate engaging content</li>
            <li>📊 Track your posting performance</li>
        </ul>
        <p style="text-align: center;">
            <a href="${APP_URL}/login" class="button">Go to Dashboard</a>
        </p>
        <p style="margin-top: 20px; font-size: 12px; color: #999;">
            Need help? Contact us at ${SUPPORT_EMAIL}
        </p>
    `);
}

async function sendPasswordResetEmail(email, token) {
    const url = `${APP_URL}/reset-password?token=${token}`;
    return sendEmail(email, `Reset Your Password - ${APP_NAME}`, `
        <h2>Password Reset Request</h2>
        <p>We received a request to reset your password. Click the button below to create a new password:</p>
        <p style="text-align: center;">
            <a href="${url}" class="button">🔑 Reset Password</a>
        </p>
        <p style="margin-top: 20px; font-size: 12px; color: #666;">
            Or copy and paste this link: ${url}
        </p>
        <div class="warning">
            ⚠️ This link expires in 1 hour. If you didn't request this, please ignore this email.
        </div>
    `);
}

async function sendTestEmail(email) {
    return sendEmail(email, `Test Email - ${APP_NAME}`, `<h2>Email System Working ✅</h2><p>Your email system is configured correctly.</p>`);
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
    sendEmail,
    sendWelcomeEmail,
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendTestEmail,
};
