import { query } from '../config/database.js';
import { logLine } from '../logging/unified-logger.js';
import { getIo } from '../socket.js';

let escalationIntervalId: NodeJS.Timeout | null = null;
let escalationRunning = false;

export async function runEscalationSweep(): Promise<void> {
  if (escalationRunning) return;
  escalationRunning = true;

  try {
    // ── 1. stock_issuance_requests (Super Admin flow) — fixed 60 min ──────────
    const sirResult = await query(
      `UPDATE stock_issuance_requests
       SET status = 'ESCALATED',
           escalation_reason = COALESCE(escalation_reason, 'Auto-escalated: no response within 60 minutes'),
           escalated_at = COALESCE(escalated_at, NOW()),
           updated_at = NOW()
       WHERE status = 'PENDING'
         AND created_at <= NOW() - INTERVAL '60 minutes'
       RETURNING id`
    );
    if (sirResult.rows.length > 0) {
      logLine('WRN', 'MVNO_ESCALATION', `SIR escalated ${sirResult.rows.length} request(s): ${sirResult.rows.map((r: any) => r.id).join(', ')}`);
    }

    // ── 2. distributor_sim_requests (MVNO Admin flow) — per-MVNO delay ────────
    // Fetch per-MVNO escalation delay from mvno_settings
    const settingsRes = await query(
      `SELECT mvno_id, COALESCE(escalation_delay_hours_decimal, escalation_delay_hours, 1.0) AS delay_hours
       FROM mvno_settings
       WHERE escalation_enabled = true OR escalation_enabled IS NULL`
    ).catch(() => ({ rows: [] as any[] }));

    const io = getIo();

    for (const s of (settingsRes as any).rows ?? []) {
      const delayMinutes = Math.round(Number(s.delay_hours) * 60);
      const dsrResult = await query(
        `UPDATE distributor_sim_requests
         SET status = 'ESCALATED', updated_at = NOW()
         WHERE mvno_id = $1
           AND status IN ('PENDING', 'APPROVED')
           AND created_at <= NOW() - ($2 || ' minutes')::interval
         RETURNING id`,
        [s.mvno_id, delayMinutes]
      ).catch(() => ({ rows: [] as any[] }));

      if ((dsrResult as any).rows.length > 0) {
        const ids = (dsrResult as any).rows.map((r: any) => r.id);
        logLine('WRN', 'MVNO_ESCALATION', `DSR escalated ${ids.length} request(s) for MVNO ${s.mvno_id} (>${delayMinutes}min): ${ids.join(', ')}`);

        // Insert audit logs + create SIRs for Super Admin visibility
        for (const id of ids) {
          await query(
            `INSERT INTO stock_audit_logs (request_id, action, performed_by_email, details)
             VALUES ($1, 'REQUEST_ESCALATED', 'system', $2)`,
            [id, JSON.stringify({ reason: `Auto-escalated after ${delayMinutes} minutes` })]
          ).catch(() => {});

          // Create a stock_issuance_request so Super Admin sees it
          const dsrRow = await query(
            `SELECT distributor_id, sim_type, quantity FROM distributor_sim_requests WHERE id = $1`, [id]
          ).catch(() => ({ rows: [] as any[] }));
          if ((dsrRow as any).rows[0]) {
            const dsr = (dsrRow as any).rows[0];
            const sirNotes = `[ESCALATED from MVNO] Auto-escalated after ${delayMinutes} minutes | DSR:${id}`;
            const existingSir = await query(
              `SELECT id FROM stock_issuance_requests WHERE notes LIKE $1 LIMIT 1`, [`%DSR:${id}%`]
            ).catch(() => ({ rows: [] as any[] }));
            if (!(existingSir as any).rows[0]) {
              await query(
                `INSERT INTO stock_issuance_requests (mvno_id, requester_id, sim_type, quantity, status, notes, created_at, updated_at)
                 VALUES ($1::uuid, $2::uuid, $3, $4, 'PENDING', $5, NOW(), NOW())`,
                [s.mvno_id, dsr.distributor_id || s.mvno_id, dsr.sim_type, dsr.quantity, sirNotes]
              ).catch(() => {});
            }
          }
        }

        // Notify MVNO admin + Super Admin via socket
        io?.to(`mvno:${s.mvno_id}`).emit('mvno_admin:requests_escalated', { count: ids.length, ids });
        io?.emit('superadmin:stock_request_escalated', { mvno_id: s.mvno_id, count: ids.length });
      }
    }

    // Fallback: escalate DSRs for MVNOs with no settings row after default 60 min
    const defaultDsrResult = await query(
      `UPDATE distributor_sim_requests
       SET status = 'ESCALATED', updated_at = NOW()
       WHERE status IN ('PENDING', 'APPROVED')
         AND created_at <= NOW() - INTERVAL '60 minutes'
         AND mvno_id NOT IN (SELECT mvno_id FROM mvno_settings WHERE mvno_id IS NOT NULL)
       RETURNING id, mvno_id`
    ).catch(() => ({ rows: [] as any[] }));

    if ((defaultDsrResult as any).rows.length > 0) {
      logLine('WRN', 'MVNO_ESCALATION', `DSR (default 60min) escalated ${(defaultDsrResult as any).rows.length} request(s)`);
    }

  } catch (error: any) {
    logLine('ERR', 'MVNO_ESCALATION', `Escalation sweep failed: ${String(error?.message || error)}`);
  } finally {
    escalationRunning = false;
  }
}

export function startMvnoEscalationChecker(intervalSeconds: number = 60): void {
  if (escalationIntervalId) {
    logLine('WRN', 'MVNO_ESCALATION', 'MVNO escalation checker already running');
    return;
  }

  logLine('INF', 'MVNO_ESCALATION', `Starting MVNO escalation checker (every ${intervalSeconds}s)`);
  runEscalationSweep();

  escalationIntervalId = setInterval(() => {
    runEscalationSweep();
  }, intervalSeconds * 1000);
}

export function stopMvnoEscalationChecker(): void {
  if (escalationIntervalId) {
    clearInterval(escalationIntervalId);
    escalationIntervalId = null;
  }
  logLine('INF', 'MVNO_ESCALATION', 'Stopped MVNO escalation checker');
}
