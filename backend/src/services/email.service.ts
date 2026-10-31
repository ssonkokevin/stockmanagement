import { config } from '../config/index.js';
import { ApprovalToken } from '../types/index.js';
import { createRequire } from 'module';
import { logSmtpActivity } from '../logging/unified-logger.js';

const require = createRequire(import.meta.url);

function getFromEmail(): string {
  return config.smtp.fromEmail || 'noreply@yourdomain.com';
}

function getRecipients(primaryEmail: string): string[] {
  const recipients = new Set<string>();
  if (primaryEmail) recipients.add(primaryEmail);
  if (config.smtp.defaultTo) {
    for (const email of config.smtp.defaultTo.split(',')) {
      const trimmed = email.trim();
      if (trimmed) recipients.add(trimmed);
    }
  }
  return Array.from(recipients);
}

function isSmtpConfigured(): boolean {
  const server = (config.smtp.server || '').trim();
  const port = config.smtp.port;
  const user = (config.smtp.user || '').trim();
  const password = (config.smtp.password || '').trim();
  const fromEmail = getFromEmail();
  
  const configured = Boolean(server && port && user && password && fromEmail);
  console.log('[EMAIL] SMTP configured:', configured, { server, port, user: !!user, fromEmail: !!fromEmail });
  logSmtpActivity('INF', `SMTP configured=${configured} host=${server || 'n/a'} port=${port} user_set=${Boolean(user)} from_set=${Boolean(fromEmail)}`);
  return configured;
}

export async function sendRawEmail(recipients: string[], subject: string, html: string, text?: string): Promise<boolean> {
  if (!isSmtpConfigured()) {
    logSmtpActivity('ERR', `SMTP not configured — raw email to ${recipients.join(',')} aborted`);
    return false;
  }
  return sendViaSmtp(recipients, subject, html, text);
}

async function sendViaSmtp(recipients: string[], subject: string, html: string, text?: string): Promise<boolean> {
  const smtpPassword = config.smtp.password?.trim() || '';
  const smtpUser = config.smtp.user?.trim() || '';

  logSmtpActivity('INF', `Attempting send recipients=${recipients.join(',')} subject="${subject}" host=${config.smtp.server || 'n/a'} port=${config.smtp.port}`);

  if (!smtpPassword || !smtpUser) {
    logSmtpActivity('ERR', 'Missing SMTP credentials; send aborted');
    return false;
  }

  const nodemailer = require('nodemailer');
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const transporter = nodemailer.createTransport({
        host: config.smtp.server,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        tls: { rejectUnauthorized: false },
        auth: { user: smtpUser, pass: smtpPassword },
        connectionTimeout: 15000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      });

      await transporter.sendMail({
        from: getFromEmail(),
        to: recipients.join(','),
        subject,
        html,
        text,
      });

      logSmtpActivity('INF', `Email sent recipients=${recipients.join(',')} subject="${subject}"${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return true;
    } catch (error: any) {
      logSmtpActivity('ERR', `Email attempt ${attempt}/${maxRetries} failed subject="${subject}" error=${String(error?.message || error)}`);
      if (attempt < maxRetries) {
        const delayMs = attempt * 2000;
        logSmtpActivity('INF', `Retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        logSmtpActivity('ERR', `All ${maxRetries} attempts exhausted for recipients=${recipients.join(',')}`);
        return false;
      }
    }
  }
  return false;
}

interface ApprovalEmailData {
  request_id: string;
  token?: string;
  approver_email: string;
  approver_role?: string;
  approver_name?: string;
  status: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  // Additional details for the email
  mvno_name?: string;
  mvno_id?: string;
  sim_type?: string;
  quantity?: number;
  distributor_name?: string;
  assigned_boxes?: Array<{
    box_id: string; 
    box_number?: string; 
    carton_number?: string; 
    quantity: number;
    iccid_start?: string;
    iccid_end?: string;
  }>;
  assigned_esims?: string[];
}

export async function sendApprovalEmail(data: ApprovalEmailData, baseUrl: string, reqHeaders?: any): Promise<boolean> {
  // Derive frontend URL: FRONTEND_URL env var → request Origin header → baseUrl fallback
  let frontendUrl = config.app.frontendUrl;
  if (!frontendUrl) {
    // Try to extract from request headers (Origin or Referer)
    const origin = reqHeaders?.origin || reqHeaders?.referer || reqHeaders?.Origin || reqHeaders?.Referer;
    if (origin) {
      frontendUrl = origin.replace(/\/api\/?$/, '');
    } else if (baseUrl) {
      // Fallback to baseUrl but convert backend port to frontend port
      frontendUrl = baseUrl.replace(/\/api\/?$/, '').replace(':3001', ':5173');
    }
  }
  // Safety check - if still no frontendUrl, log error but still construct a relative URL
  if (!frontendUrl) {
    console.error('[EMAIL] No FRONTEND_URL set and could not derive from request. Set FRONTEND_URL env var in production.');
    // Use relative URL as last resort (won't work in email clients, but prevents crash)
    frontendUrl = 'https://your-domain.com';
  }
  const tokenParam = data.token ? `&token=${encodeURIComponent(data.token)}` : '';
  const approvalUrl = `${frontendUrl.replace(/\/$/, '')}/approve-stock?request_id=${encodeURIComponent(data.request_id)}${tokenParam}`;

  // Build stock details HTML
  let stockDetailsHtml = '';
  
  // Handle Physical SIM - show boxes with ICCID range
  if (data.assigned_boxes && data.assigned_boxes.length > 0 && data.sim_type === 'PHYSICAL') {
    stockDetailsHtml = `
      <tr><td colspan="3" style="padding: 8px; background-color: #e9ecef; border-bottom: 1px solid #dee2e6;"><strong>Physical SIM Stock Details</strong></td></tr>
      <tr><td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>Carton / Box</strong></td><td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>ICCID Range</strong></td><td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>Qty</strong></td></tr>
    `;
    data.assigned_boxes.forEach(box => {
      const boxLabel = box.carton_number && box.box_number 
        ? `${box.carton_number} - Box ${box.box_number}` 
        : box.box_id?.slice(0, 8) || 'N/A';
      const iccidRange = (box.iccid_start && box.iccid_end) 
        ? `${box.iccid_start} → ${box.iccid_end}` 
        : (box.iccid_start ? `From: ${box.iccid_start}` : 'N/A');
      stockDetailsHtml += `
        <tr><td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${boxLabel}</td><td style="padding: 8px; border-bottom: 1px solid #dee2e6; font-family: monospace; font-size: 11px;">${iccidRange}</td><td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${box.quantity}</td></tr>
      `;
    });
  }
  
  // Handle eSIM - show ICCIDs
  if (data.assigned_esims && data.assigned_esims.length > 0 && data.sim_type === 'ESIM') {
    const iccidList = data.assigned_esims.slice(0, 50).map(iccid => `<tr><td style="padding: 4px 8px; border-bottom: 1px solid #dee2e6; font-family: monospace; font-size: 12px;">${iccid}</td></tr>`).join('');
    const moreText = data.assigned_esims.length > 50 ? `<tr><td style="padding: 8px; border-bottom: 1px solid #dee2e6; color: #666;">... and ${data.assigned_esims.length - 50} more ICCIDs</td></tr>` : '';
    stockDetailsHtml = `
      <tr><td colspan="2" style="padding: 8px; background-color: #e9ecef; border-bottom: 1px solid #dee2e6;"><strong>eSIM Stock Details (${data.assigned_esims.length} ICCIDs)</strong></td></tr>
      <tr><td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>ICCID</strong></td></tr>
      ${iccidList}
      ${moreText}
    `;
  }

  const greeting = data.approver_name ? `Dear ${data.approver_name}` : 'Hello';
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
      <div style="background: linear-gradient(135deg, #1e2235 0%, #2d3548 100%); padding: 28px 32px; border-radius: 12px 12px 0 0;">
        <h1 style="color: #f0a500; margin: 0; font-size: 20px; font-weight: 700;">📋 Stock Approval Required</h1>
        <p style="color: rgba(255,255,255,0.6); margin: 6px 0 0; font-size: 13px;">SimTrack Pro · Stock Management</p>
      </div>
      <div style="padding: 28px 32px;">
      <p style="font-size: 16px; font-weight: 600; color: #1e2235;">${greeting},</p>
      
      <p style="color: #444; font-size: 14px; line-height: 1.6;">A stock issuance request has been submitted and requires your personal review and approval. Please find the details below:</p>
      
      <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          ${data.distributor_name ? `<tr><td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>Distributor</strong></td><td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${data.distributor_name}</td></tr>` : ''}
          ${data.mvno_name ? `<tr><td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>MVNO</strong></td><td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${data.mvno_name}</td></tr>` : ''}
          <tr><td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>SIM Type</strong></td><td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${data.sim_type || 'N/A'}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>Quantity</strong></td><td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${data.quantity || 0}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>Requested Date</strong></td><td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${new Date(data.created_at).toLocaleDateString()}</td></tr>
        </table>
        
        ${stockDetailsHtml ? `
        <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
          ${stockDetailsHtml}
        </table>
        ` : ''}
      </div>
      
      <p style="color: #444; font-size: 14px;">Please click the button below to review the full details and submit your decision:</p>
      
      <div style="margin: 28px 0; text-align: center;">
        <a href="${approvalUrl}" style="background: linear-gradient(135deg, #f0a500 0%, #d4840a 100%); color: #1e2235; padding: 14px 32px; text-decoration: none; border-radius: 10px; font-weight: 700; font-size: 15px; display: inline-block; box-shadow: 0 4px 12px rgba(240,165,0,0.35);">
          Review &amp; Approve Request
        </a>
      </div>
      
      <p style="color: #888; font-size: 12px;">Or copy this link into your browser:<br><a href="${approvalUrl}" style="color: #f0a500; word-break: break-all;">${approvalUrl}</a></p>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
      
      <p style="color: #bbb; font-size: 11px;">This is an automated notification from SimTrack Pro. If you did not expect this, please ignore it.</p>
      </div>
    </div>
  `;

  // Build text version
  let textDetails = '';
  if (data.distributor_name) textDetails += `Distributor: ${data.distributor_name}\n`;
  if (data.mvno_name) textDetails += `MVNO: ${data.mvno_name}\n`;
  textDetails += `SIM Type: ${data.sim_type || 'N/A'}\n`;
  textDetails += `Quantity: ${data.quantity || 0}\n`;
  textDetails += `Requested Date: ${new Date(data.created_at).toLocaleDateString()}\n`;
  
  // Physical SIM boxes
  if (data.assigned_boxes && data.assigned_boxes.length > 0 && data.sim_type === 'PHYSICAL') {
    textDetails += `\nPhysical SIM Stock Details:\n`;
    data.assigned_boxes.forEach(box => {
      const boxLabel = box.carton_number && box.box_number 
        ? `${box.carton_number} - Box ${box.box_number}` 
        : box.box_id?.slice(0, 8) || 'N/A';
      textDetails += `  - ${boxLabel}: ${box.quantity} SIMs\n`;
    });
  }
  
  // eSIM ICCIDs
  if (data.assigned_esims && data.assigned_esims.length > 0 && data.sim_type === 'ESIM') {
    textDetails += `\neSIM Stock Details (${data.assigned_esims.length} ICCIDs):\n`;
    const esimsToShow = data.assigned_esims.slice(0, 20);
    esimsToShow.forEach(iccid => {
      textDetails += `  - ${iccid}\n`;
    });
    if (data.assigned_esims.length > 20) {
      textDetails += `  ... and ${data.assigned_esims.length - 20} more ICCIDs\n`;
    }
  }

  const textContent = `
Stock Request Approval Required

${greeting},

A stock request requires your approval.

${textDetails}
Please click the link below to approve or reject this request:
${approvalUrl}

This link will expire on ${new Date(data.expires_at).toLocaleDateString()}.
  `.trim();

  // Send only to the specific approver — do NOT mix in defaultTo recipients.
  // Each approver must get their own individual email so consensus matching works.
  const recipients = [data.approver_email];
  const subject = `Stock Request Approval Required - ${data.distributor_name || 'Distributor'} - ${data.mvno_name || 'MVNO'} - ${data.quantity || 0} SIMs`;

  if (!data.approver_email) {
    logSmtpActivity('ERR', `No approver email for approval email request=${data.request_id}`);
    return false;
  }

  if (isSmtpConfigured()) {
    return sendViaSmtp(recipients, subject, htmlContent, textContent);
  }

  logSmtpActivity('ERR', `SMTP not configured for approval email request=${data.request_id}`);
  return false;
}

export async function sendApprovalConfirmationEmail(
  approverEmail: string,
  requestId: string,
  approved: boolean,
  baseUrl: string
): Promise<boolean> {
  const status = approved ? 'Approved' : 'Rejected';
  const dashboardUrl = `${baseUrl}/requests`;
  
  const statusColor = approved ? '#059669' : '#dc2626';
  const statusBg   = approved ? '#ecfdf5' : '#fef2f2';
  const statusBorder = approved ? '#a7f3d0' : '#fecaca';
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
      <div style="background: linear-gradient(135deg, #1e2235 0%, #2d3548 100%); padding: 24px 32px; border-radius: 12px 12px 0 0;">
        <h1 style="color: #f0a500; margin: 0; font-size: 18px; font-weight: 700;">✅ Action Recorded — SimTrack Pro</h1>
        <p style="color: rgba(255,255,255,0.55); margin: 5px 0 0; font-size: 13px;">Stock Approval Confirmation</p>
      </div>
      <div style="padding: 28px 32px;">
        <p style="font-size: 15px; font-weight: 600; color: #1e2235;">Hello,</p>
        <p style="color: #444; font-size: 14px; line-height: 1.6;">Your approval decision has been successfully recorded for the following request:</p>

        <div style="background: ${statusBg}; border: 1px solid ${statusBorder}; border-radius: 10px; padding: 16px 20px; margin: 20px 0;">
          <p style="margin: 0 0 8px; font-size: 14px;"><strong style="color: #374151;">Request ID:</strong> <span style="font-family: monospace; color: #1e2235;">${requestId}</span></p>
          <p style="margin: 0 0 8px; font-size: 14px;"><strong style="color: #374151;">Decision:</strong> <span style="font-weight: 700; color: ${statusColor};">${status}</span></p>
          <p style="margin: 0; font-size: 14px;"><strong style="color: #374151;">Recorded at:</strong> ${new Date().toLocaleString()}</p>
        </div>

        <div style="margin: 24px 0; text-align: center;">
          <a href="${dashboardUrl}" style="background: linear-gradient(135deg, #f0a500 0%, #d4840a 100%); color: #1e2235; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px; display: inline-block; box-shadow: 0 4px 12px rgba(240,165,0,0.3);">
            View Dashboard
          </a>
        </div>

        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
        <p style="color: #bbb; font-size: 11px;">This is an automated notification from SimTrack Pro. Please do not reply.</p>
      </div>
    </div>
  `;

  const recipients = getRecipients(approverEmail);
  const subject = `Stock Request ${status} - Request #${requestId}`;

  if (!recipients.length) {
    console.error('[EMAIL] No recipients found for confirmation email', { requestId });
    logSmtpActivity('ERR', `No recipients found for confirmation email request=${requestId}`);
    return false;
  }

  if (isSmtpConfigured()) {
    return sendViaSmtp(recipients, subject, htmlContent);
  }

  console.error('[EMAIL] SMTP not configured. Please set SMTP_SERVER, SMTP_PORT, SMTP_USER, and EMAIL_PASSWORD in environment.');
  logSmtpActivity('ERR', `SMTP not configured for confirmation email request=${requestId}`);
  return false;
}
