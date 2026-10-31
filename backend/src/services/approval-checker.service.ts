// Background service to check approval consensus
// Runs every few seconds to process approval responses.
// When all approvers approve, auto-issues stock (distributes + creates pick history).
// Also cleans up COMPLETED requests older than 2 days.

import { query } from '../config/database.js';
import { logLine } from '../logging/unified-logger.js';
import * as stockService from './stock.service.js';

let isRunning = false;

export async function checkApprovalConsensus(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    // Find requests awaiting consensus that have at least one response
    const pendingChecks = await query(`
      SELECT DISTINCT ar.request_id
      FROM approval_responses ar
      INNER JOIN stock_issuance_requests sr ON ar.request_id = sr.id
      WHERE sr.status IN ('WAITING_FOR_APPROVAL', 'AWAITING_EMAIL_APPROVAL', 'READY_FOR_APPROVAL')
        AND ar.status IN ('APPROVED', 'REJECTED')
    `);

    if (pendingChecks.rows.length === 0) return;

    logLine('INF', 'CONSENSUS', `Checking ${pendingChecks.rows.length} request(s) for approval consensus`);

    for (const row of pendingChecks.rows) {
      const requestId = row.request_id;
      try {
        await processConsensus(requestId);
      } catch (err: any) {
        logLine('ERR', 'CONSENSUS', `Error processing request ${requestId}: ${err.message}`);
      }
    }
  } catch (error: any) {
    logLine('ERR', 'CONSENSUS', `Consensus checker error: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

async function processConsensus(requestId: string): Promise<void> {
  // Resolve the two configured approver emails for this request
  const reqRow = await query(
    `SELECT level_1_approver_email, level_2_approver_email FROM stock_issuance_requests WHERE id = $1`,
    [requestId]
  );
  let l1Email: string | null = reqRow.rows[0]?.level_1_approver_email || null;
  let l2Email: string | null = reqRow.rows[0]?.level_2_approver_email || null;

  // Fall back to global config if request doesn't have custom approver emails
  if (!l1Email || !l2Email) {
    const cfgRows = await query(
      `SELECT approver_level, approver_email FROM stock_approver_config WHERE is_active = true AND approver_level IN ('LEVEL_1','LEVEL_2')`
    );
    for (const c of cfgRows.rows) {
      if (c.approver_level === 'LEVEL_1' && !l1Email) l1Email = c.approver_email;
      if (c.approver_level === 'LEVEL_2' && !l2Email) l2Email = c.approver_email;
    }
  }

  // Deduplicate so 1-approver flows (l1 === l2) complete on a single approval
  const approverEmails = [...new Set(
    [l1Email, l2Email].filter(Boolean).map((e) => (e as string).toLowerCase())
  )];

  if (approverEmails.length === 0) {
    logLine('WRN', 'CONSENSUS', `Request ${requestId}: no approver emails configured. Skipping.`);
    return;
  }

  // Only fetch responses from the configured approver emails
  const responses = await query(
    `SELECT status, email FROM approval_responses WHERE request_id = $1 AND LOWER(email) = ANY($2::text[])`,
    [requestId, approverEmails]
  );

  const approvedCount = responses.rows.filter((r: any) => r.status === 'APPROVED').length;
  const rejectedCount = responses.rows.filter((r: any) => r.status === 'REJECTED').length;

  logLine('INF', 'CONSENSUS', `Request ${requestId}: ${approvedCount}/${approverEmails.length} approved, ${rejectedCount} rejected (approvers: ${approverEmails.join(', ')})`);

  if (rejectedCount > 0) {
    // Any rejection → REJECTED
    await query(
      `UPDATE stock_issuance_requests SET status = 'REJECTED', updated_at = NOW() WHERE id = $1`,
      [requestId]
    );
    await stockService.addAuditLog(requestId, 'REJECTED', {
      message: 'Request rejected by approver consensus',
      approved_count: approvedCount,
      rejected_count: rejectedCount,
    });
    logLine('WRN', 'CONSENSUS', `Request ${requestId} REJECTED by consensus`);

  } else if (approvedCount >= approverEmails.length) {
    // All configured approvers approved → auto-issue stock
    logLine('INF', 'CONSENSUS', `Request ${requestId} fully approved (${approvedCount}/${approverEmails.length}). Issuing stock...`);

    await stockService.addAuditLog(requestId, 'CONSENSUS_APPROVED', {
      message: 'All approvers approved - auto-issuing stock',
      approved_count: approvedCount,
      approver_emails: approverEmails,
    });

    try {
      const result = await stockService.issueApprovedStockRequest(requestId);
      logLine('INF', 'CONSENSUS', `Request ${requestId} COMPLETED. PDF: ${result.pdf_url || 'none'}`);
    } catch (issueErr: any) {
      logLine('ERR', 'CONSENSUS', `Failed to auto-issue stock for ${requestId}: ${issueErr.message}`);
      // Fall back to READY_FOR_APPROVAL so it can be issued manually
      await query(
        `UPDATE stock_issuance_requests SET status = 'READY_FOR_APPROVAL', updated_at = NOW() WHERE id = $1`,
        [requestId]
      );
    }

  } else {
    // Partial approval — still waiting
    logLine('INF', 'CONSENSUS', `Request ${requestId} waiting for more approvals (${approvedCount}/${approverEmails.length})`);
  }
}

// Clean up COMPLETED/STOCK_ISSUED requests older than 2 days
// (data is already preserved in pick_history / distribution history)
export async function cleanupOldCompletedRequests(): Promise<void> {
  try {
    const result = await query(`
      DELETE FROM stock_issuance_requests
      WHERE status IN ('COMPLETED', 'STOCK_ISSUED')
        AND updated_at < NOW() - INTERVAL '2 days'
      RETURNING id
    `);
    if (result.rows.length > 0) {
      logLine('INF', 'CLEANUP', `Deleted ${result.rows.length} completed request(s) older than 2 days`);
    }
  } catch (err: any) {
    logLine('ERR', 'CLEANUP', `Cleanup error: ${err.message}`);
  }
}

// Start the background checker
let consensusIntervalId: NodeJS.Timeout | null = null;
let cleanupIntervalId: NodeJS.Timeout | null = null;

export function startApprovalChecker(intervalSeconds: number = 5): void {
  if (consensusIntervalId) {
    logLine('WRN', 'CONSENSUS', 'Approval checker already running');
    return;
  }

  logLine('INF', 'CONSENSUS', `Starting approval consensus checker (every ${intervalSeconds}s)`);

  // Run consensus immediately then periodically
  checkApprovalConsensus();
  consensusIntervalId = setInterval(() => {
    checkApprovalConsensus();
  }, intervalSeconds * 1000);

  // Run cleanup once on start, then every hour
  cleanupOldCompletedRequests();
  cleanupIntervalId = setInterval(() => {
    cleanupOldCompletedRequests();
  }, 60 * 60 * 1000);
}

export function stopApprovalChecker(): void {
  if (consensusIntervalId) {
    clearInterval(consensusIntervalId);
    consensusIntervalId = null;
  }
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  logLine('INF', 'CONSENSUS', 'Approval checker stopped');
}
