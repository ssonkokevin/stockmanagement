import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as stockService from '../services/stock.service.js';
import * as emailService from '../services/email.service.js';
import { config } from '../config/index.js';
import { query } from '../config/database.js';
import { ApprovalToken } from '../types/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { appendUnifiedLog, formatLogTimestamp, logFrontendActivity, logLine, toLevel } from '../logging/unified-logger.js';
import { getIo } from '../socket.js';

const router = Router();
let bossSyncDeprecationLogged = false;

function ok<T>(res: Response, data: T, message: string | null = null) {
  const traceId = String(res.locals?.traceId || 'n/a');
  return res.json({ success: true, data, message, trace_id: traceId });
}

function fail(res: Response, status: number, message: string) {
  const traceId = String(res.locals?.traceId || 'n/a');
  const level = status >= 500 ? 'ERR' : 'WRN';
  const req = (res as any).req as Request | undefined;
  const routeInfo = req ? `${req.method} ${req.originalUrl || req.url}` : 'unknown';
  logLine(level, 'API_ERROR', `[trace:${traceId}] ${routeInfo} status=${status} :: ${message}`);
  return res.status(status).json({ success: false, message, trace_id: traceId });
}

function formatLsTimestamp(date: Date): string {
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = String(date.getDate()).padStart(2, ' ');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${month} ${day} ${hh}:${mm}`;
}

// ==================== JWT HELPERS (no external package needed) ====================

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}
function b64decode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

export function signJwt(payload: Record<string, any>): string {
  const secret  = config.jwt.secret;
  const exp     = Math.floor(Date.now() / 1000) + config.jwt.expiresIn;
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body    = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp }));
  const sig     = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string): Record<string, any> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', config.jwt.secret).update(`${header}.${body}`).digest('base64url');
  if (sig !== expected) throw new Error('Invalid token signature');
  const payload = JSON.parse(b64decode(body));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}

/** Express middleware — reads Bearer token, attaches payload to req.auth (soft: passes through if absent) */
export function jwtMiddleware(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    try {
      (req as any).auth = verifyJwt(auth.slice(7));
    } catch {
      // soft — invalid token is ignored, route handlers decide if auth is required
    }
  }
  next();
}

// ==================== AUTH ROUTES ====================

// POST /api/auth/login
router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const email    = String(req.body.email    || '').trim().toLowerCase();
    const password = String(req.body.password || '').trim();
    if (!email || !password) return fail(res, 400, 'email and password are required');

    const user = await stockService.getPlatformUserByEmail(email);
    if (!user)                  return fail(res, 401, 'Invalid email or password');
    if (user.password_hash !== password) return fail(res, 401, 'Invalid email or password');
    if (!user.is_active)        return fail(res, 403, 'Account is disabled — contact your administrator');

    // Resolve linked distributor_id for DISTRIBUTOR role
    let distributor_id: string | null = null;
    if (user.role === 'DISTRIBUTOR') {
      const dr = await query(
        `SELECT id FROM distributors WHERE LOWER(email) = $1 AND is_active = true LIMIT 1`,
        [email],
      );
      distributor_id = dr.rows[0]?.id ?? null;
    }

    const payload = {
      id:             user.id,
      email:          user.email,
      full_name:      user.full_name,
      role:           user.role,
      mvno_id:        user.mvno_id    ?? null,
      distributor_id: distributor_id,
    };

    const token = signJwt(payload);

    // Update last_login
    await query(`UPDATE platform_users SET last_login = now() WHERE id = $1`, [user.id]);

    return ok(res, {
      token,
      user: { ...payload, is_active: true },
      expires_in: config.jwt.expiresIn,
    });
  } catch (e: any) { return fail(res, 500, e.message); }
});

// GET /api/auth/me  — verify current token
router.get('/auth/me', (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return fail(res, 401, 'No token provided');
  try {
    const payload = verifyJwt(auth.slice(7));
    return ok(res, payload);
  } catch (e: any) {
    return fail(res, 401, e.message);
  }
});

// ==================== REFERENCE DATA ROUTES ====================

// Get MVNOs
router.get('/mvnos', async (req: Request, res: Response) => {
  try {
    const mvnos = await stockService.getMvnos();
    ok(res, mvnos);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.get('/manual-provisioning/config', async (_req: Request, res: Response) => {
  try {
    const emails = await stockService.getManualProvisioningApprovalEmails();
    ok(res, { approval_emails: emails });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.post('/manual-provisioning', async (req: Request, res: Response) => {
  try {
    const payload = {
      distributor_id: String(req.body.distributor_id || req.body.distributorId || ''),
      mvno_id: String(req.body.mvno_id || req.body.mvnoId || ''),
      sim_type: String(req.body.sim_type || req.body.simType || 'PHYSICAL').toUpperCase() as 'PHYSICAL' | 'ESIM',
      box_quantities: req.body.box_quantities || req.body.boxQuantities || [],
      iccids: req.body.iccids || [],
      effective_date: req.body.effective_date || req.body.effectiveDate || undefined,
      contact_person: req.body.contact_person ? String(req.body.contact_person) : undefined,
      purpose: req.body.purpose ? String(req.body.purpose) : undefined,
      performed_by: req.body.performed_by ? String(req.body.performed_by) : undefined,
      performed_by_email: req.body.performed_by_email ? String(req.body.performed_by_email) : undefined,
      performed_by_role: String(req.body.performed_by_role || req.body.performedByRole || req.headers['x-user-role'] || ''),
      request_id:
        req.body.request_id || req.body.requestId
          ? String(req.body.request_id || req.body.requestId)
          : undefined,
    };

    if (!payload.distributor_id || !payload.mvno_id) {
      return fail(res, 400, 'distributor_id and mvno_id are required');
    }
    if (!['PHYSICAL', 'ESIM'].includes(payload.sim_type)) {
      return fail(res, 400, 'sim_type must be PHYSICAL or ESIM');
    }

    const result = await stockService.manualProvisionStock(payload);
    ok(res, result, 'Manual provisioning completed');
  } catch (error: any) {
    const distributorId = req.body?.distributor_id || req.body?.distributorId || null;
    const mvnoId = req.body?.mvno_id || req.body?.mvnoId || null;
    const simType = req.body?.sim_type || req.body?.simType || null;
    const boxCount = Array.isArray(req.body?.box_quantities || req.body?.boxQuantities)
      ? (req.body.box_quantities || req.body.boxQuantities).length
      : 0;
    const iccidCount = Array.isArray(req.body?.iccids) ? req.body.iccids.length : 0;
    logLine(
      'ERR',
      'MANUAL_PROVISIONING',
      `Manual provisioning failed: ${error?.message || 'unknown error'} | distributor_id=${distributorId} mvno_id=${mvnoId} sim_type=${simType} box_count=${boxCount} iccid_count=${iccidCount}`
    );
    if (error?.code === 'STOCK_ALREADY_ASSIGNED') {
      const traceId = String(res.locals?.traceId || 'n/a');
      return res.status(409).json({ error: 'Stock already assigned', trace_id: traceId });
    }
    fail(res, 400, error.message);
  }
});

// Export distribution history with filters
router.post('/distribution-history/export', async (req: Request, res: Response) => {
  try {
    const { mvno_id, distributor_id, date_from, date_to, format = 'csv' } = req.body || {};
    const result = await stockService.exportDistributionHistory({
      mvno_id: mvno_id ? String(mvno_id) : undefined,
      distributor_id: distributor_id ? String(distributor_id) : undefined,
      date_from: date_from ? String(date_from) : undefined,
      date_to: date_to ? String(date_to) : undefined,
      format: String(format),
      user_email: req.headers['x-user-email'] ? String(req.headers['x-user-email']) : 'unknown',
      user_role: req.headers['x-user-role'] ? String(req.headers['x-user-role']) : 'unknown',
    });
    ok(res, result, 'Export completed');
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Log export action for audit
router.post('/audit/log-export', async (req: Request, res: Response) => {
  try {
    const { action, user_id, user_email, user_role, filters, record_count } = req.body || {};
    await stockService.logExportAction({
      action: String(action),
      user_id: user_id ? String(user_id) : null,
      user_email: String(user_email || 'unknown'),
      user_role: String(user_role || 'unknown'),
      filters: filters ? JSON.stringify(filters) : '{}',
      record_count: Number(record_count) || 0,
    });
    ok(res, {}, 'Export logged');
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Alias: frontend expects this route name in some places
// GET - get all stock issuance requests
router.get('/stock-issuance-requests', async (req: Request, res: Response) => {
  try {
    const mvnoId = req.query.mvno_id ? String(req.query.mvno_id) : undefined;
    const requests = mvnoId
      ? await stockService.getStockIssuanceRequestsByMvno(mvnoId)
      : await stockService.getAllStockIssuanceRequests();
    ok(res, requests);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// POST - create new stock issuance request (same as /requests)
router.post('/stock-issuance-requests', async (req: Request, res: Response) => {
  try {
    // Accept both camelCase (API standard) and snake_case (frontend legacy)
    const mvnoId = req.body.mvnoId || req.body.mvno_id;
    const requesterId = req.body.requesterId || req.body.requester_id || req.body.created_by || 'system';
    const simType = req.body.simType || req.body.sim_type;
    const quantity = req.body.quantity;
    const notes = req.body.notes;
    const level1ApproverEmail = req.body.level_1_approver_email;
    const level2ApproverEmail = req.body.level_2_approver_email;
    
    if (!mvnoId || !simType || !quantity) {
      return fail(res, 400, 'mvnoId (or mvno_id), simType (or sim_type), and quantity are required');
    }
    
    const request = await stockService.createStockIssuanceRequest(
      mvnoId, 
      requesterId, 
      simType, 
      quantity, 
      notes
    );
    
    // If approver emails provided, save them to the request
    if ((level1ApproverEmail || level2ApproverEmail) && request) {
      await stockService.updateRequestApprovers(request.id, level1ApproverEmail, level2ApproverEmail);
    }
    
    res.status(201).json({ success: true, data: request });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Physical stock summary totals (for dashboard)
router.get('/physical-stock-summary', async (req: Request, res: Response) => {
  try {
    const rows = await stockService.getPhysicalStockSummary();
    ok(res, rows);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Get Distributors
router.get('/distributors', async (req: Request, res: Response) => {
  try {
    const activeOnly = String(req.query.active_only || '').toLowerCase() === 'true';
    const distributors = await stockService.getDistributors(activeOnly);
    ok(res, distributors);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.get('/distributors/:id', async (req: Request, res: Response) => {
  try {
    const d = await stockService.getDistributorById(req.params.id as string);
    if (!d) return fail(res, 404, 'Distributor not found');
    ok(res, d);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Validate distributor by request token (for external stock request)
router.get('/distributors/validate-token/:token', async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token);
    const result = await stockService.getDistributorByToken(token);
    if (!result) {
      return fail(res, 404, 'Invalid or expired request link');
    }
    ok(res, result);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Create Distributor
router.post('/distributors', async (req: Request, res: Response) => {
  try {
    const {
      name,
      region,
      contact_email,
      contact_phone,
      email,
      phone,
      type,
    } = req.body;
    if (!name) {
      return fail(res, 400, 'name is required');
    }
    const distributor = await stockService.createDistributor({
      name,
      region,
      type,
      contact_email: contact_email || email || null,
      contact_phone: contact_phone || phone || null,
    });
    res.status(201).json({ success: true, data: distributor, message: null });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.patch('/distributors/:id', async (req: Request, res: Response) => {
  try {
    const updated = await stockService.updateDistributor(req.params.id as string, req.body || {});
    ok(res, updated);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Cartons and boxes (for assignment UI)
router.get('/cartons', async (req: Request, res: Response) => {
  try {
    const mvnoId = req.query.mvno_id ? String(req.query.mvno_id) : undefined;
    const rows = await stockService.getCartons(mvnoId);
    ok(res, rows);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.get('/boxes', async (req: Request, res: Response) => {
  try {
    const cartonId = req.query.carton_id ? String(req.query.carton_id) : undefined;
    const rows = await stockService.getBoxes(cartonId);
    ok(res, rows);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Distribution endpoints for DistributeSimsModal
router.post('/distribute/esim', async (req: Request, res: Response) => {
  try {
    const { distributor_id, mvno_id, iccids, purpose } = req.body;
    
    // Check if stock has already been issued for this distributor, mvno, sim_type, and esims combination
    const existingRecord = await query(
      `SELECT id FROM pick_history 
       WHERE distributor_id = $1 
         AND mvno_id = $2 
         AND sim_type = $3 
         AND assigned_esims = $4
         AND distribution_type = 'MANUAL'
       LIMIT 1`,
      [distributor_id, mvno_id, 'ESIM', JSON.stringify(iccids)]
    );
    if (existingRecord.rows.length > 0) {
      return fail(res, 400, 'Stock has already been issued for this distributor, MVNO, SIM type, and eSIM combination.');
    }

    const result = await query(
      `SELECT * FROM distribute_esims($1, $2, $3, $4)`,
      [distributor_id, mvno_id, iccids, purpose]
    );
    ok(res, result.rows);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.post('/distribute/physical-box', async (req: Request, res: Response) => {
  try {
    const { distributor_id, box_id, quantity, purpose } = req.body;
    
    // Get box details to find mvno_id
    const boxResult = await query(
      `SELECT b.*, c.mvno_id 
       FROM boxes b 
       JOIN cartons c ON b.carton_id = c.id 
       WHERE b.id = $1`,
      [box_id]
    );
    if (boxResult.rows.length === 0) {
      return fail(res, 400, 'Box not found');
    }
    const box = boxResult.rows[0];

    // Check if stock has already been issued for this distributor, mvno, sim_type, and box combination
    const existingRecord = await query(
      `SELECT id FROM pick_history 
       WHERE distributor_id = $1 
         AND mvno_id = $2 
         AND sim_type = $3 
         AND assigned_boxes = $4
         AND distribution_type = 'MANUAL'
       LIMIT 1`,
      [distributor_id, box.mvno_id, 'PHYSICAL', JSON.stringify([{ box_id, quantity }])]
    );
    if (existingRecord.rows.length > 0) {
      return fail(res, 400, 'Stock has already been issued for this distributor, MVNO, SIM type, and box combination.');
    }

    const result = await query(
      `SELECT * FROM distribute_physical_box($1, $2, $3, $4)`,
      [distributor_id, box_id, quantity, purpose]
    );
    ok(res, result.rows);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.post('/distribute/physical-boxes', async (req: Request, res: Response) => {
  try {
    const { distributor_id, box_quantities, purpose } = req.body;
    
    // Get box details to find mvno_id
    const boxIds = box_quantities.map((b: any) => b.box_id);
    const boxesResult = await query(
      `SELECT b.id, c.mvno_id 
       FROM boxes b 
       JOIN cartons c ON b.carton_id = c.id 
       WHERE b.id = ANY($1)`,
      [boxIds]
    );
    if (boxesResult.rows.length === 0) {
      return fail(res, 400, 'Boxes not found');
    }
    const mvnoId = boxesResult.rows[0].mvno_id;

    // Check if stock has already been issued for this distributor, mvno, sim_type, and boxes combination
    const existingRecord = await query(
      `SELECT id FROM pick_history 
       WHERE distributor_id = $1 
         AND mvno_id = $2 
         AND sim_type = $3 
         AND assigned_boxes = $4
         AND distribution_type = 'MANUAL'
       LIMIT 1`,
      [distributor_id, mvnoId, 'PHYSICAL', JSON.stringify(box_quantities)]
    );
    if (existingRecord.rows.length > 0) {
      return fail(res, 400, 'Stock has already been issued for this distributor, MVNO, SIM type, and boxes combination.');
    }

    const result = await query(
      `SELECT * FROM distribute_physical_boxes($1, $2, $3)`,
      [distributor_id, box_quantities, purpose]
    );
    ok(res, result.rows);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Assign issuance request stock (multi-box or eSIM)
router.post('/issuance/:id/assign', async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id as string;
    const result = await stockService.assignIssuanceRequest(requestId, req.body || {});
    ok(res, result);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Platform users (demo auth)
router.get('/platform-users', async (req: Request, res: Response) => {
  try {
    const email = req.query.email ? String(req.query.email) : undefined;
    if (!email) return fail(res, 400, 'email is required');
    const user = await stockService.getPlatformUserByEmail(email);
    if (!user) return fail(res, 404, 'User not found');
    ok(res, user);
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// ==================== STOCK SUMMARY ROUTES ====================

// Box stock summary (physical)
router.get('/box-stock-summary', async (req: Request, res: Response) => {
  try {
    const { limit, offset, search, carton_number, box_number, mvno, status, iccid_from, iccid_to } = req.query;
    const rows = await stockService.getBoxStockSummary({
      limit: limit ? parseInt(String(limit)) : undefined,
      offset: offset ? parseInt(String(offset)) : undefined,
      search: search ? String(search) : undefined,
      carton_number: carton_number ? String(carton_number) : undefined,
      box_number: box_number ? String(box_number) : undefined,
      mvno: mvno ? String(mvno) : undefined,
      status: status ? String(status) : undefined,
      iccid_from: iccid_from ? String(iccid_from) : undefined,
      iccid_to: iccid_to ? String(iccid_to) : undefined,
    });
    res.json({ success: true, data: rows });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.get('/box-stock-summary/count', async (req: Request, res: Response) => {
  try {
    const { search, carton_number, box_number, mvno, status, iccid_from, iccid_to } = req.query;
    const count = await stockService.getBoxStockSummaryCount({
      search: search ? String(search) : undefined,
      carton_number: carton_number ? String(carton_number) : undefined,
      box_number: box_number ? String(box_number) : undefined,
      mvno: mvno ? String(mvno) : undefined,
      status: status ? String(status) : undefined,
      iccid_from: iccid_from ? String(iccid_from) : undefined,
      iccid_to: iccid_to ? String(iccid_to) : undefined,
    });
    res.json({ success: true, data: { count } });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Physical inventory (authoritative)
router.get('/sim-stock', async (req: Request, res: Response) => {
  try {
    const params = {
      limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
      search: req.query.search as string | undefined,
      carton_number: req.query.carton_number as string | undefined,
      box_number: req.query.box_number as string | undefined,
      mvno: req.query.mvno as string | undefined,
      status: req.query.status as string | undefined,
      iccid_from: req.query.iccid_from as string | undefined,
      iccid_to: req.query.iccid_to as string | undefined,
    };
    const rows = await stockService.getSimStock(params);
    res.json({ success: true, data: rows });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Distribution history — authoritative source: box_pick_records for physical, pick_history for eSIM
router.get('/distribution-history', async (req: Request, res: Response) => {
  try {
    const mvno_id = req.query.mvno_id ? String(req.query.mvno_id) : undefined;
    const sim_type = req.query.sim_type ? String(req.query.sim_type) : undefined;
    const distributor_id = (req.query.distributor_id || req.query.distributorId)
      ? String(req.query.distributor_id || req.query.distributorId)
      : undefined;
    const date_from = req.query.date_from ? String(req.query.date_from) : undefined;
    const date_to = req.query.date_to ? String(req.query.date_to) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : undefined;
    const offset = req.query.offset ? parseInt(String(req.query.offset)) : undefined;

    const data = await stockService.getDistributionHistory({
      mvno_id,
      sim_type: (sim_type ? String(sim_type).toUpperCase() : 'ALL') as any,
      distributor_id,
      date_from,
      date_to,
      search,
      limit,
      offset,
    });

    res.json({ success: true, data });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.get('/distribution-history/export', async (req: Request, res: Response) => {
  try {
    const type = req.query.type ? String(req.query.type) : '';
    const mvno_id = req.query.mvno_id ? String(req.query.mvno_id) : undefined;
    const distributor_id = (req.query.distributor_id || req.query.distributorId)
      ? String(req.query.distributor_id || req.query.distributorId)
      : undefined;
    const date_from = req.query.date_from ? String(req.query.date_from) : undefined;
    const date_to = req.query.date_to ? String(req.query.date_to) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const request_id = req.query.request_id ? String(req.query.request_id) : undefined;

    const exported = await stockService.exportDistributionHistoryCsv({
      type: String(type).toLowerCase() as any,
      filters: { mvno_id, distributor_id, date_from, date_to, search },
      request_id,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
    res.status(200).send(exported.csv);
  } catch (error: any) {
    fail(res, 400, error.message);
  }
});

router.get('/distribution-history/esim-iccids', async (req: Request, res: Response) => {
  try {
    const requestId = req.query.request_id ? String(req.query.request_id) : '';
    if (!requestId) return fail(res, 400, 'request_id is required');
    const iccids = await stockService.getDistributionHistoryEsimIccids(requestId);
    res.json({ success: true, data: { request_id: requestId, iccids } });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Get single distribution record by ID
router.get('/distribution-history/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id ? String(req.params.id) : '';
    if (!id) return fail(res, 400, 'Distribution ID is required');

    const data = await stockService.getDistributionHistoryById(id);
    if (!data) return fail(res, 404, 'Distribution record not found');

    res.json({ success: true, data });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Current stock view (dashboard)
router.get('/current-stock-view', async (req: Request, res: Response) => {
  try {
    const rows = await stockService.getCurrentStockView();
    res.json({ success: true, data: rows });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.get('/dashboard-metrics', async (req: Request, res: Response) => {
  try {
    if (!bossSyncDeprecationLogged) {
      logLine('INF', 'BOSS_SYNC', 'UI sync button removed; sync activity is now tracked in backend unified logs only.');
      bossSyncDeprecationLogged = true;
    }
    const mvno_id = req.query.mvno_id ? String(req.query.mvno_id) : undefined;
    const date_from = req.query.date_from ? String(req.query.date_from) : undefined;
    const date_to = req.query.date_to ? String(req.query.date_to) : undefined;
    const data = await stockService.getDashboardMetrics({ mvno_id, date_from, date_to });
    res.json({ success: true, data });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.get('/dashboard/distributor-summary', async (req: Request, res: Response) => {
  try {
    const mvno_id = req.query.mvno_id ? String(req.query.mvno_id) : undefined;
    const date_from = req.query.date_from ? String(req.query.date_from) : undefined;
    const date_to = req.query.date_to ? String(req.query.date_to) : undefined;
    const data = await stockService.getDistributorSummary({ mvno_id, date_from, date_to });
    res.json({ success: true, data });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// eSIM totals
router.get('/total-esim-stock', async (req: Request, res: Response) => {
  try {
    const totals = await stockService.getTotalEsimStock();
    res.json({ success: true, data: totals });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// eSIM by operator
router.get('/esim-stock-by-operator', async (req: Request, res: Response) => {
  try {
    const rows = await stockService.getEsimStockByOperator();
    res.json({ success: true, data: rows });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// eSIM stock list
router.get('/esim-stock', async (req: Request, res: Response) => {
  try {
    const { limit, offset, mvno, status, search } = req.query;
    const rows = await stockService.getEsimStock({
      limit: limit ? parseInt(String(limit)) : undefined,
      offset: offset ? parseInt(String(offset)) : undefined,
      mvno: mvno ? String(mvno) : undefined,
      status: status ? String(status) : undefined,
      search: search ? String(search) : undefined,
    });
    res.json({ success: true, data: rows });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

router.get('/esim-stock/count', async (req: Request, res: Response) => {
  try {
    const { mvno, status, search } = req.query;
    const count = await stockService.getEsimStockCount({
      mvno: mvno ? String(mvno) : undefined,
      status: status ? String(status) : undefined,
      search: search ? String(search) : undefined,
    });
    res.json({ success: true, data: { count } });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// ==================== STOCK ISSUANCE REQUEST ROUTES ====================

// Get all stock issuance requests
router.get('/requests', async (req: Request, res: Response) => {
  try {
    const requests = await stockService.getAllStockIssuanceRequests();
    res.json({ success: true, data: requests });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Get single stock issuance request
router.get('/requests/:id', async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id as string;
    const request = await stockService.getStockIssuanceRequestById(requestId);
    if (!request) {
      return fail(res, 404, 'Request not found');
    }

    const reqAny: any = request;

    // Hydrate distributor and MVNO display names
    let distributorName = reqAny.distributor_name || null;
    if (!distributorName && request.requester_id) {
      const dist = await stockService.getDistributorById(request.requester_id);
      distributorName = dist?.name || null;
    }
    const mvnos = await stockService.getMvnos();
    const mvnoName = mvnos.find((m: any) => m.id === request.mvno_id)?.name || null;

    // Build physical box details with carton/box number and ICCID range + picked quantity
    let assigned_box_details: any[] = [];
    const boxIds =
      Array.isArray(request.assigned_box_quantities) && request.assigned_box_quantities.length
        ? request.assigned_box_quantities.map((b: any) => b.box_id).filter(Boolean)
        : Array.isArray(reqAny.assigned_box_ids)
          ? reqAny.assigned_box_ids
          : [];

    if (boxIds.length) {
      const boxDetails = await query(
        `SELECT 
            b.id::text   AS box_id,
            b.box_number,
            b.box_number || '/800' AS box_display,
            c.carton_number,
            COALESCE(latest_pick.iccid_start, b.iccid_start) AS iccid_start,
            COALESCE(latest_pick.iccid_end, b.iccid_end) AS iccid_end,
            COALESCE(b.total_sims, 0) AS total_sims,
            COALESCE(latest_pick.sims_picked, 0) AS sims_picked
         FROM boxes b
         LEFT JOIN cartons c ON b.carton_id = c.id
         LEFT JOIN LATERAL (
           SELECT bpr.iccid_start, bpr.iccid_end, bpr.sims_picked
           FROM box_pick_records bpr
           WHERE bpr.box_id = b.id
             AND bpr.distributor_id = $1::uuid
           ORDER BY bpr.picked_at DESC
           LIMIT 1
         ) latest_pick ON true
         WHERE b.id = ANY($2::uuid[])
         ORDER BY c.carton_number, b.box_number`,
        [request.requester_id, boxIds]
      );
      assigned_box_details = boxDetails.rows;
    }

    // Compute eSIM ICCID range helper
    let esim_iccid_range: { start: string | null; end: string | null } | null = null;
    if (Array.isArray(request.assigned_esim_iccids) && request.assigned_esim_iccids.length > 0) {
      const sorted = [...request.assigned_esim_iccids].sort();
      esim_iccid_range = { start: sorted[0], end: sorted[sorted.length - 1] };
    }

    res.json({
      success: true,
      data: {
        ...request,
        distributor_name: distributorName,
        mvno_name: mvnoName,
        assigned_box_details,
        esim_iccid_range,
      },
    });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Create new stock issuance request
router.post('/requests', async (req: Request, res: Response) => {
  try {
    // Accept both camelCase (API standard) and snake_case (frontend legacy)
    const mvnoId = req.body.mvnoId || req.body.mvno_id;
    const requesterId = req.body.requesterId || req.body.requester_id || req.body.created_by || 'system';
    const simType = req.body.simType || req.body.sim_type;
    const quantity = req.body.quantity;
    const notes = req.body.notes;
    const level1ApproverEmail = req.body.level_1_approver_email;
    const level2ApproverEmail = req.body.level_2_approver_email;
    const contactPerson = req.body.contact_person;
    const contactEmail = req.body.contact_email;
    const signature = req.body.signature;
    
    if (!mvnoId || !simType || !quantity) {
      return fail(res, 400, 'mvnoId (or mvno_id), simType (or sim_type), and quantity are required');
    }
    
    const request = await stockService.createStockIssuanceRequest(
      mvnoId, 
      requesterId, 
      simType, 
      quantity, 
      notes,
      contactPerson,
      contactEmail,
      signature
    );
    
    // If approver emails provided, save them to the request
    if ((level1ApproverEmail || level2ApproverEmail) && request) {
      await stockService.updateRequestApprovers(request.id, level1ApproverEmail, level2ApproverEmail);
    }
    
    res.status(201).json({ success: true, data: request });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// ==================== APPROVAL ROUTES ====================

// Request approval tokens for a stock issuance request
router.post('/request-approval', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.body;

    logLine('INF', 'APPROVAL', `request-approval received for request ${String(requestId || '')}`);
    
    if (!requestId) {
      return fail(res, 400, 'requestId is required');
    }
    
    // Get the request with full details
    const stockRequest = await stockService.getStockIssuanceRequestById(requestId);
    if (!stockRequest) {
      return fail(res, 404, 'Stock request not found');
    }
    
    // Get MVNO name
    const mvnos = await stockService.getMvnos();
    const mvno = mvnos.find((m: any) => m.id === stockRequest.mvno_id);
    const mvnoName = mvno?.name || stockRequest.mvno_id;
    
    // Get distributor name (if available)
    let distributorName = 'N/A';
    if (stockRequest.requester_id) {
      const distributor = await stockService.getDistributorById(stockRequest.requester_id);
      distributorName = distributor?.name || 'N/A';
    }
    
    // Get box details
    let assignedBoxes: any[] = [];
    if (stockRequest.assigned_box_quantities && stockRequest.assigned_box_quantities.length > 0) {
      const boxes = await stockService.getBoxes();
      assignedBoxes = stockRequest.assigned_box_quantities.map((box: any) => {
        const boxInfo = boxes.find((b: any) => b.box_id === box.box_id || b.id === box.box_id);
        return {
          box_id: box.box_id,
          box_number: boxInfo?.box_number || null,
          carton_number: boxInfo?.carton_number || null,
          quantity: box.quantity
        };
      });
    }
    
    // Get eSIM ICCIDs
    let assignedEsims: string[] = [];
    if (stockRequest.assigned_esim_iccids && stockRequest.assigned_esim_iccids.length > 0) {
      assignedEsims = stockRequest.assigned_esim_iccids;
    }
    
    // Create approval tokens
    const tokens = await stockService.createApprovalTokens(requestId);
    logLine('INF', 'APPROVAL', `created ${tokens.length} approval tokens for request ${requestId}`);
    
    // Also create records in approval_responses table for each token
    for (const token of tokens) {
      await query(
        'SELECT * FROM insert_approval_response($1, $2, $3)',
        [requestId, token.approver_email, token.token]
      );
    }
    
    // Send approval emails to each approver
    const emailResults: Array<{ approver_role: string; approver_email: string; sent: boolean }> = [];
    for (const token of tokens) {
      const sent = await emailService.sendApprovalEmail(
        {
          token: token.token,
          request_id: requestId,
          approver_email: token.approver_email,
          approver_role: token.approver_role,
          status: 'pending',
          expires_at: token.expires_at,
          created_at: stockRequest.created_at,
          updated_at: stockRequest.updated_at,
          // Additional details
          mvno_name: mvnoName,
          mvno_id: stockRequest.mvno_id,
          sim_type: stockRequest.sim_type,
          quantity: stockRequest.quantity,
          distributor_name: distributorName,
          assigned_boxes: assignedBoxes,
          assigned_esims: assignedEsims,
        },
        config.app.baseUrl
      );
      emailResults.push({
        approver_role: token.approver_role,
        approver_email: token.approver_email,
        sent,
      });

      logLine(
        sent ? 'INF' : 'WRN',
        'APPROVAL',
        `approval email ${sent ? 'sent' : 'failed'} for request ${requestId} role=${token.approver_role} email=${token.approver_email}`
      );
    }

    const sentCount = emailResults.filter((r) => r.sent).length;
    const attemptedCount = emailResults.length;
    const allDelivered = attemptedCount > 0 && sentCount === attemptedCount;
    const noneDelivered = sentCount === 0;

    if (noneDelivered) {
      logLine('ERR', 'APPROVAL', `no approval emails delivered for request ${requestId}`);
    }
    
    // Store resolved approver emails on the request so they are visible before any approvals
    const l1Token = tokens.find((t: any) => t.approver_role === 'LEVEL_1');
    const l2Token = tokens.find((t: any) => t.approver_role === 'LEVEL_2');
    if (l1Token || l2Token) {
      await query(
        `UPDATE stock_issuance_requests
         SET level_1_approver_email = COALESCE(level_1_approver_email, $2),
             level_2_approver_email = COALESCE(level_2_approver_email, $3),
             updated_at = NOW()
         WHERE id = $1`,
        [requestId, l1Token?.approver_email || null, l2Token?.approver_email || null]
      );
    }

    // Update status to AWAITING_EMAIL_APPROVAL after sending emails
    if (sentCount > 0) {
      await stockService.updateRequestStatus(requestId, 'AWAITING_EMAIL_APPROVAL');
      await stockService.addAuditLog(requestId, 'AWAITING_EMAIL_APPROVAL', {
        sent_count: sentCount,
        attempted_count: attemptedCount,
        approvers: emailResults.map(r => r.approver_email),
      });
      logLine('INF', 'APPROVAL', `request ${requestId} moved to AWAITING_EMAIL_APPROVAL (${sentCount}/${attemptedCount} delivered)`);
    }
    
    res.status(allDelivered ? 201 : 202).json({ 
      success: true, 
      data: { tokens, emailResults, sentCount, attemptedCount },
      message: allDelivered
        ? 'Approval emails sent successfully'
        : noneDelivered
          ? 'Approval created, but no approval emails were delivered. Request is still available in Approve Stock.'
          : `Approval created with partial email delivery (${sentCount}/${attemptedCount})`,
    });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Email approval click endpoint - GET method for clicking links in emails (NEW - separate from distributor flow)
router.get('/email-approve', async (req: Request, res: Response) => {
  try {
    const { token, action } = req.query;
    const frontendUrl = config.app.frontendUrl;

    logLine('INF', 'EMAIL_APPROVAL', `email-approve hit token=${String(token || '')} action=${String(action || '')}`);
    
    if (!token || typeof token !== 'string') {
      logLine('WRN', 'EMAIL_APPROVAL', 'missing token in email-approve request');
      return res.redirect(`${frontendUrl}/approve?error=invalid_token`);
    }
    
    const approved = action === 'approve';
    const actionStr = approved ? 'approve' : 'reject';
    
    // Use the new approval response function
    const validation = await query(
      'SELECT * FROM record_approval_response($1, $2)',
      [token, actionStr]
    );
    
    if (!validation.rows[0]?.success) {
      logLine('WRN', 'EMAIL_APPROVAL', `token validation failed: ${String(validation.rows[0]?.message || 'invalid_token')}`);
      return res.redirect(`${frontendUrl}/approve?error=${encodeURIComponent(validation.rows[0]?.message || 'invalid_token')}`);
    }
    
    const requestId = validation.rows[0].request_id;
    const approverEmail = validation.rows[0].email || '';
    
    // Log the action
    await stockService.addAuditLog(
      requestId,
      approved ? 'EMAIL_APPROVED' : 'EMAIL_REJECTED',
      { email: approverEmail, action: actionStr, source: 'email_link' }
    );

    logLine('INF', 'EMAIL_APPROVAL', `recorded ${actionStr} for request ${requestId} by ${approverEmail || 'unknown-email'}`);
    logLine('INF', 'EMAIL_APPROVAL', `redirecting browser to frontend /approve for request ${requestId}`);
    
    // Redirect to frontend with success - the background checker will update status
    return res.redirect(`${frontendUrl}/approve?success=true&action=${actionStr}&request=${requestId}&source=email`);
  } catch (error: any) {
    logLine('ERR', 'EMAIL_APPROVAL', `email-approve handler error: ${String(error?.message || error)}`);
    return res.redirect(`${config.app.frontendUrl}/approve?error=${encodeURIComponent(error.message || 'unknown_error')}`);
  }
});

// Legacy endpoint - keep for backward compatibility
router.get('/approve', async (req: Request, res: Response) => {
  try {
    const { token, action } = req.query;
    const frontendUrl = config.app.frontendUrl;
    
    if (!token || typeof token !== 'string') {
      return res.redirect(`${frontendUrl}/approve?error=invalid_token`);
    }
    
    const approved = action === 'approve';
    const actionStr = approved ? 'approve' : 'reject';
    
    // Use the new approval response function
    const validation = await query(
      'SELECT * FROM record_approval_response($1, $2)',
      [token, actionStr]
    );
    
    if (!validation.rows[0]?.success) {
      return res.redirect(`${frontendUrl}/approve?error=${encodeURIComponent(validation.rows[0]?.message || 'invalid_token')}`);
    }
    
    const requestId = validation.rows[0].request_id;
    const approverEmail = validation.rows[0].email || '';
    
    // Log the action
    await stockService.addAuditLog(
      requestId,
      approved ? 'EMAIL_APPROVED' : 'EMAIL_REJECTED',
      { email: approverEmail, action: actionStr }
    );
    
    // Redirect to frontend with success - the background checker will update status
    return res.redirect(`${frontendUrl}/approve?success=true&action=${actionStr}&request=${requestId}`);
  } catch (error: any) {
    console.error('[APPROVE/GET] Error:', error);
    return res.redirect(`${config.app.frontendUrl}/approve?error=${encodeURIComponent(error.message || 'unknown_error')}`);
  }
});

// Verify and process approval token
router.post('/approve/verify', async (req: Request, res: Response) => {
  try {
    const { token, action, email, reason } = req.body;
    logLine('INF', 'EMAIL_APPROVAL', `approve/verify called action=${String(action || '')} token_present=${Boolean(token)} email=${String(email || '')}`);
    
    if (!token || !action) {
      return fail(res, 400, 'token and action are required');
    }
    
    if (!['approve', 'reject'].includes(action)) {
      return fail(res, 400, 'action must be either "approve" or "reject"');
    }
    
    // Use the new approval response function
    const validation = await query(
      'SELECT * FROM record_approval_response($1, $2)',
      [token, action]
    );
    
    if (!validation.rows[0]?.success) {
      logLine('WRN', 'EMAIL_APPROVAL', `approve/verify token validation failed: ${String(validation.rows[0]?.message || 'Invalid token')}`);
      return res.status(400).json({ success: false, error: validation.rows[0]?.message || 'Invalid token' });
    }
    
    // Log the action
    await stockService.addAuditLog(
      validation.rows[0].request_id,
      action === 'approve' ? 'EMAIL_APPROVED' : 'EMAIL_REJECTED',
      { email: validation.rows[0].email, action }
    );

    logLine('INF', 'EMAIL_APPROVAL', `approve/verify recorded ${action} for request ${validation.rows[0].request_id}`);
    
    // The background checker will update the status based on consensus
    res.json({ 
      success: true, 
      message: validation.rows[0].message,
      request_id: validation.rows[0].request_id
    });
  } catch (error: any) {
    logLine('ERR', 'EMAIL_APPROVAL', `approve/verify error: ${String(error?.message || error)}`);
    fail(res, 500, error.message);
  }
});

// ==================== STOCK ASSIGNMENT ROUTES ====================

// Assign stock to a request (changes status to READY_FOR_APPROVAL)
router.post('/stock/assign/:id', async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id as string;
    const { carton_number, box_number, quantity_assigned } = req.body;
    
    if (!requestId || !carton_number || !box_number || !quantity_assigned) {
      return fail(res, 400, 'requestId, carton_number, box_number, and quantity_assigned are required');
    }
    
    const result = await stockService.assignStockToRequest(
      requestId, 
      carton_number, 
      box_number, 
      quantity_assigned
    );
    
    res.json({ success: true, data: result });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Level 1 approval
router.post('/stock/approve-l1/:id', async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id as string;
    const { approverId, approverEmail } = req.body;
    const level1Approver = await stockService.getApproverByLevel('LEVEL_1');
    const effectiveApproverEmail = level1Approver?.approver_email || approverEmail;
    
    const result = await stockService.approveLevel1(requestId, approverId, effectiveApproverEmail);
    if (!result?.success) {
      return fail(res, 400, result?.message || 'Level 1 approval failed');
    }

    const level2Approver = await stockService.getApproverByLevel('LEVEL_2');
    if (level2Approver?.approver_email) {
      let level2Token = await stockService.getApprovalTokenByRequestAndLevel(requestId, 'LEVEL_2');
      if (!level2Token) {
        const newTokens = await stockService.createApprovalTokens(requestId);
        level2Token = newTokens.find((t: any) => String(t.approver_role || '').toUpperCase() === 'LEVEL_2') || null;
      }

      if (level2Token?.token) {
        const sent = await emailService.sendApprovalEmail(
          {
            token: level2Token.token,
            request_id: requestId,
            approver_email: level2Approver.approver_email,
            approver_role: level2Approver.approver_role || 'LEVEL_2',
            approver_name: level2Approver.approver_name,
            status: 'pending',
            expires_at: level2Token.expires_at,
            created_at: level2Token.created_at,
            updated_at: (level2Token as any).updated_at || level2Token.created_at,
          },
          config.app.baseUrl
        );
        if (!sent) {
          logLine('WRN', 'APPROVAL', `Failed to send Level 2 approval email for request ${requestId}`);
        }
      } else {
        logLine('WRN', 'APPROVAL', `No active Level 2 approval token found for request ${requestId}`);
      }
    } else {
      logLine('WRN', 'APPROVAL', `No active Level 2 approver configured for request ${requestId}`);
    }

    if (result?.success && effectiveApproverEmail) {
      await emailService.sendApprovalConfirmationEmail(
        effectiveApproverEmail,
        requestId,
        true,
        config.app.baseUrl
      );
    }

    res.json({ success: true, data: result });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Level 2 approval
router.post('/stock/approve-l2/:id', async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id as string;
    const { approverId, approverEmail } = req.body;
    const level2Approver = await stockService.getApproverByLevel('LEVEL_2');
    const effectiveApproverEmail = level2Approver?.approver_email || approverEmail;
    
    const approvalResult = await stockService.approveLevel2(requestId, approverId, effectiveApproverEmail);
    if (!approvalResult?.success) {
      return fail(res, 400, approvalResult?.message || 'Level 2 approval failed');
    }

    const issuanceResult = await stockService.issueApprovedStockRequest(requestId);

    if (effectiveApproverEmail) {
      await emailService.sendApprovalConfirmationEmail(
        effectiveApproverEmail,
        requestId,
        true,
        config.app.baseUrl
      );
    }

    res.json({ success: true, data: { approval: approvalResult, issuance: issuanceResult } });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Reject request from management UI
router.post('/stock/reject/:id', async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id as string;
    const { rejecterId, rejecterEmail, reason } = req.body || {};

    if (!rejecterId || !rejecterEmail) {
      return fail(res, 400, 'rejecterId and rejecterEmail are required');
    }

    const rejectionReason = String(reason || '').trim() || 'Rejected by approver';
    const result = await stockService.rejectStockRequest(requestId, rejecterId, rejecterEmail, rejectionReason);
    if (!result?.success) {
      return fail(res, 400, result?.message || 'Request rejection failed');
    }

    await emailService.sendApprovalConfirmationEmail(
      rejecterEmail,
      requestId,
      false,
      config.app.baseUrl
    );

    res.json({ success: true, data: result });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Final stock issuance after Level 2 approval
router.post('/stock/issue/:id', async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id as string;
    
    // Check current status
    const request = await stockService.getStockIssuanceRequestById(requestId);
    if (!request) {
      return fail(res, 404, 'Request not found');
    }
    
    // Allow issuance if status is READY_FOR_APPROVAL (both email approvals received)
    // or LEVEL_2_APPROVED (legacy)
    // or STOCK_ISSUED (to regenerate PDF)
    // or COMPLETED (to regenerate PDF after final report)
    // or AWAITING_EMAIL_APPROVAL (consensus approval flow)
    const allowedStatuses = ['READY_FOR_APPROVAL', 'LEVEL_2_APPROVED', 'STOCK_ISSUED', 'COMPLETED', 'AWAITING_EMAIL_APPROVAL'];
    if (!allowedStatuses.includes(request.status)) {
      return fail(res, 400, `Cannot issue stock. Request status is '${request.status}'. Expected: READY_FOR_APPROVAL, LEVEL_2_APPROVED, STOCK_ISSUED, or COMPLETED`);
    }
    
    const result = await stockService.issueApprovedStockRequest(requestId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Cancel a stock issuance request
router.post('/stock/cancel/:id', async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id as string;
    const { cancelledBy } = req.body;
    
    if (!cancelledBy) {
      return fail(res, 400, 'cancelledBy is required');
    }
    
    const result = await stockService.cancelStockRequest(requestId, cancelledBy);
    res.json({ success: true, data: result });
  } catch (error: any) {
    fail(res, 400, error.message);
  }
});

router.post('/stock/reverse-distribution/:id', async (req: Request, res: Response) => {
  try {
    const recordId = req.params.id as string;
    const { reversedBy, reason } = req.body || {};

    if (!reversedBy) {
      return fail(res, 400, 'reversedBy is required');
    }

    // First check if this is a manual provisioning record
    const pickHistoryResult = await query(
      'SELECT * FROM pick_history WHERE id = $1 OR manual_request_id = $1 LIMIT 1',
      [recordId]
    );
    
    let data;
    if (pickHistoryResult.rows.length > 0) {
      // This is a manual provisioning record - reverse directly to stock pool
      data = await stockService.reverseManualProvisioning(
        recordId,
        String(reversedBy),
        reason ? String(reason) : undefined
      );
    } else {
      // This is a stock issuance request - reverse to approval workflow
      data = await stockService.reverseDistributionToApproval(
        recordId,
        String(reversedBy),
        reason ? String(reason) : undefined
      );
    }
    
    res.json({ success: true, data });
  } catch (error: any) {
    fail(res, 400, error.message);
  }
});

// PDF Generation & Viewing — returns real PDF binary with proper headers
router.get('/pdf/view/:id', async (req: Request, res: Response) => {
  try {
    const recordId = req.params.id as string;
    // Look up by request_id, manual_request_id, or id — the frontend passes COALESCE(request_id, manual_request_id)
    const phResult = await query(
      `SELECT * FROM pick_history
       WHERE id::text = $1 OR request_id::text = $1 OR manual_request_id::text = $1
       LIMIT 1`,
      [recordId]
    );
    if (phResult.rows.length === 0) return fail(res, 404, 'Record not found');
    const ph = phResult.rows[0];

    // Fetch distributor name
    const distId = ph.distributor_id;
    let distributorName = 'Unknown';
    let distributorEmail = '';
    if (distId) {
      const dRes = await query('SELECT name, email FROM distributors WHERE id = $1', [distId]);
      if (dRes.rows.length > 0) {
        distributorName = dRes.rows[0].name || 'Unknown';
        distributorEmail = dRes.rows[0].email || '';
      }
    }

    // Build assigned_boxes from pick_history.assigned_boxes JSONB
    const assignedBoxes: any[] = [];
    const rawBoxes = Array.isArray(ph.assigned_boxes) ? ph.assigned_boxes : [];
    for (const ab of rawBoxes) {
      const boxId = ab.box_id;
      if (!boxId) continue;
      const bRes = await query(
        `SELECT b.box_number, b.iccid_start, b.iccid_end, b.total_sims,
                c.carton_number
         FROM boxes b
         LEFT JOIN cartons c ON b.carton_id = c.id
         WHERE b.id = $1`, [boxId]
      );
      const box = bRes.rows[0] || {};
      assignedBoxes.push({
        box_id: boxId,
        carton_number: box.carton_number || null,
        box_number: box.box_number ? String(box.box_number) : null,
        box_display: box.box_number ? String(box.box_number) : null,
        msisdn_start: box.iccid_start || null,
        msisdn_end: box.iccid_end || null,
        total_sims: box.total_sims || ab.quantity || 0,
        sims_picked: ab.quantity || box.total_sims || 0,
      });
    }

    // Parse eSIM ICCIDs — ensure they are plain strings
    let esimIccids: string[] = [];
    if (Array.isArray(ph.assigned_esims)) {
      esimIccids = ph.assigned_esims.map((v: any) => String(v));
    }

    const { generatePickFormPDF } = await import('../services/pdf.service.js');
    const pdfBuffer = await generatePickFormPDF({
      request_id: ph.manual_request_id || ph.request_id || ph.id,
      distributor_name: distributorName,
      request_date: ph.issued_at || ph.created_at || new Date().toISOString(),
      requested_quantity: ph.quantity || esimIccids.length || 0,
      assigned_boxes: assignedBoxes,
      approved_by_l1_email: ph.approved_by_l1_email || null,
      approved_by_l2_email: ph.approved_by_l2_email || null,
      approved_by_l3_email: ph.approved_by_l3_email || null,
      issued_by: ph.issued_by || null,
      sim_type: (ph.sim_type || 'PHYSICAL').toUpperCase() === 'ESIM' ? 'ESIM' : 'PHYSICAL',
      esim_iccids: esimIccids,
      contact_email: distributorEmail || null,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="pick-form-${recordId}.pdf"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(pdfBuffer);
  } catch (err: any) {
    fail(res, 500, err.message);
  }
});

// Generate PDF for manual provisioning record
router.post('/manual-provisioning/:id/generate-pdf', async (req: Request, res: Response) => {
  try {
    const recordId = req.params.id as string;
    // Find the manual provisioning record in pick_history
    const pickHistoryResult = await query(
      'SELECT * FROM pick_history WHERE id = $1 OR manual_request_id = $1 LIMIT 1',
      [recordId]
    );
    
    if (pickHistoryResult.rows.length === 0) {
      return fail(res, 404, 'Manual provisioning record not found');
    }
    
    const ph = pickHistoryResult.rows[0];
    
    // Get distributor name and contact_person
    const distributorResult = await query(
      'SELECT name, contact_person FROM distributors WHERE id = $1',
      [ph.distributor_id]
    );
    
    // Fetch full box details for each assigned box
    const assignedBoxes = Array.isArray(ph.assigned_boxes) ? ph.assigned_boxes : [];
    let assignedBoxDetails: any[] = [];
    if (assignedBoxes.length > 0) {
      const boxIds = assignedBoxes.map((b: any) => b.box_id).filter(Boolean);
      if (boxIds.length > 0) {
        const boxDetailsResult = await query(
          `SELECT
             b.id::text AS box_id,
             b.box_number::text AS box_number,
             b.box_number::text || '/800' AS box_display,
             c.carton_number,
             b.iccid_start AS msisdn_start,
             b.iccid_end AS msisdn_end,
             COALESCE(b.total_sims, 0) AS total_sims
           FROM boxes b
           LEFT JOIN cartons c ON b.carton_id = c.id
           WHERE b.id = ANY($1::uuid[])
           ORDER BY c.carton_number, b.box_number`,
          [boxIds]
        );
        assignedBoxDetails = boxDetailsResult.rows.map((row: any) => ({
          ...row,
          sims_picked: assignedBoxes.find((b: any) => b.box_id === row.box_id)?.quantity ?? row.total_sims,
        }));
      }
    }
    
    const { savePickFormPDF } = await import('../services/pdf.service.js');
    const pdfUrl = await savePickFormPDF({
      request_id: ph.id,
      distributor_name: distributorResult.rows[0]?.name || 'Unknown',
      request_date: ph.issued_at,
      requested_quantity: ph.quantity,
      assigned_boxes: assignedBoxDetails,
      approved_by_l1_email: ph.approved_by_l1_email || null,
      approved_by_l2_email: ph.approved_by_l2_email || null,
      approved_by_l3_email: ph.approved_by_l3_email || null,
      issued_by: ph.issued_by || 'system',
      picked_by_name: distributorResult.rows[0]?.contact_person || distributorResult.rows[0]?.name || 'Contact Person',
      form_title: 'Manual Stock Provisioning Form',
      sim_type: ph.sim_type,
      esim_iccids: ph.assigned_esims || [],
    });
    
    if (pdfUrl) {
      await query(
        `UPDATE pick_history
         SET pick_form_url = $1
         WHERE id = $2`,
        [pdfUrl, ph.id]
      );
    }
    
    res.json({ success: true, data: { pdf_url: pdfUrl } });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Reverse manual provisioning - return stock directly to pool
router.post('/manual-provisioning/:id/reverse', async (req: Request, res: Response) => {
  try {
    const recordId = req.params.id as string;
    const { reversedBy, reason } = req.body || {};

    if (!reversedBy) {
      return fail(res, 400, 'reversedBy is required');
    }

    // Delegate all logic to the service function (handles not-found, already-reversed, stock rollback)
    const result = await stockService.reverseManualProvisioning(
      recordId,
      String(reversedBy),
      reason ? String(reason) : undefined
    );
    
    res.json({ success: true, data: result });
  } catch (error: any) {
    fail(res, 400, error.message);
  }
});

// Get manual provisioning record by ID
router.get('/manual-provisioning/:id', async (req: Request, res: Response) => {
  try {
    const recordId = req.params.id as string;
    
    const pickHistoryResult = await query(
      'SELECT * FROM pick_history WHERE id = $1 OR manual_request_id = $1 LIMIT 1',
      [recordId]
    );
    
    if (pickHistoryResult.rows.length === 0) {
      return fail(res, 404, 'Manual provisioning record not found');
    }
    
    res.json({ success: true, data: pickHistoryResult.rows[0] });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Generate PDF for either stock issuance request or manual provisioning record
router.post('/stock/generate-pdf/:id', async (req: Request, res: Response) => {
  try {
    const recordId = req.params.id as string;
    // First try to find it as a stock issuance request
    let request = await stockService.getStockIssuanceRequestById(recordId);
    let isManualProvisioning = false;
    
    // If not found, try to find it as a manual provisioning record
    let pickHistoryResult: any;
    if (!request) {
      pickHistoryResult = await query(
        'SELECT * FROM pick_history WHERE id = $1 OR manual_request_id = $1 LIMIT 1',
        [recordId]
      );
      
      if (pickHistoryResult.rows.length === 0) {
        return fail(res, 404, 'Record not found');
      }
      
      isManualProvisioning = true;
      const ph = pickHistoryResult.rows[0];
      
      // Create a mock request object for PDF generation
      request = {
        id: ph.manual_request_id || ph.id,
        mvno_id: ph.mvno_id,
        requester_id: ph.distributor_id,
        sim_type: ph.sim_type,
        quantity: ph.quantity,
        status: 'COMPLETED',
        assigned_box_quantities: ph.assigned_boxes || [],
        assigned_esim_iccids: ph.assigned_esims || [],
        notes: ph.purpose || null,
        created_at: ph.issued_at,
        updated_at: ph.issued_at
      };
    }
    
    // Check current status
    const allowedStatuses = ['READY_FOR_APPROVAL', 'LEVEL_2_APPROVED', 'STOCK_ISSUED', 'COMPLETED'];
    if (!isManualProvisioning && !allowedStatuses.includes(request.status)) {
      return fail(res, 400, `Cannot generate PDF. Request status is '${request.status}'. Expected: READY_FOR_APPROVAL, LEVEL_2_APPROVED, STOCK_ISSUED, or COMPLETED`);
    }
    
    // For manual provisioning, just regenerate the PDF using existing data
    if (isManualProvisioning) {
      const ph = pickHistoryResult.rows[0];
      const distributorResult = await query(
        'SELECT name, contact_person FROM distributors WHERE id = $1',
        [ph.distributor_id]
      );
      
      // Fetch full box details for each assigned box
      const rawBoxes = Array.isArray(ph.assigned_boxes) ? ph.assigned_boxes : [];
      let assignedBoxDetails: any[] = [];
      if (rawBoxes.length > 0) {
        const boxIds = rawBoxes.map((b: any) => b.box_id).filter(Boolean);
        if (boxIds.length > 0) {
          const boxDetailsResult = await query(
            `SELECT
               b.id::text AS box_id,
               b.box_number::text AS box_number,
               b.box_number::text || '/800' AS box_display,
               c.carton_number,
               b.iccid_start AS msisdn_start,
               b.iccid_end AS msisdn_end,
               COALESCE(b.total_sims, 0) AS total_sims
             FROM boxes b
             LEFT JOIN cartons c ON b.carton_id = c.id
             WHERE b.id = ANY($1::uuid[])
             ORDER BY c.carton_number, b.box_number`,
            [boxIds]
          );
          assignedBoxDetails = boxDetailsResult.rows.map((row: any) => ({
            ...row,
            sims_picked: rawBoxes.find((b: any) => b.box_id === row.box_id)?.quantity ?? row.total_sims,
          }));
        }
      }
      
      const { savePickFormPDF } = await import('../services/pdf.service.js');
      const pdfUrl = await savePickFormPDF({
        request_id: ph.id,
        distributor_name: distributorResult.rows[0]?.name || 'Unknown',
        request_date: ph.issued_at,
        requested_quantity: ph.quantity,
        assigned_boxes: assignedBoxDetails,
        approved_by_l1_email: ph.approved_by_l1_email || null,
        approved_by_l2_email: ph.approved_by_l2_email || null,
        approved_by_l3_email: ph.approved_by_l3_email || null,
        issued_by: ph.issued_by || 'system',
        picked_by_name: distributorResult.rows[0]?.contact_person || distributorResult.rows[0]?.name || 'Contact Person',
        form_title: 'Manual Stock Provisioning Form',
        sim_type: ph.sim_type,
        esim_iccids: ph.assigned_esims || [],
      });
      
      if (pdfUrl) {
        await query(
          `UPDATE pick_history
           SET pick_form_url = $1
           WHERE id = $2`,
          [pdfUrl, ph.id]
        );
      }
      
      res.json({ success: true, data: { pdf_url: pdfUrl } });
    } else {
      // For stock issuance requests, use the existing issueStock endpoint logic
      const result = await stockService.issueApprovedStockRequest(recordId);
      res.json({ success: true, data: result });
    }
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// ==================== CONSENSUS APPROVAL ROUTES ====================

// Send approval emails to approvers (creates approval_responses)
router.post('/send-approval-emails', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.body;
    
    if (!requestId) {
      return fail(res, 400, 'requestId is required');
    }
    
    // Get request details with box info and ICCID ranges
    const requestDetails = await query(`
      SELECT 
        sir.*,
        mvno.name as mvno_name,
        d.name as distributor_name
      FROM stock_issuance_requests sir
      LEFT JOIN mvnos mvno ON sir.mvno_id = mvno.id
      LEFT JOIN distributors d ON sir.requester_id = d.id
      WHERE sir.id = $1
    `, [requestId]);
    
    const request = requestDetails.rows[0];
    if (!request) {
      return fail(res, 404, 'Request not found');
    }
    
    // Get box details with ICCID ranges
    let assignedBoxes: any[] = [];
    if (request.assigned_box_ids && request.assigned_box_ids.length > 0) {
      const boxDetails = await query(`
        SELECT 
          b.id as box_id,
          b.box_number,
          b.box_number || '/800' AS box_display,
          c.carton_number,
          b.iccid_start,
          b.iccid_end,
          br.sims_picked as quantity
        FROM boxes b
        LEFT JOIN cartons c ON b.carton_id = c.id
        LEFT JOIN box_pick_records br ON br.box_id = b.id AND br.distribution_id::text = $1
        WHERE b.id = ANY($2)
      `, [requestId, request.assigned_box_ids]);
      
      assignedBoxes = boxDetails.rows;
    }
    
    // Get eSIM details
    let assignedEsims: string[] = [];
    if (request.assigned_esim_iccids && request.assigned_esim_iccids.length > 0) {
      assignedEsims = request.assigned_esim_iccids;
    }
    
    // Get approvers
    const approvers = await stockService.getAllApprovers();
    if (!approvers || approvers.length < 2) {
      return fail(res, 400, 'Need at least 2 approvers configured');
    }
    
    const approvalResults = [];
    
    // Generate random token
    const generateToken = () => crypto.randomBytes(32).toString('hex');
    
    // Send emails to each approver
    for (const approver of approvers) {
      // Generate token for this approver
      const token = generateToken();
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const now = new Date().toISOString();
      
      // Insert into approval_responses
      await query(
        'SELECT * FROM insert_approval_response($1, $2, $3)',
        [requestId, approver.approver_email, token]
      );
      
      // Send email with approve/reject links and full details
      const emailSent = await emailService.sendApprovalEmail(
        {
          token: token,
          request_id: requestId,
          approver_email: approver.approver_email,
          approver_role: 'APPROVER',
          approver_name: approver.approver_name,
          status: 'pending',
          expires_at: expiresAt,
          created_at: now,
          updated_at: now,
          // Include full request details
          mvno_name: request?.mvno_name,
          mvno_id: request?.mvno_id,
          sim_type: request?.sim_type,
          quantity: request?.quantity,
          distributor_name: request?.distributor_name,
          assigned_boxes: assignedBoxes,
          assigned_esims: assignedEsims
        },
        config.app.baseUrl
      );
      
      approvalResults.push({
        email: approver.approver_email,
        sent: emailSent,
        token: token
      });
      
      logLine(emailSent ? 'INF' : 'WRN', 'APPROVAL', `approval email ${emailSent ? 'sent' : 'failed'} to ${approver.approver_email}`);
    }
    
    // Update status to WAITING_FOR_APPROVAL
    await query(
      'UPDATE stock_issuance_requests SET status = $1, sent_for_approval_at = NOW(), updated_at = NOW() WHERE id = $2',
      ['WAITING_FOR_APPROVAL', requestId]
    );
    
    // Log the action
    await stockService.addAuditLog(
      requestId,
      'APPROVAL_EMAILS_SENT',
      { approvers: approvalResults.map(a => a.email), sent_count: approvalResults.filter(a => a.sent).length }
    );
    
    res.json({ 
      success: true, 
      data: { 
        requestId, 
        approvers: approvalResults.map(a => a.email),
        sentCount: approvalResults.filter(a => a.sent).length
      },
      message: `Approval emails sent to ${approvalResults.length} approvers`
    });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Handle approval/denial from email links (GET for clicking in email)
router.get('/approval/respond', async (req: Request, res: Response) => {
  try {
    const { token, action } = req.query;
    
    if (!token || !action) {
      return res.redirect(`${config.app.baseUrl}/approve?error=missing_params`);
    }
    
    if (!['approve', 'reject'].includes(String(action))) {
      return res.redirect(`${config.app.baseUrl}/approve?error=invalid_action`);
    }
    
    // Use the new approval response function
    const validation = await query(
      'SELECT * FROM record_approval_response($1, $2)',
      [String(token), String(action)]
    );
    
    if (!validation.rows[0]?.success) {
      return res.redirect(`${config.app.baseUrl}/approve?error=${encodeURIComponent(validation.rows[0]?.message || 'invalid_token')}`);
    }
    
    // Log the action
    await stockService.addAuditLog(
      validation.rows[0].request_id,
      action === 'approve' ? 'EMAIL_APPROVED' : 'EMAIL_REJECTED',
      { email: validation.rows[0].email, action }
    );
    
    // Redirect to frontend with success - the background checker will update status
    return res.redirect(`${config.app.baseUrl}/approve?success=true&action=${action}&request=${validation.rows[0].request_id}`);
  } catch (error: any) {
    console.error("❌ Error processing approval response:", error);
    return res.redirect(`${config.app.baseUrl}/approve?error=${encodeURIComponent(error.message)}`);
  }
});

// API endpoint for approval response (POST)
router.post('/approval/respond', async (req: Request, res: Response) => {
  try {
    const { token, action, request_id } = req.body;
    const email = String(req.headers['x-user-email'] || req.body.email || '').trim();

    if (!action || !['approve', 'reject'].includes(action)) {
      return fail(res, 400, 'action must be approve or reject');
    }

    let requestId = request_id ? String(request_id) : '';
    let resolvedEmail = email;

    if ((!requestId || !resolvedEmail) && token) {
      const legacy = await query('SELECT request_id, email FROM approval_responses WHERE token = $1 LIMIT 1', [token]);
      requestId = requestId || legacy.rows[0]?.request_id || '';
      resolvedEmail = resolvedEmail || legacy.rows[0]?.email || '';
    }

    if (!requestId) return fail(res, 400, 'request_id is required');
    if (!resolvedEmail) return fail(res, 401, 'email is required for authenticated approval');

    const actionStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';

    // ── 1. Resolve the two configured approver emails ──
    const reqRow = await query(
      'SELECT level_1_approver_email, level_2_approver_email, status FROM stock_issuance_requests WHERE id = $1',
      [requestId]
    );
    if (!reqRow.rows[0]) return fail(res, 404, 'Request not found');

    let l1Email: string | null = reqRow.rows[0]?.level_1_approver_email || null;
    let l2Email: string | null = reqRow.rows[0]?.level_2_approver_email || null;
    if (!l1Email || !l2Email) {
      const cfgRows = await query(
        `SELECT approver_level, approver_email FROM stock_approver_config WHERE is_active = true AND approver_level IN ('LEVEL_1','LEVEL_2')`
      );
      for (const c of cfgRows.rows) {
        if (c.approver_level === 'LEVEL_1' && !l1Email) l1Email = c.approver_email;
        if (c.approver_level === 'LEVEL_2' && !l2Email) l2Email = c.approver_email;
      }
    }
    const approverEmails = [l1Email, l2Email].filter(Boolean).map(e => (e as string).toLowerCase());

    // ── 2. Map non-approver emails (e.g. admin) → next approver slot ──
    let recordEmail = resolvedEmail;
    let approverSlot: 'LEVEL_1' | 'LEVEL_2' | null = null;

    if (approverEmails.includes(resolvedEmail.toLowerCase())) {
      approverSlot = resolvedEmail.toLowerCase() === (l1Email || '').toLowerCase() ? 'LEVEL_1' : 'LEVEL_2';
    } else {
      // Admin flow: pick the next un-responded slot
      const existing = await query(
        `SELECT LOWER(email) AS email FROM approval_responses WHERE request_id = $1 AND status = 'APPROVED' AND LOWER(email) = ANY($2::text[])`,
        [requestId, approverEmails]
      );
      const alreadyApproved = new Set(existing.rows.map((r: any) => r.email));
      if (l1Email && !alreadyApproved.has(l1Email.toLowerCase())) {
        recordEmail = l1Email.toLowerCase();
        approverSlot = 'LEVEL_1';
      } else if (l2Email && !alreadyApproved.has(l2Email.toLowerCase())) {
        recordEmail = l2Email.toLowerCase();
        approverSlot = 'LEVEL_2';
      }
      if (recordEmail !== resolvedEmail) {
        logLine('INF', 'APPROVAL', `Mapping admin ${resolvedEmail} → ${approverSlot} (${recordEmail})`);
      }
    }

    // ── 3. Idempotency: check if this slot is already approved ──
    const dupCheck = await query(
      `SELECT status FROM approval_responses WHERE request_id = $1 AND LOWER(email) = $2 AND status = 'APPROVED'`,
      [requestId, recordEmail.toLowerCase()]
    );
    if (dupCheck.rows.length > 0 && actionStatus === 'APPROVED') {
      logLine('INF', 'APPROVAL', `Idempotent: ${recordEmail} already approved for ${requestId}`);
      // Still return success — already approved
      return res.json({
        success: true,
        data: {
          message: 'Already approved',
          request_id: requestId,
          approver_slot: approverSlot,
          recorded_as: recordEmail,
          already_approved: true,
        },
      });
    }

    // ── 4. Record the approval response ──
    const tokenValue = token || `${requestId}-${recordEmail}`;
    await query(
      `INSERT INTO approval_responses (request_id, email, status, responded_at, updated_at, token)
       VALUES ($1, $2, $3, NOW(), NOW(), $4)
       ON CONFLICT (request_id, email)
       DO UPDATE SET status = EXCLUDED.status, responded_at = NOW(), updated_at = NOW(), token = EXCLUDED.token`,
      [requestId, recordEmail, actionStatus, tokenValue]
    );

    // ── 5. Update approver fields on the request itself ──
    if (approverSlot === 'LEVEL_1') {
      await query(
        `UPDATE stock_issuance_requests SET level_1_approver_email = $2, level_1_approved_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [requestId, recordEmail]
      );
    } else if (approverSlot === 'LEVEL_2') {
      await query(
        `UPDATE stock_issuance_requests SET level_2_approver_email = $2, level_2_approved_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [requestId, recordEmail]
      );
    }

    await stockService.addAuditLog(requestId, actionStatus === 'APPROVED' ? 'EMAIL_APPROVED' : 'EMAIL_REJECTED', {
      email: resolvedEmail,
      recorded_as: recordEmail,
      approver_slot: approverSlot,
      action,
      source: 'login_flow',
    });

    // ── 6. Immediate consensus check — no waiting for background ──
    const allResponses = await query(
      `SELECT LOWER(email) AS email, status FROM approval_responses WHERE request_id = $1 AND LOWER(email) = ANY($2::text[])`,
      [requestId, approverEmails]
    );
    const approvedCount = allResponses.rows.filter((r: any) => r.status === 'APPROVED').length;
    const rejectedCount = allResponses.rows.filter((r: any) => r.status === 'REJECTED').length;

    let consensusReached = false;
    let finalRequestStatus: string | null = null;

    if (rejectedCount > 0) {
      await query(`UPDATE stock_issuance_requests SET status = 'REJECTED', updated_at = NOW() WHERE id = $1`, [requestId]);
      finalRequestStatus = 'REJECTED';
      consensusReached = true;
      logLine('WRN', 'APPROVAL', `Request ${requestId} REJECTED by consensus (inline)`);
    } else if (approvedCount >= approverEmails.length) {
      // Both approved → issue stock immediately
      logLine('INF', 'APPROVAL', `Request ${requestId} fully approved (${approvedCount}/${approverEmails.length}). Issuing stock inline...`);
      try {
        const result = await stockService.issueApprovedStockRequest(requestId);
        finalRequestStatus = 'COMPLETED';
        consensusReached = true;
        logLine('INF', 'APPROVAL', `Request ${requestId} COMPLETED inline. PDF: ${result.pdf_url || 'none'}`);
      } catch (issueErr: any) {
        logLine('ERR', 'APPROVAL', `Inline issuance failed for ${requestId}: ${issueErr.message}. Background checker will retry.`);
        await query(`UPDATE stock_issuance_requests SET status = 'READY_FOR_APPROVAL', updated_at = NOW() WHERE id = $1`, [requestId]);
      }
    }

    res.json({
      success: true,
      data: {
        message: consensusReached
          ? (finalRequestStatus === 'COMPLETED' ? 'Request Approved Successfully — Stock Issued' : `Request ${finalRequestStatus}`)
          : `Approval recorded (${approvedCount}/${approverEmails.length})`,
        request_id: requestId,
        approver_slot: approverSlot,
        recorded_as: recordEmail,
        consensus_reached: consensusReached,
        final_status: finalRequestStatus,
        approvals: { count: approvedCount, needed: approverEmails.length },
      },
    });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Get approval responses for a request
router.get('/approval-responses/:requestId', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    
    const result = await query(
      'SELECT id, email, status, responded_at, created_at FROM approval_responses WHERE request_id = $1',
      [requestId]
    );
    
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// ==================== END CONSENSUS APPROVAL ROUTES ====================

// Get requests ready for approval
router.get('/stock-requests', async (req: Request, res: Response) => {
  try {
    const requests = await stockService.getRequestsForApproval();
    res.json({ success: true, data: requests });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// ==================== DISTRIBUTION ROUTES ====================

// Distribute eSIMs
router.post('/distribute/esim', async (req: Request, res: Response) => {
  try {
    const { distributorId, mvnoId, iccids, purpose } = req.body;
    
    if (!distributorId || !mvnoId || !iccids || !iccids.length) {
      return fail(res, 400, 'distributorId, mvnoId, and iccids are required');
    }
    
    const result = await stockService.distributeESims(distributorId, mvnoId, iccids, purpose);
    res.json({ success: true, data: result });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Distribute Physical SIMs from single box
router.post('/distribute/physical/box', async (req: Request, res: Response) => {
  try {
    const { distributorId, boxId, quantity, purpose } = req.body;
    
    if (!distributorId || !boxId || !quantity) {
      return fail(res, 400, 'distributorId, boxId, and quantity are required');
    }
    
    const result = await stockService.distributePhysicalBox(distributorId, boxId, quantity, purpose);
    res.json({ success: true, data: result });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Distribute Physical SIMs from multiple boxes
router.post('/distribute/physical/boxes', async (req: Request, res: Response) => {
  try {
    const { distributorId, boxQuantities, purpose } = req.body;
    
    if (!distributorId || !boxQuantities || !boxQuantities.length) {
      return fail(res, 400, 'distributorId and boxQuantities are required');
    }
    
    const result = await stockService.distributePhysicalBoxes(distributorId, boxQuantities, purpose);
    res.json({ success: true, data: result });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// ==================== PICK HISTORY ROUTES ====================

// Get pick history
router.get('/pick-history', async (req: Request, res: Response) => {
  try {
    const { distributorId } = req.query;
    const history = await stockService.getPickHistory(distributorId as string);
    res.json({ success: true, data: history });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// ==================== AUDIT LOGS ROUTES ====================

// Get audit logs
router.get('/audit-logs', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.query;
    const logs = await stockService.getAuditLogs(requestId as string);
    res.json({ success: true, data: logs });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// ==================== REPORTS ROUTES ====================

// Get all reports
router.get('/reports', async (req: Request, res: Response) => {
  try {
    const reports = await stockService.getAllReports();
    res.json({ success: true, data: reports });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Structured Physical SIM distribution report — one row per box
// /physical-sims is a dedicated PDF-download alias: defaults to pdf output so no
// format/out param is needed in the URL (avoids ad blocker filter matches on 'pdf').
router.get(['/reports/physical', '/physical-sims'], async (req: Request, res: Response) => {
  try {
    const mvno_id = req.query.mvno_id ? String(req.query.mvno_id) : undefined;
    const distributor_id = (req.query.distributor_id || req.query.distributorId)
      ? String(req.query.distributor_id || req.query.distributorId) : undefined;
    const date_from = req.query.date_from ? String(req.query.date_from) : undefined;
    const date_to = req.query.date_to ? String(req.query.date_to) : undefined;
    const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit)), 50000) : 5000;
    const offset = req.query.offset ? parseInt(String(req.query.offset)) : 0;
    const isPdfAlias = req.path === '/physical-sims' || (req as any).route?.path === '/physical-sims';
    const format = (req.query.format || req.query.out)
      ? String(req.query.format || req.query.out).toLowerCase()
      : (isPdfAlias ? 'pdf' : 'json');

    const values: any[] = [];
    const where: string[] = [];
    const add = (sql: string, value: any) => {
      values.push(value);
      where.push(sql.replace('$?', `$${values.length}`));
    };
    if (mvno_id) add(`x.mvno_id = $?::uuid`, mvno_id);
    if (distributor_id) add(`x.distributor_id = $?::uuid`, distributor_id);
    if (date_from) add(`x.issued_at >= $?::timestamptz`, date_from);
    if (date_to) add(`x.issued_at <= $?::timestamptz`, date_to);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Uses the same CTE logic as getDistributionHistory (ghost-row filtering, deduplication)
    // but selects per-box rows instead of aggregated rows, so the report can render the
    // parent-child grouped structure correctly.
    const sql = `
      WITH mvno_box_totals AS (
        SELECT mvno_id, COUNT(*)::int AS total_boxes
        FROM boxes WHERE mvno_id IS NOT NULL GROUP BY mvno_id
      ),
      carton_order AS (
        SELECT c.id AS carton_id, c.mvno_id,
          COALESCE(NULLIF(regexp_replace(
            CASE WHEN POSITION('/' IN c.carton_number) > 0
                 THEN SPLIT_PART(c.carton_number, '/', 1)
                 ELSE c.carton_number END,
            '[^0-9]', '', 'g'), ''), '1')::int AS carton_seq
        FROM cartons c
      ),
      -- Ghost-row filter: same logic as getDistributionHistory
      ph_physical_base AS (
        SELECT
          COALESCE(ph.request_id, ph.manual_request_id)::text AS request_id,
          COALESCE(ph.distributor_id, sir.requester_id) AS distributor_id,
          COALESCE(d.name, 'Unknown')::text AS distributor_name,
          d.email::text AS distributor_email,
          COALESCE(ph.mvno_id, sir.mvno_id) AS mvno_id,
          COALESCE(ph.mvno_name::text, m.name::text, '')::text AS mvno_name,
          COALESCE(ph.distribution_type, 'APPROVED')::text AS distribution_type,
          ph.issued_by::text AS issued_by,
          COALESCE(ph.contact_person, d.contact_person, '')::text AS contact_person,
          ph.issued_at AS created_at,
          ph.distribution_id AS distribution_id,
          ph.assigned_boxes AS assigned_boxes
        FROM pick_history ph
        LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
        LEFT JOIN distributors d ON COALESCE(ph.distributor_id, sir.requester_id) = d.id
        LEFT JOIN mvnos m ON COALESCE(ph.mvno_id, sir.mvno_id) = m.id
        WHERE UPPER(
          CASE
            WHEN jsonb_typeof(COALESCE(ph.assigned_esims, '[]'::jsonb)) = 'array'
              AND jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)) > 0
              THEN 'ESIM'
            ELSE COALESCE(ph.sim_type::text, sir.sim_type::text, 'PHYSICAL')
          END
        ) = 'PHYSICAL'
        AND NOT (
          ph.manual_request_id IS NULL
          AND ph.pick_form_url IS NULL
          AND COALESCE(ph.issued_by, '') IN ('', 'System')
          AND (
            EXISTS (
              SELECT 1 FROM pick_history ph2
              WHERE ph2.manual_request_id IS NOT NULL
                AND ph2.distributor_id = ph.distributor_id
                AND ph2.assigned_boxes IS NOT NULL
                AND ph.assigned_boxes IS NOT NULL
                AND ph2.assigned_boxes::jsonb @> ph.assigned_boxes::jsonb
            )
            OR
            (
              ph.assigned_boxes IS NULL
              AND EXISTS (
                SELECT 1 FROM box_pick_records bpr2
                WHERE bpr2.distributor_id = ph.distributor_id
                  AND (
                    ph.distribution_id IS NOT NULL AND bpr2.distribution_id = ph.distribution_id
                    OR
                    ph.distribution_id IS NULL AND bpr2.distributor_id = ph.distributor_id
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM pick_history ph2
                    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ph2.assigned_boxes, '[]'::jsonb)) AS ab2(item)
                    WHERE ph2.manual_request_id IS NOT NULL
                      AND ph2.distributor_id = ph.distributor_id
                      AND (ab2.item->>'box_id')::uuid = bpr2.box_id
                  )
              )
            )
          )
        )
      ),
      ph_physical_rows AS (
        SELECT
          b.request_id, b.distributor_id, b.distributor_name, b.distributor_email,
          b.mvno_id, b.mvno_name, b.distribution_type, b.issued_by, b.contact_person,
          b.created_at, b.distribution_id,
          (ab.item->>'box_id')::uuid AS box_id,
          COALESCE((ab.item->>'quantity')::int, 0) AS box_quantity
        FROM ph_physical_base b
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.assigned_boxes, '[]'::jsonb)) AS ab(item)
      ),
      ph_physical_detail AS (
        SELECT
          r.request_id, r.distributor_id, r.distributor_name, r.distributor_email,
          r.mvno_id, r.mvno_name, r.distribution_type, r.issued_by, r.contact_person, r.created_at,
          c.carton_number::text AS carton_no,
          (((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(b.box_number, 0))::text
            || '/' || COALESCE(mbt.total_boxes::text, '0'))::text AS box_display,
          COALESCE(bpr.iccid_start, b.iccid_start)::text AS iccid_start,
          COALESCE(bpr.iccid_end, b.iccid_end)::text AS iccid_end,
          r.box_quantity::int AS quantity
        FROM ph_physical_rows r
        LEFT JOIN boxes b ON b.id = r.box_id
        LEFT JOIN cartons c ON b.carton_id = c.id
        LEFT JOIN carton_order co ON c.id = co.carton_id
        LEFT JOIN mvno_box_totals mbt ON COALESCE(b.mvno_id, c.mvno_id) = mbt.mvno_id
        LEFT JOIN box_pick_records bpr
          ON r.distribution_id IS NOT NULL
         AND bpr.distribution_id = r.distribution_id
         AND bpr.box_id = r.box_id
      ),
      bpr_only_detail AS (
        SELECT
          bpr.distribution_id::text AS request_id,
          bpr.distributor_id, COALESCE(d.name, 'Unknown')::text AS distributor_name,
          d.email::text AS distributor_email, c.mvno_id,
          COALESCE(m.name::text, '')::text AS mvno_name,
          c.carton_number::text AS carton_no,
          (((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(b.box_number, 0))::text
            || '/' || COALESCE(mbt.total_boxes::text, '0'))::text AS box_display,
          bpr.iccid_start::text AS iccid_start, bpr.iccid_end::text AS iccid_end,
          bpr.sims_picked::int AS quantity, bpr.picked_at AS created_at
        FROM box_pick_records bpr
        LEFT JOIN boxes b ON bpr.box_id = b.id
        LEFT JOIN cartons c ON b.carton_id = c.id
        LEFT JOIN carton_order co ON c.id = co.carton_id
        LEFT JOIN mvno_box_totals mbt ON COALESCE(b.mvno_id, c.mvno_id) = mbt.mvno_id
        LEFT JOIN mvnos m ON c.mvno_id = m.id
        LEFT JOIN distributors d ON bpr.distributor_id = d.id
        WHERE bpr.box_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pick_history ph WHERE ph.distribution_id = bpr.distribution_id)
          AND NOT EXISTS (
            SELECT 1 FROM pick_history ph2
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ph2.assigned_boxes, '[]'::jsonb)) AS ab(item)
            WHERE ph2.manual_request_id IS NOT NULL
              AND ph2.distributor_id = bpr.distributor_id
              AND (ab.item->>'box_id')::uuid = bpr.box_id
          )
      ),
      -- Combine both sources into flat per-box rows
      export_rows AS (
        SELECT
          request_id, distributor_id, distributor_name, distributor_email, mvno_id, mvno_name,
          carton_no, box_display AS box_number, iccid_start, iccid_end,
          quantity AS sims_in_box, issued_by, contact_person,
          distribution_type AS purpose, created_at AS issued_at
        FROM ph_physical_detail
        UNION ALL
        SELECT
          request_id, distributor_id, distributor_name, distributor_email, mvno_id, mvno_name,
          carton_no, box_display AS box_number, iccid_start, iccid_end,
          quantity AS sims_in_box,
          'System'::text AS issued_by, NULL::text AS contact_person,
          'DISTRIBUTED'::text AS purpose, created_at AS issued_at
        FROM bpr_only_detail
      ),
      export_with_total AS (
        SELECT
          request_id,
          CASE
            WHEN UPPER(COALESCE(purpose, '')) = 'MANUAL'
            THEN TO_CHAR(issued_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD')
            ELSE TO_CHAR(issued_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD HH24:MI:SS')
          END AS distribution_date,
          distributor_name, COALESCE(distributor_email, '') AS distributor_email,
          COALESCE(contact_person, '') AS contact_person,
          mvno_id, mvno_name, distributor_id,
          COALESCE(carton_no, '') AS carton_number,
          box_number, sims_in_box, iccid_start, iccid_end,
          COALESCE(issued_by, '') AS issued_by,
          COALESCE(purpose, '') AS purpose,
          issued_at,
          SUM(sims_in_box) OVER (PARTITION BY request_id) AS total_sims_in_request
        FROM export_rows
      )
      SELECT * FROM export_with_total x
      ${whereSql}
      ORDER BY x.issued_at DESC, x.box_number ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const result = await query(sql, values);
    const rows = result.rows.map((r: any) => ({
      request_id: r.request_id ? String(r.request_id) : '',
      distribution_date: r.distribution_date || '',
      distributor_name: r.distributor_name ? String(r.distributor_name) : '',
      distributor_email: r.distributor_email ? String(r.distributor_email) : '',
      contact_person: r.contact_person ? String(r.contact_person) : '',
      mvno_name: r.mvno_name ? String(r.mvno_name) : '',
      carton_number: r.carton_number ? String(r.carton_number) : '',
      box_number: r.box_number ? String(r.box_number) : '',
      sims_in_box: Number(r.sims_in_box) || 0,
      total_sims_in_request: Number(r.total_sims_in_request) || 0,
      iccid_start: r.iccid_start ? String(r.iccid_start) : '',
      iccid_end: r.iccid_end ? String(r.iccid_end) : '',
      issued_by: r.issued_by ? String(r.issued_by) : '',
      purpose: r.purpose ? String(r.purpose) : '',
    }));

    if (format === 'csv') {
      // Column order matches the sample report layout exactly.
      // Distributor Name and Email are combined into one column.
      // Request-level fields shown only on first row of each group; box-level on every row.
      const headers = [
        'Request ID',
        'Distribution Date',
        'Distributor Name (Email)',
        'Contact Person',
        'MVNO',
        'Carton Number',
        'Total SIMs (Per Request)',
        'Issued By',
        'Purpose',
        'Box Number',
        'SIMs Per Box',
        'ICCID Start (Inclusive)',
        'ICCID End (Inclusive)',
      ];
      const esc = (v: any) => {
        const s = v === null || v === undefined ? '' : String(v);
        if (/^[0-9]{10,}$/.test(s)) return `="${s}"`;
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        if (/^\d+\/\d+$/.test(s)) return `="${s}"`;
        if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      // Group by distributor + minute-truncated date + mvno to merge same-event picks
      const csvTruncMin = (d: any) => String(d ?? '').slice(0, 16);
      const csvMakeKey = (r: any) => `${r.distributor_name}|${csvTruncMin(r.distribution_date)}|${r.mvno_name}`;
      const csvGroups: Array<{ key: string; rows: typeof rows }> = [];
      let csvCurGrp: typeof csvGroups[0] | null = null;
      for (const r of rows) {
        const k = csvMakeKey(r);
        if (!csvCurGrp || csvCurGrp.key !== k) { csvCurGrp = { key: k, rows: [r] }; csvGroups.push(csvCurGrp); }
        else csvCurGrp.rows.push(r);
      }
      const csvRows: string[] = [];
      for (const grp of csvGroups) {
        const groupTotal = grp.rows.reduce((s: number, r: any) => s + (Number(r.sims_in_box) || 0), 0);
        const reqIds = [...new Set(grp.rows.map((r: any) => r.request_id).filter(Boolean))].join('; ');
        grp.rows.forEach((r: any, i: number) => {
          const distNameEmail = r.distributor_email ? `${r.distributor_name} (${r.distributor_email})` : r.distributor_name;
          csvRows.push([
            i === 0 ? (reqIds || r.request_id) : '',
            i === 0 ? r.distribution_date : '',
            i === 0 ? distNameEmail : '',
            i === 0 ? r.contact_person : '',
            i === 0 ? r.mvno_name : '',
            i === 0 ? r.carton_number : '',
            i === 0 ? groupTotal : '',
            i === 0 ? r.issued_by : '',
            i === 0 ? r.purpose : '',
            r.box_number,
            r.sims_in_box,
            r.iccid_start,
            r.iccid_end,
          ].map(esc).join(','));
        });
      }
      const csv = [headers.join(','), ...csvRows].join('\n');
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="physical_sim_report_${stamp}.csv"`);
      return res.status(200).send(csv);
    }

    if (format === 'excel') {
      // Group by distributor + minute-truncated date + mvno to merge same-event picks
      const truncMin = (d: any) => String(d ?? '').slice(0, 16);
      const makeKey = (r: any) => `${r.distributor_name}|${truncMin(r.distribution_date)}|${r.mvno_name}`;
      const groups: Array<{ key: string; rows: typeof rows }> = [];
      let curGroup: typeof groups[0] | null = null;
      for (const r of rows) {
        const k = makeKey(r);
        if (!curGroup || curGroup.key !== k) {
          curGroup = { key: k, rows: [r] };
          groups.push(curGroup);
        } else {
          curGroup.rows.push(r);
        }
      }

      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Physical SIM Report');

      sheet.columns = [
        { key: 'request_id',          width: 22 },
        { key: 'distribution_date',   width: 18 },
        { key: 'distributor_name',    width: 22 },
        { key: 'contact_person',      width: 18 },
        { key: 'mvno_name',           width: 14 },
        { key: 'carton_number',       width: 14 },
        { key: 'total_sims',          width: 14 },
        { key: 'issued_by',           width: 14 },
        { key: 'purpose',             width: 14 },
        { key: 'box_number',          width: 12 },
        { key: 'sims_in_box',         width: 12 },
        { key: 'iccid_start',         width: 24 },
        { key: 'iccid_end',           width: 24 },
      ];

      const HDR_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF1B5E45' } };
      const PAR_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFF8FAFC' } };
      const CHD_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFFFFFF' } };
      const HDR_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      const THIN_BORDER = (color = 'FFD1D5DB') => ({ style: 'thin' as const, color: { argb: color } });
      const cellBorder = (top = 'FFD1D5DB') => ({
        top: THIN_BORDER(top), bottom: THIN_BORDER(), left: THIN_BORDER(), right: THIN_BORDER(),
      });

      const headers = [
        'Request ID', 'Distribution Date', 'Distributor Name', 'Contact Person',
        'MVNO', 'Carton Number', 'Total SIMs\n(Per Request)', 'Issued By', 'Purpose',
        'Box Number', 'SIMs Per Box', 'ICCID Start', 'ICCID End',
      ];
      const hdrRow = sheet.addRow(headers);
      hdrRow.height = 32;
      hdrRow.eachCell(cell => {
        cell.font = HDR_FONT;
        cell.fill = HDR_FILL;
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = cellBorder('FF1B5E45');
      });

      let rowIdx = 2;
      for (const group of groups) {
        const span = group.rows.length;
        for (let i = 0; i < group.rows.length; i++) {
          const r = group.rows[i];
          const exRow = sheet.getRow(rowIdx + i);
          exRow.height = 18;

          if (i === 0) {
            const groupTotal = group.rows.reduce((s: number, gr: any) => s + (Number(gr.sims_in_box) || 0), 0);
            const reqIds = [...new Set(group.rows.map((gr: any) => gr.request_id).filter(Boolean))].join('\n');
            exRow.getCell(1).value = reqIds || r.request_id;
            exRow.getCell(2).value = r.distribution_date;
            exRow.getCell(3).value = r.distributor_name;
            exRow.getCell(4).value = r.contact_person;
            exRow.getCell(5).value = r.mvno_name;
            exRow.getCell(6).value = r.carton_number;
            exRow.getCell(7).value = groupTotal;
            exRow.getCell(8).value = r.issued_by;
            exRow.getCell(9).value = r.purpose;
          }
          exRow.getCell(10).value = r.box_number;
          exRow.getCell(11).value = r.sims_in_box;
          exRow.getCell(12).value = r.iccid_start;
          exRow.getCell(13).value = r.iccid_end;

          const topColor = i === 0 ? 'FF1B5E45' : 'FFD1D5DB';
          for (let c = 1; c <= 13; c++) {
            const cell = exRow.getCell(c);
            cell.fill = c <= 9 ? PAR_FILL : CHD_FILL;
            cell.border = cellBorder(topColor);
            cell.alignment = { vertical: 'middle', wrapText: false };
            if (c >= 12) { cell.numFmt = '@'; }
          }
          exRow.commit();
        }

        if (span > 1) {
          for (let c = 1; c <= 9; c++) {
            sheet.mergeCells(rowIdx, c, rowIdx + span - 1, c);
            const cell = sheet.getCell(rowIdx, c);
            cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
          }
        }
        rowIdx += span;
      }

      sheet.getColumn(12).numFmt = '@';
      sheet.getColumn(13).numFmt = '@';

      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const xlsxBuffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="physical_sim_report_${stamp}.xlsx"`);
      return res.status(200).send(Buffer.from(xlsxBuffer as ArrayBuffer));
    }

    if (format === 'pdf') {
      // Group by distributor + minute-truncated date + mvno to merge same-event picks
      const pdfTruncMin = (d: any) => String(d ?? '').slice(0, 16);
      const pdfMakeKey = (r: any) => `${r.distributor_name}|${pdfTruncMin(r.distribution_date)}|${r.mvno_name}`;
      const groups: Array<{ key: string; rows: typeof rows }> = [];
      let curGroup: typeof groups[0] | null = null;
      for (const r of rows) {
        const k = pdfMakeKey(r);
        if (!curGroup || curGroup.key !== k) {
          curGroup = { key: k, rows: [r] };
          groups.push(curGroup);
        } else {
          curGroup.rows.push(r);
        }
      }
      const escH = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const nowStr = new Date().toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).replace(',', '');

      // Build table rows — parent fields rowspan, child fields per row
      let tbodyHtml = '';
      for (const group of groups) {
        const span = group.rows.length;
        for (let i = 0; i < group.rows.length; i++) {
          const r = group.rows[i];
          tbodyHtml += `<tr class="${i === 0 ? 'grp-first' : 'grp-rest'}">`;
          if (i === 0) {
            const groupTotal = group.rows.reduce((s: number, gr: any) => s + (Number(gr.sims_in_box) || 0), 0);
            const reqIdList = [...new Set(group.rows.map((gr: any) => gr.request_id).filter(Boolean))];
            const reqIdHtml = reqIdList.length === 1
              ? escH(reqIdList[0])
              : reqIdList.map((id: string) => escH(id)).join('<br>');
            tbodyHtml += `<td rowspan="${span}" class="pc mono" style="font-size:6pt;line-height:1.4">${reqIdHtml}</td>`;
            tbodyHtml += `<td rowspan="${span}" class="pc">${escH(r.distribution_date)}</td>`;
            tbodyHtml += `<td rowspan="${span}" class="pc">${escH(r.distributor_name)}</td>`;
            tbodyHtml += `<td rowspan="${span}" class="pc">${escH(r.contact_person)}</td>`;
            tbodyHtml += `<td rowspan="${span}" class="pc">${escH(r.mvno_name)}</td>`;
            tbodyHtml += `<td rowspan="${span}" class="pc">${escH(r.carton_number)}</td>`;
            tbodyHtml += `<td rowspan="${span}" class="pc num">${groupTotal.toLocaleString()}</td>`;
            tbodyHtml += `<td rowspan="${span}" class="pc">${escH(r.issued_by)}</td>`;
            tbodyHtml += `<td rowspan="${span}" class="pc">${escH(r.purpose)}</td>`;
          }
          tbodyHtml += `<td class="cc">${escH(r.box_number)}</td>`;
          tbodyHtml += `<td class="cc num">${r.sims_in_box.toLocaleString()}</td>`;
          tbodyHtml += `<td class="cc mono">${escH(r.iccid_start)}</td>`;
          tbodyHtml += `<td class="cc mono">${escH(r.iccid_end)}</td>`;
          tbodyHtml += `</tr>`;
        }
      }

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 8pt; color: #1a1a1a; background: #fff; padding: 14px 16px; }
  .page-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 2px solid #1B5E45; }
  .logo-block { display: flex; align-items: center; gap: 8px; min-width: 160px; }
  .logo-circle { width: 42px; height: 42px; border-radius: 50%; border: 3px solid #1B5E45; display: flex; align-items: center; justify-content: center; font-size: 17pt; font-weight: 900; color: #1B5E45; flex-shrink: 0; }
  .company-name { font-size: 11pt; font-weight: 800; color: #1B5E45; line-height: 1.2; }
  .company-tag { font-size: 6.5pt; color: #64748b; font-style: italic; }
  .page-title { flex: 1; text-align: center; }
  .page-title h1 { font-size: 13pt; font-weight: 900; letter-spacing: 0.04em; color: #111; }
  .page-meta { text-align: right; font-size: 7.5pt; color: #333; line-height: 1.8; min-width: 160px; }
  .page-meta .lbl { color: #555; }
  table { width: 100%; border-collapse: collapse; font-size: 7.5pt; margin-top: 6px; }
  thead th { background: #1B5E45; color: #fff; padding: 6px 5px; text-align: center;
             font-size: 7.5pt; font-weight: 700; border: 1px solid #144d37;
             vertical-align: middle; line-height: 1.3; }
  .grp-first td { border-top: 2px solid #1B5E45; }
  td { border: 1px solid #d1d5db; padding: 4px 5px; vertical-align: middle; }
  .pc { background: #f8fafc; text-align: left; }
  .cc { background: #fff; text-align: left; }
  .num { text-align: center; }
  .mono { font-family: 'Courier New', monospace; font-size: 7pt; }
</style>
</head><body>
<div class="page-top">
  <div class="logo-block">
    <div class="logo-circle">H</div>
    <div>
      <div class="company-name">Hamilton<br>Telecom</div>
      <div class="company-tag">Enabling Digital Transformation</div>
    </div>
  </div>
  <div class="page-title">
    <h1>PHYSICAL SIM DISTRIBUTION REPORT</h1>
  </div>
  <div class="page-meta">
    <span class="lbl">Generated On:</span> ${escH(nowStr)}<br>
    <span class="lbl">Generated By:</span> System
  </div>
</div>
<table>
  <thead>
    <tr>
      <th style="width:70px">Request ID</th>
      <th style="width:68px">Distribution Date</th>
      <th style="width:90px">Distributor Name</th>
      <th style="width:68px">Contact Person</th>
      <th style="width:46px">MVNO</th>
      <th style="width:52px">Carton Number</th>
      <th style="width:52px">Total SIMs (Per Request)</th>
      <th style="width:54px">Issued By</th>
      <th style="width:52px">Purpose</th>
      <th style="width:46px">Box Number</th>
      <th style="width:44px">SIMs Per Box</th>
      <th>ICCID Start</th>
      <th>ICCID End</th>
    </tr>
  </thead>
  <tbody>${tbodyHtml}</tbody>
</table>
</body></html>`;

      // Render PDF via Puppeteer
      const puppeteer = await import('puppeteer');
      const browser = await puppeteer.default.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', landscape: true, printBackground: true, margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' } });
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="physical_sim_report_${stamp}.pdf"`);
        return res.status(200).send(Buffer.from(pdfBuffer));
      } finally {
        await browser.close();
      }
    }

    res.json({ success: true, data: rows, total: rows.length });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// eSIM distribution report — Excel and PDF exports
// /esim-dists is the PDF-only alias (no 'pdf' keyword in URL to avoid ad blockers)
router.get(['/reports/esim', '/esim-dists'], async (req: Request, res: Response) => {
  try {
    const mvno_id = req.query.mvno_id ? String(req.query.mvno_id) : undefined;
    const distributor_id = (req.query.distributor_id || req.query.distributorId)
      ? String(req.query.distributor_id || req.query.distributorId) : undefined;
    const date_from = req.query.date_from ? String(req.query.date_from) : undefined;
    const date_to   = req.query.date_to   ? String(req.query.date_to)   : undefined;
    const limit  = req.query.limit  ? Math.min(parseInt(String(req.query.limit)), 50000) : 5000;
    const offset = req.query.offset ? parseInt(String(req.query.offset)) : 0;
    const isPdfAlias = req.path === '/esim-dists' || (req as any).route?.path === '/esim-dists';
    const format = (req.query.format || req.query.out)
      ? String(req.query.format || req.query.out).toLowerCase()
      : (isPdfAlias ? 'pdf' : 'json');

    const values: any[] = [];
    const where: string[] = [];
    const add = (sql: string, value: any) => {
      values.push(value);
      where.push(sql.replace('$?', `$${values.length}`));
    };
    if (mvno_id)       add(`x.mvno_id = $?::uuid`, mvno_id);
    if (distributor_id) add(`x.distributor_id = $?::uuid`, distributor_id);
    if (date_from)     add(`x.issued_at >= $?::timestamptz`, date_from);
    if (date_to)       add(`x.issued_at <= $?::timestamptz`, date_to);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      WITH esim_rows AS (
        SELECT
          COALESCE(ph.request_id, ph.manual_request_id)::text AS request_id,
          CASE
            WHEN UPPER(COALESCE(ph.distribution_type, '')) = 'MANUAL'
            THEN TO_CHAR(ph.issued_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD')
            ELSE TO_CHAR(ph.issued_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD HH24:MI:SS')
          END AS distribution_date,
          COALESCE(d.name, 'Unknown')::text AS distributor_name,
          COALESCE(d.email, '')::text AS distributor_email,
          COALESCE(ph.contact_person, d.contact_person, '')::text AS contact_person,
          ph.mvno_id,
          COALESCE(ph.mvno_name::text, m.name::text, '')::text AS mvno_name,
          COALESCE(ph.distributor_id, sir.requester_id) AS distributor_id,
          COALESCE(ph.quantity,
            jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)))::int AS quantity,
          (SELECT string_agg(es.val, E'\n' ORDER BY es.val)
           FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(val)
          )::text AS iccid_list,
          COALESCE(ph.issued_by, '')::text AS issued_by,
          COALESCE(ph.distribution_type, 'APPROVED')::text AS purpose,
          ph.issued_at
        FROM pick_history ph
        LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
        LEFT JOIN distributors d ON COALESCE(ph.distributor_id, sir.requester_id) = d.id
        LEFT JOIN mvnos m ON ph.mvno_id = m.id
        WHERE UPPER(
          CASE
            WHEN jsonb_typeof(COALESCE(ph.assigned_esims, '[]'::jsonb)) = 'array'
              AND jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)) > 0
              THEN 'ESIM'
            ELSE COALESCE(ph.sim_type::text, sir.sim_type::text, 'PHYSICAL')
          END
        ) = 'ESIM'
      )
      SELECT * FROM esim_rows x
      ${whereSql}
      ORDER BY x.issued_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const result = await query(sql, values);
    const rows = result.rows.map((r: any) => ({
      request_id:        r.request_id        ? String(r.request_id)        : '',
      distribution_date: r.distribution_date ? String(r.distribution_date) : '',
      distributor_name:  r.distributor_name  ? String(r.distributor_name)  : '',
      distributor_email: r.distributor_email ? String(r.distributor_email) : '',
      contact_person:    r.contact_person    ? String(r.contact_person)    : '',
      mvno_name:         r.mvno_name         ? String(r.mvno_name)         : '',
      quantity:          Number(r.quantity)  || 0,
      iccid_list:        r.iccid_list        ? String(r.iccid_list)        : '',
      issued_by:         r.issued_by         ? String(r.issued_by)         : '',
      purpose:           r.purpose           ? String(r.purpose)           : '',
    }));

    if (format === 'json') return res.json({ success: true, data: rows });

    if (format === 'excel') {
      const ExcelJS = (await import('exceljs')).default;
      const workbook  = new ExcelJS.Workbook();
      const sheet     = workbook.addWorksheet('eSIM Report');

      sheet.columns = [
        { key: 'request_id',        width: 22 },
        { key: 'distribution_date', width: 20 },
        { key: 'distributor_name',  width: 24 },
        { key: 'contact_person',    width: 18 },
        { key: 'mvno_name',         width: 14 },
        { key: 'quantity',          width: 12 },
        { key: 'iccid_list',        width: 32 },
        { key: 'issued_by',         width: 18 },
        { key: 'purpose',           width: 14 },
      ];

      const HDR_FILL: any = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B5E45' } };
      const ROW_FILL: any = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      const hdrBorder: any = {
        top: { style: 'thin', color: { argb: 'FF144D37' } },
        bottom: { style: 'thin', color: { argb: 'FF144D37' } },
        left:  { style: 'thin', color: { argb: 'FF144D37' } },
        right: { style: 'thin', color: { argb: 'FF144D37' } },
      };
      const cellBorder = (top: string): any => ({
        top:    { style: 'thin', color: { argb: top } },
        bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        left:   { style: 'thin', color: { argb: 'FFD1D5DB' } },
        right:  { style: 'thin', color: { argb: 'FFD1D5DB' } },
      });

      // Title row
      sheet.mergeCells(1, 1, 1, 9);
      const titleCell = sheet.getCell(1, 1);
      titleCell.value = 'eSIM DISTRIBUTION REPORT';
      titleCell.font  = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
      titleCell.fill  = HDR_FILL;
      titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
      sheet.getRow(1).height = 22;

      // Header row
      const headers = [
        'Request ID', 'Distribution Date', 'Distributor Name', 'Contact Person',
        'MVNO', 'Total eSIMs', 'ICCIDs Distributed', 'Issued By', 'Purpose',
      ];
      const hdrRow = sheet.getRow(2);
      hdrRow.height = 20;
      headers.forEach((h, ci) => {
        const cell = hdrRow.getCell(ci + 1);
        cell.value = h;
        cell.font  = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
        cell.fill  = HDR_FILL;
        cell.border = hdrBorder;
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      });
      hdrRow.commit();

      rows.forEach((r, idx) => {
        const iccids = r.iccid_list ? r.iccid_list.split('\n') : [];
        const rowHeight = Math.max(16, Math.min(iccids.length * 12, 300));
        const exRow = sheet.getRow(idx + 3);
        exRow.height = rowHeight;
        const vals = [
          r.request_id, r.distribution_date, r.distributor_name, r.contact_person,
          r.mvno_name, r.quantity, r.iccid_list, r.issued_by, r.purpose,
        ];
        vals.forEach((v, ci) => {
          const cell = exRow.getCell(ci + 1);
          cell.value = v;
          cell.fill  = ROW_FILL;
          cell.border = cellBorder('FFD1D5DB');
          cell.alignment = { vertical: 'top', wrapText: ci === 6 };
          if (ci === 6) cell.numFmt = '@';
        });
        exRow.commit();
      });

      sheet.getColumn(7).numFmt = '@';

      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const xlsxBuffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="esim_report_${stamp}.xlsx"`);
      return res.status(200).send(Buffer.from(xlsxBuffer as ArrayBuffer));
    }

    if (format === 'pdf') {
      const escH = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const nowStr = new Date().toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).replace(',', '');

      let tbodyHtml = '';
      rows.forEach((r) => {
        const iccidHtml = r.iccid_list
          ? r.iccid_list.split('\n').map((ic) => escH(ic)).join('<br>')
          : '';
        tbodyHtml += `<tr>`;
        tbodyHtml += `<td class="mono" style="font-size:6pt">${escH(r.request_id)}</td>`;
        tbodyHtml += `<td>${escH(r.distribution_date)}</td>`;
        tbodyHtml += `<td>${escH(r.distributor_name)}</td>`;
        tbodyHtml += `<td>${escH(r.contact_person)}</td>`;
        tbodyHtml += `<td>${escH(r.mvno_name)}</td>`;
        tbodyHtml += `<td class="num">${r.quantity.toLocaleString()}</td>`;
        tbodyHtml += `<td class="mono iccid-cell">${iccidHtml}</td>`;
        tbodyHtml += `<td>${escH(r.issued_by)}</td>`;
        tbodyHtml += `<td>${escH(r.purpose)}</td>`;
        tbodyHtml += `</tr>`;
      });

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 8pt; color: #1a1a1a; background: #fff; padding: 14px 16px; }
  .page-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 2px solid #1B5E45; }
  .logo-block { display: flex; align-items: center; gap: 8px; min-width: 160px; }
  .logo-circle { width: 42px; height: 42px; border-radius: 50%; border: 3px solid #1B5E45; display: flex; align-items: center; justify-content: center; font-size: 17pt; font-weight: 900; color: #1B5E45; flex-shrink: 0; }
  .company-name { font-size: 11pt; font-weight: 800; color: #1B5E45; line-height: 1.2; }
  .company-tag  { font-size: 6.5pt; color: #64748b; font-style: italic; }
  .page-title { flex: 1; text-align: center; }
  .page-title h1 { font-size: 13pt; font-weight: 900; letter-spacing: 0.04em; color: #111; }
  .page-meta { text-align: right; font-size: 7.5pt; color: #333; line-height: 1.8; min-width: 160px; }
  .page-meta .lbl { color: #555; }
  table { width: 100%; border-collapse: collapse; font-size: 7.5pt; margin-top: 6px; }
  thead th { background: #1B5E45; color: #fff; padding: 6px 5px; text-align: center;
             font-size: 7.5pt; font-weight: 700; border: 1px solid #144d37;
             vertical-align: middle; line-height: 1.3; }
  tr:nth-child(even) td { background: #f8fafc; }
  tr:nth-child(odd)  td { background: #fff; }
  td { border: 1px solid #d1d5db; padding: 4px 5px; vertical-align: middle; }
  .num  { text-align: center; }
  .mono { font-family: 'Courier New', monospace; font-size: 7pt; }
  .iccid-cell { line-height: 1.6; vertical-align: top; }
</style>
</head><body>
<div class="page-top">
  <div class="logo-block">
    <div class="logo-circle">H</div>
    <div>
      <div class="company-name">Hamilton<br>Telecom</div>
      <div class="company-tag">Enabling Digital Transformation</div>
    </div>
  </div>
  <div class="page-title">
    <h1>eSIM DISTRIBUTION REPORT</h1>
  </div>
  <div class="page-meta">
    <span class="lbl">Generated On:</span> ${escH(nowStr)}<br>
    <span class="lbl">Generated By:</span> System
  </div>
</div>
<table>
  <thead>
    <tr>
      <th>Request ID</th>
      <th>Distribution Date</th>
      <th>Distributor Name</th>
      <th>Contact Person</th>
      <th>MVNO</th>
      <th>Total eSIMs</th>
      <th>ICCIDs Distributed</th>
      <th>Issued By</th>
      <th>Purpose</th>
    </tr>
  </thead>
  <tbody>${tbodyHtml}</tbody>
</table>
</body></html>`;

      const puppeteer = (await import('puppeteer')).default;
      const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', landscape: true, printBackground: true, margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' } });
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="esim_report_${stamp}.pdf"`);
        return res.status(200).send(Buffer.from(pdfBuffer));
      } finally {
        await browser.close();
      }
    }

    return res.status(400).json({ success: false, error: 'Invalid format. Use excel or pdf.' });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// Get report by request ID
router.get('/reports/:requestId', async (req: Request, res: Response) => {
  try {
    const reports = await stockService.getReportsByRequestId(req.params.requestId as string);
    res.json({ success: true, data: reports });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// One-time migration: backfill box_pick_records for legacy manual provisioning records
router.post('/reports/backfill-iccid-ranges', async (req: Request, res: Response) => {
  try {
    // Find pick_history records with distribution_id IS NULL that have assigned_boxes
    const legacyResult = await query(`
      SELECT ph.id, ph.manual_request_id, ph.distributor_id, ph.assigned_boxes, ph.issued_at
      FROM pick_history ph
      WHERE ph.distribution_id IS NULL
        AND UPPER(COALESCE(ph.sim_type, 'PHYSICAL')) = 'PHYSICAL'
        AND jsonb_array_length(COALESCE(ph.assigned_boxes, '[]'::jsonb)) > 0
      ORDER BY ph.issued_at ASC
    `);

    if (!legacyResult.rows.length) {
      return res.json({ success: true, message: 'No legacy records to backfill', count: 0 });
    }

    // Group distributions by box_id in chronological order to calculate ICCID offsets
    // First, collect all distributions per box across all legacy records
    const boxDistributions: Map<string, Array<{ ph_id: string; quantity: number; distributor_id: string; issued_at: string }>> = new Map();

    for (const ph of legacyResult.rows) {
      const boxes = Array.isArray(ph.assigned_boxes) ? ph.assigned_boxes : [];
      for (const box of boxes) {
        const boxId = box.box_id;
        const qty = Number(box.quantity || 0);
        if (!boxId || qty <= 0) continue;
        if (!boxDistributions.has(boxId)) boxDistributions.set(boxId, []);
        boxDistributions.get(boxId)!.push({
          ph_id: ph.id,
          quantity: qty,
          distributor_id: ph.distributor_id,
          issued_at: ph.issued_at,
        });
      }
    }

    // For each box, get iccid_start and process distributions in order
    let totalFixed = 0;
    for (const [boxId, distributions] of boxDistributions.entries()) {
      // Check if box_pick_records already exist for this box (from approved flow)
      const existingBpr = await query(
        `SELECT SUM(COALESCE(sims_picked, quantity, 0))::int AS total_picked FROM box_pick_records WHERE box_id = $1`,
        [boxId]
      );
      const alreadyPickedViaBpr = Number(existingBpr.rows[0]?.total_picked || 0);

      // Get box's base ICCID
      const boxResult = await query(`SELECT iccid_start, LENGTH(iccid_start) AS iccid_len FROM boxes WHERE id = $1`, [boxId]);
      if (!boxResult.rows.length || !boxResult.rows[0].iccid_start) continue;
      const baseIccid = boxResult.rows[0].iccid_start;
      const iccidLen = Number(boxResult.rows[0].iccid_len);

      // Sort distributions chronologically
      distributions.sort((a, b) => new Date(a.issued_at).getTime() - new Date(b.issued_at).getTime());

      // Calculate ICCID offset starting after any already-existing box_pick_records
      let offset = BigInt(alreadyPickedViaBpr);

      for (const dist of distributions) {
        const distId = (await query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
        const rangeStart = (BigInt(baseIccid) + offset).toString().padStart(iccidLen, '0');
        const rangeEnd = (BigInt(baseIccid) + offset + BigInt(dist.quantity) - 1n).toString().padStart(iccidLen, '0');

        // Insert box_pick_records
        await query(
          `INSERT INTO box_pick_records (box_id, distributor_id, quantity, sims_picked, iccid_start, iccid_end, distribution_id, picked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [boxId, dist.distributor_id, dist.quantity, dist.quantity, rangeStart, rangeEnd, distId, dist.issued_at]
        );

        // Update pick_history with the distribution_id
        await query(
          `UPDATE pick_history SET distribution_id = $1 WHERE id = $2 AND distribution_id IS NULL`,
          [distId, dist.ph_id]
        );

        offset += BigInt(dist.quantity);
        totalFixed++;
      }
    }

    res.json({ success: true, message: `Backfilled ${totalFixed} box_pick_records`, count: totalFixed });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// ==================== APPROVER CONFIG ROUTES ====================

// Get all approvers
router.get('/approvers', async (req: Request, res: Response) => {
  try {
    const approvers = await stockService.getAllApprovers();
    res.json({ success: true, data: approvers });
  } catch (error: any) {
    fail(res, 500, error.message);
  }
});

// ==================== LOGGING ROUTES ====================

// Receive frontend logs
router.post('/logs/frontend', async (req: Request, res: Response) => {
  try {
    const { level, message, page, user, trace_id, user_agent } = req.body;
    const traceId = String(res.locals?.traceId || trace_id || 'n/a');
    const userAgent = String(user_agent || req.headers['user-agent'] || 'unknown');
    logFrontendActivity(
      level,
      page,
      `[trace:${traceId}] ${String(message || '')} ua="${userAgent}"`,
      user ? String(user) : undefined
    );
    const mirrorLine = `${formatLogTimestamp(new Date())} [${toLevel(level)}] FRONTEND [trace:${traceId}] ${String(page || 'unknown')}: ${String(message || '')}`;
    console.log(mirrorLine);

    res.json({ success: true, trace_id: traceId });
  } catch (error: any) {
    const traceId = String(res.locals?.traceId || 'n/a');
    console.error('Failed to log frontend activity:', error);
    appendUnifiedLog(`${formatLogTimestamp(new Date())} [ERR] FRONTEND_LOGGING [trace:${traceId}] Failed to persist frontend log: ${String(error?.message || error)}`);
    res.status(500).json({ success: false, error: error.message, trace_id: traceId });
  }
});

// List frontend log files with timestamp/size metadata (similar to `ls -l`)
router.get('/logs/frontend/files', async (req: Request, res: Response) => {
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
      return ok(res, { total_blocks: 0, total_bytes: 0, files: [] });
    }

    const fileNames = fs
      .readdirSync(logsDir)
      .filter((name) => name.startsWith('Hamilton-log-') && (name.endsWith('.txt') || name.endsWith('.log')));

    const files = fileNames.map((name) => {
      const filePath = path.join(logsDir, name);
      const stat = fs.statSync(filePath);
      const modified = stat.mtime;
      return {
        name,
        size: stat.size,
        modified_at: modified.toISOString(),
        ls_timestamp: formatLsTimestamp(modified),
        display_line: `-rw-r--r-- 1 root root ${String(stat.size).padStart(9, ' ')} ${formatLsTimestamp(modified)} ${name}`,
      };
    });

    files.sort((a, b) => (a.modified_at < b.modified_at ? 1 : -1));

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const totalBlocks = Math.ceil(totalBytes / 1024);

    return ok(res, {
      total_blocks: totalBlocks,
      total_bytes: totalBytes,
      files,
    });
  } catch (error: any) {
    return fail(res, 500, error.message || 'Failed to list frontend logs');
  }
});

// Health check
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== DISTRIBUTOR SELF-SERVICE PORTAL ====================

/**
 * Extract the verified JWT payload from a Bearer Authorization header.
 * Returns null if missing or invalid — callers decide whether to reject.
 */
function getJwtPayload(req: Request): Record<string, any> | null {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  try { return verifyJwt(auth.slice(7)); } catch { return null; }
}

/**
 * Resolve a distributor record for a portal user.
 * Priority: platform_user_id match → email match.
 * Returns null (not 404) so callers can return a friendly not-linked response.
 */
async function resolveDistributor(userId: string | null, email: string): Promise<any | null> {
  // 1. Try platform_user_id first (reliable, set by the link migration)
  if (userId) {
    const r = await query(
      `SELECT d.*, m.name AS mvno_name
         FROM distributors d
         LEFT JOIN mvnos m ON m.id = d.mvno_id
        WHERE d.platform_user_id = $1 AND d.is_active = true
        LIMIT 1`,
      [userId],
    );
    if (r.rows[0]) return r.rows[0];
  }
  // 2. Fallback: email match (covers distributors linked by email before migration)
  if (email) {
    const r = await query(
      `SELECT d.*, m.name AS mvno_name
         FROM distributors d
         LEFT JOIN mvnos m ON m.id = d.mvno_id
        WHERE LOWER(d.email) = LOWER($1) AND d.is_active = true
        LIMIT 1`,
      [email],
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

/** Require a valid JWT; return 401 if missing/invalid */
function requireJwt(req: Request, res: Response): Record<string, any> | null {
  const payload = getJwtPayload(req);
  if (!payload) { fail(res, 401, 'Authentication required — please log in'); return null; }
  return payload;
}

// GET /api/distributor-portal/me  — fetch own distributor record
router.get('/distributor-portal/me', async (req: Request, res: Response) => {
  try {
    const jwt = requireJwt(req, res);
    if (!jwt) return;
    const dist = await resolveDistributor(jwt.id, jwt.email);
    if (!dist) {
      // Not an error — user is authenticated but has no linked distributor record yet
      return ok(res, { distributor: null, not_linked: true,
        message: 'Your account is not yet linked to a distributor record. Please contact your MVNO admin.' });
    }
    const userRow = await stockService.getPlatformUserByEmail(jwt.email);
    return ok(res, { distributor: dist, platform_user: userRow, not_linked: false });
  } catch (e: any) { return fail(res, 500, e.message); }
});

// GET /api/distributor-portal/my-distributors
// Returns all active distributors that belong to the same MVNO as the authenticated user.
// Resolves MVNO from: jwt.mvno_id → linked distributor's mvno_id → all active (fallback).
router.get('/distributor-portal/my-distributors', async (req: Request, res: Response) => {
  try {
    const jwt = requireJwt(req, res);
    if (!jwt) return;

    // Determine the MVNO to scope by
    let mvnoId: string | null = jwt.mvno_id || null;

    // If not in JWT, try to resolve from the linked distributor record
    if (!mvnoId) {
      const dist = await resolveDistributor(jwt.id, jwt.email);
      if (dist?.mvno_id) mvnoId = dist.mvno_id;
    }

    let r;
    if (mvnoId) {
      r = await query(
        `SELECT d.id, d.name, d.contact_person, d.email, d.phone, d.contact_phone,
                d.location, d.region, d.mvno_id, m.name AS mvno_name
           FROM distributors d
           LEFT JOIN mvnos m ON m.id = d.mvno_id
          WHERE d.mvno_id = $1 AND d.is_active = true
          ORDER BY d.name`,
        [mvnoId],
      );
    } else {
      // Fallback: no MVNO scoping — return all active distributors
      r = await query(
        `SELECT d.id, d.name, d.contact_person, d.email, d.phone, d.contact_phone,
                d.location, d.region, d.mvno_id, m.name AS mvno_name
           FROM distributors d
           LEFT JOIN mvnos m ON m.id = d.mvno_id
          WHERE d.is_active = true
          ORDER BY d.name`,
      );
    }

    return ok(res, { distributors: r.rows, mvno_id: mvnoId });
  } catch (e: any) { return fail(res, 500, e.message); }
});

// GET /api/distributor-portal/profile  (legacy — kept for backward compat)
router.get('/distributor-portal/profile', async (req: Request, res: Response) => {
  try {
    const jwt   = requireJwt(req, res);
    if (!jwt) return;
    const dist  = await resolveDistributor(jwt.id, jwt.email);
    if (!dist) return ok(res, { distributor: null, not_linked: true,
      message: 'Your account is not yet linked to a distributor record.' });
    const userRow = await stockService.getPlatformUserByEmail(jwt.email);
    return ok(res, { distributor: dist, platform_user: userRow, not_linked: false });
  } catch (e: any) { return fail(res, 500, e.message); }
});

// GET /api/distributor-portal/dashboard
router.get('/distributor-portal/dashboard', async (req: Request, res: Response) => {
  try {
    const jwt  = requireJwt(req, res);
    if (!jwt) return;
    const dist = await resolveDistributor(jwt.id, jwt.email);
    if (!dist) return ok(res, { not_linked: true, stats: null, recent_requests: [] });

    const statsRes = await query(
      `SELECT
         COUNT(*) FILTER (WHERE TRUE)                           AS total,
         COUNT(*) FILTER (WHERE status = 'PENDING')            AS pending,
         COUNT(*) FILTER (WHERE status = 'UNDER_REVIEW')       AS under_review,
         COUNT(*) FILTER (WHERE status = 'APPROVED')           AS approved,
         COUNT(*) FILTER (WHERE status = 'REJECTED')           AS rejected,
         COUNT(*) FILTER (WHERE status = 'FULFILLED')          AS fulfilled
       FROM distributor_sim_requests
       WHERE distributor_id = $1`,
      [dist.id],
    );
    const stats = statsRes.rows[0] ?? {};

    const recentRes = await query(
      `SELECT id, reference_no, sim_type, quantity, status, notes, created_at, updated_at
         FROM distributor_sim_requests
        WHERE distributor_id = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [dist.id],
    );

    return ok(res, {
      not_linked: false,
      stats: {
        total:        Number(stats.total)        || 0,
        pending:      Number(stats.pending)      || 0,
        under_review: Number(stats.under_review) || 0,
        approved:     Number(stats.approved)     || 0,
        rejected:     Number(stats.rejected)     || 0,
        fulfilled:    Number(stats.fulfilled)    || 0,
      },
      recent_requests: recentRes.rows,
    });
  } catch (e: any) { return fail(res, 500, e.message); }
});

// GET /api/distributor-portal/requests
router.get('/distributor-portal/requests', async (req: Request, res: Response) => {
  try {
    const jwt    = requireJwt(req, res);
    if (!jwt) return;
    const status = req.query.status ? String(req.query.status) : undefined;
    const limit  = Math.min(Number(req.query.limit || 20), 100);
    const offset = Number(req.query.offset || 0);

    const dist = await resolveDistributor(jwt.id, jwt.email);
    if (!dist) return ok(res, { not_linked: true, data: [], total: 0, limit, offset });

    const where: string[] = ['distributor_id = $1'];
    const vals: any[]     = [dist.id];
    if (status) { where.push(`status = $${vals.length + 1}`); vals.push(status); }

    const countRes = await query(
      `SELECT COUNT(*) AS total FROM distributor_sim_requests WHERE ${where.join(' AND ')}`,
      vals,
    );
    const rowsRes  = await query(
      `SELECT * FROM distributor_sim_requests WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      vals,
    );
    return ok(res, { not_linked: false, data: rowsRes.rows, total: Number(countRes.rows[0]?.total || 0), limit, offset });
  } catch (e: any) { return fail(res, 500, e.message); }
});

// POST /api/distributor-portal/requests
router.post('/distributor-portal/requests', async (req: Request, res: Response) => {
  try {
    const jwt      = requireJwt(req, res);
    if (!jwt) return;
    const sim_type = String(req.body.sim_type || '').toUpperCase();
    const quantity = Number(req.body.quantity);
    const notes    = req.body.notes ? String(req.body.notes) : null;
    if (!['PHYSICAL','ESIM'].includes(sim_type)) return fail(res, 400, 'sim_type must be PHYSICAL or ESIM');
    if (!quantity || quantity <= 0)              return fail(res, 400, 'quantity must be a positive number');

    // Allow explicit distributor_id from form if user chose one; else resolve from JWT
    let dist: any = null;
    if (req.body.distributor_id) {
      const r = await query(
        `SELECT d.*, m.name AS mvno_name FROM distributors d LEFT JOIN mvnos m ON m.id = d.mvno_id WHERE d.id = $1 AND d.is_active = true LIMIT 1`,
        [req.body.distributor_id],
      );
      dist = r.rows[0] ?? null;
    }
    if (!dist) dist = await resolveDistributor(jwt.id, jwt.email);
    if (!dist) return fail(res, 404, 'No distributor record linked to your account. Contact your MVNO admin.');

    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const seqRes   = await query(`SELECT nextval('dsr_daily_seq') AS seq`);
    const seq      = String(seqRes.rows[0]?.seq || 1).padStart(4, '0');
    const ref      = `DSR-${datePart}-${seq}`;

    const insertRes = await query(
      `INSERT INTO distributor_sim_requests
         (reference_no, distributor_id, distributor_email, mvno_id, mvno_name, sim_type, quantity, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [ref, dist.id, jwt.email, dist.mvno_id, dist.mvno_name, sim_type, quantity, notes],
    );
    return ok(res, insertRes.rows[0]);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// GET /api/distributor-portal/requests/:id
router.get('/distributor-portal/requests/:id', async (req: Request, res: Response) => {
  try {
    const jwt  = requireJwt(req, res);
    if (!jwt) return;
    const id   = req.params.id;
    const dist = await resolveDistributor(jwt.id, jwt.email);
    if (!dist)  return fail(res, 404, 'No distributor record linked to your account');

    const rowRes = await query(
      `SELECT * FROM distributor_sim_requests WHERE id = $1 AND distributor_id = $2`,
      [id, dist.id],
    );
    if (!rowRes.rows[0]) return fail(res, 404, 'Request not found');
    return ok(res, rowRes.rows[0]);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ==================== MVNO ADMIN PORTAL ROUTES ====================
// All routes: /api/mvno-admin/*
// Auth: requires valid JWT with role MVNO_ADMIN (or SUPER_ADMIN for testing)
// Scoping: all queries filtered by req.user.mvno_id === resource.mvno_id

/** Middleware helper: verify JWT is MVNO_ADMIN and return payload, else 401/403 */
function requireMvnoAdmin(req: Request, res: Response): Record<string, any> | null {
  const jwt = getJwtPayload(req);
  if (!jwt) { fail(res, 401, 'Authentication required'); return null; }
  if (jwt.role !== 'MVNO_ADMIN' && jwt.role !== 'SUPER_ADMIN') {
    fail(res, 403, 'Access denied — MVNO Admin role required');
    return null;
  }
  if (!jwt.mvno_id) { fail(res, 403, 'No MVNO associated with your account'); return null; }
  return jwt;
}

// ── GET /api/mvno-admin/dashboard/stats ──────────────────────────────────────
router.get('/mvno-admin/dashboard/stats', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const mvnoId = jwt.mvno_id as string;

    // Total requests
    const totalRes = await query(
      `SELECT COUNT(*) AS total FROM stock_issuance_requests WHERE mvno_id = $1`, [mvnoId]);
    const total_requests = parseInt(totalRes.rows[0].total, 10);

    // Pending
    const pendRes = await query(
      `SELECT COUNT(*) AS cnt FROM stock_issuance_requests WHERE mvno_id = $1 AND status = 'PENDING'`, [mvnoId]);
    const pending_requests = parseInt(pendRes.rows[0].cnt, 10);

    // Approved today
    const appTodayRes = await query(
      `SELECT COUNT(*) AS cnt FROM stock_issuance_requests
       WHERE mvno_id = $1 AND status IN ('APPROVED','COMPLETED')
         AND updated_at::date = CURRENT_DATE`, [mvnoId]);
    const approved_today = parseInt(appTodayRes.rows[0].cnt, 10);

    // Rejected today
    const rejTodayRes = await query(
      `SELECT COUNT(*) AS cnt FROM stock_issuance_requests
       WHERE mvno_id = $1 AND status = 'REJECTED' AND updated_at::date = CURRENT_DATE`, [mvnoId]);
    const rejected_today = parseInt(rejTodayRes.rows[0].cnt, 10);

    // Escalated
    const escalRes = await query(
      `SELECT COUNT(*) AS cnt FROM stock_issuance_requests
       WHERE mvno_id = $1 AND status = 'ESCALATED'`, [mvnoId]);
    const escalated_count = parseInt(escalRes.rows[0].cnt, 10);

    // Physical stock for this MVNO
    const physRes = await query(
      `SELECT
         COALESCE(SUM(b.total_sims), 0) AS total_received,
         COALESCE(SUM(b.remaining_sims), 0) AS available,
         COALESCE(SUM(b.total_sims - b.remaining_sims), 0) AS distributed
       FROM boxes b
       JOIN cartons c ON c.id = b.carton_id
       WHERE c.mvno_id = $1`, [mvnoId]);
    const total_physical_stock     = parseInt(physRes.rows[0].total_received, 10);
    const available_physical_stock = parseInt(physRes.rows[0].available, 10);
    const distributed_physical     = parseInt(physRes.rows[0].distributed, 10);

    // eSIM stock for this MVNO
    const esimRes = await query(
      `SELECT
         COUNT(*) AS total_received,
         COUNT(*) FILTER (WHERE status = 'available') AS available,
         COUNT(*) FILTER (WHERE status NOT IN ('available', 'reserved')) AS distributed
       FROM esim_stock WHERE mvno_id = $1`, [mvnoId]);
    const total_esim_stock     = parseInt(esimRes.rows[0].total_received, 10);
    const available_esim_stock = parseInt(esimRes.rows[0].available, 10);
    const distributed_esim     = parseInt(esimRes.rows[0].distributed, 10);

    // Distribution trend — last 7 days
    const trendRes = await query(
      `SELECT
         TO_CHAR(ph.issued_at::date, 'Mon DD') AS date,
         COUNT(*) FILTER (WHERE UPPER(COALESCE(ph.sim_type, sir.sim_type, 'PHYSICAL')) = 'PHYSICAL') AS physical,
         COUNT(*) FILTER (WHERE UPPER(COALESCE(ph.sim_type, sir.sim_type, 'PHYSICAL')) = 'ESIM')     AS esim
       FROM pick_history ph
       LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
       WHERE ph.mvno_id = $1
         AND ph.issued_at >= NOW() - INTERVAL '7 days'
       GROUP BY ph.issued_at::date
       ORDER BY ph.issued_at::date`, [mvnoId]);
    const distribution_trend = trendRes.rows.map((r: any) => ({
      date: r.date,
      physical: parseInt(r.physical, 10),
      esim: parseInt(r.esim, 10),
    }));

    // Requests overview by status
    const ovRes = await query(
      `SELECT status, COUNT(*) AS cnt
       FROM stock_issuance_requests WHERE mvno_id = $1
       GROUP BY status`, [mvnoId]);
    const ovMap: Record<string, number> = {};
    for (const row of ovRes.rows) ovMap[String(row.status).toLowerCase()] = parseInt(row.cnt, 10);
    const requests_overview = {
      pending:   ovMap['pending']   || 0,
      approved:  (ovMap['approved'] || 0) + (ovMap['completed'] || 0),
      rejected:  ovMap['rejected']  || 0,
      escalated: ovMap['escalated'] || 0,
      completed: ovMap['completed'] || 0,
      total: total_requests,
    };

    // Recent 10 requests
    const recentRes = await query(
      `SELECT
         sir.id, sir.id AS request_ref, sir.requester_id AS distributor_id,
         COALESCE(d.name, 'Unknown') AS distributor_name,
         sir.contact_person, sir.contact_email,
         COALESCE(sir.sim_type, 'PHYSICAL') AS sim_type,
         sir.quantity, sir.status, sir.notes, sir.created_at,
         ROUND(EXTRACT(EPOCH FROM (NOW() - sir.created_at)) / 60)::int AS response_minutes
       FROM stock_issuance_requests sir
       LEFT JOIN distributors d ON d.id = sir.requester_id
       WHERE sir.mvno_id = $1
       ORDER BY sir.created_at DESC
       LIMIT 10`, [mvnoId]);

    return ok(res, {
      total_requests, pending_requests, approved_today, rejected_today, escalated_count,
      total_physical_stock, available_physical_stock, distributed_physical,
      total_esim_stock, available_esim_stock, distributed_esim,
      distribution_trend, requests_overview,
      recent_requests: recentRes.rows,
    });
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ── GET /api/mvno-admin/physical-stock ────────────────────────────────────────
router.get('/mvno-admin/physical-stock', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const mvnoId = jwt.mvno_id as string;

    const physRes = await query(
      `SELECT
         COALESCE(SUM(b.total_sims), 0) AS total_received,
         COALESCE(SUM(b.remaining_sims), 0) AS available,
         COALESCE(SUM(b.total_sims - b.remaining_sims), 0) AS distributed
       FROM boxes b
       JOIN cartons c ON c.id = b.carton_id
       WHERE c.mvno_id = $1`,
      [mvnoId]
    );

    return ok(res, {
      mvno_id: mvnoId,
      total: parseInt(physRes.rows[0].total_received, 10),
      available: parseInt(physRes.rows[0].available, 10),
      distributed: parseInt(physRes.rows[0].distributed, 10),
    });
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ── GET /api/mvno-admin/esim-stock ────────────────────────────────────────────
router.get('/mvno-admin/esim-stock', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const mvnoId = jwt.mvno_id as string;

    const esimRes = await query(
      `SELECT
         COUNT(*) AS total_received,
         COUNT(*) FILTER (WHERE status = 'available') AS available,
         COUNT(*) FILTER (WHERE status NOT IN ('available', 'reserved')) AS distributed
       FROM esim_stock WHERE mvno_id = $1`,
      [mvnoId]
    );

    return ok(res, {
      mvno_id: mvnoId,
      total: parseInt(esimRes.rows[0].total_received, 10),
      available: parseInt(esimRes.rows[0].available, 10),
      distributed: parseInt(esimRes.rows[0].distributed, 10),
    });
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ── GET /api/mvno-admin/sim-requests ─────────────────────────────────────────
router.get('/mvno-admin/sim-requests', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const mvnoId = jwt.mvno_id as string;

    const status    = String(req.query.status    || '').trim().toUpperCase();
    const sim_type  = String(req.query.sim_type  || '').trim().toUpperCase();
    const search    = String(req.query.search    || '').trim();
    const date_from = String(req.query.date_from || '').trim();
    const date_to   = String(req.query.date_to   || '').trim();
    const page      = Math.max(1, parseInt(String(req.query.page  || '1'), 10));
    const limit     = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '25'), 10)));
    const offset    = (page - 1) * limit;

    const conditions: string[] = ['sir.mvno_id = $1'];
    const params: any[] = [mvnoId];
    let pi = 2;

    if (status)    { conditions.push(`sir.status = $${pi++}`);   params.push(status); }
    if (sim_type)  { conditions.push(`UPPER(COALESCE(sir.sim_type,'PHYSICAL')) = $${pi++}`); params.push(sim_type); }
    if (search)    { conditions.push(`(COALESCE(d.name,'') ILIKE $${pi} OR sir.id::text ILIKE $${pi})`); params.push(`%${search}%`); pi++; }
    if (date_from) { conditions.push(`sir.created_at >= $${pi++}::date`); params.push(date_from); }
    if (date_to)   { conditions.push(`sir.created_at < ($${pi++}::date + INTERVAL '1 day')`); params.push(date_to); }

    const where = conditions.join(' AND ');

    const countRes = await query(
      `SELECT COUNT(*) AS total
       FROM stock_issuance_requests sir
       LEFT JOIN distributors d ON d.id = sir.requester_id
       WHERE ${where}`, params);
    const total = parseInt(countRes.rows[0].total, 10);

    const dataParams = [...params, limit, offset];
    const dataRes = await query(
      `SELECT
         sir.id, sir.id AS request_ref, sir.requester_id AS distributor_id,
         COALESCE(d.name, 'Unknown') AS distributor_name,
         sir.contact_person, sir.contact_email,
         COALESCE(sir.sim_type, 'PHYSICAL') AS sim_type,
         sir.quantity, sir.status, sir.notes,
         sir.rejection_reason, sir.escalation_reason,
         sir.reviewed_by, sir.reviewed_at, sir.escalated_at,
         sir.created_at, sir.mvno_id,
         ROUND(EXTRACT(EPOCH FROM (NOW() - sir.created_at)) / 60)::int AS response_minutes
       FROM stock_issuance_requests sir
       LEFT JOIN distributors d ON d.id = sir.requester_id
       WHERE ${where}
       ORDER BY
         CASE sir.status WHEN 'ESCALATED' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,
         sir.created_at DESC
       LIMIT $${pi++} OFFSET $${pi++}`, dataParams);

    return ok(res, { rows: dataRes.rows, total, page, limit });
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ── GET /api/mvno-admin/sim-requests/:id ─────────────────────────────────────
router.get('/mvno-admin/sim-requests/:id', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const mvnoId = jwt.mvno_id as string;
    const { id } = req.params;

    const res2 = await query(
      `SELECT sir.*, COALESCE(d.name,'Unknown') AS distributor_name,
              d.contact_person AS dist_contact, d.email AS dist_email
       FROM stock_issuance_requests sir
       LEFT JOIN distributors d ON d.id = sir.requester_id
       WHERE sir.id = $1 AND sir.mvno_id = $2`, [id, mvnoId]);

    if (!res2.rows[0]) return fail(res, 404, 'Request not found or not in your MVNO');
    return ok(res, res2.rows[0]);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ── PATCH /api/mvno-admin/sim-requests/:id/approve ───────────────────────────
router.patch('/mvno-admin/sim-requests/:id/approve', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const mvnoId = jwt.mvno_id as string;
    const { id } = req.params;
    const notes = req.body.notes ? String(req.body.notes) : null;

    // Check request exists and belongs to this MVNO
    const check = await query(
      `SELECT * FROM stock_issuance_requests WHERE id = $1 AND mvno_id = $2`, [id, mvnoId]);
    if (!check.rows[0]) return fail(res, 404, 'Request not found or not in your MVNO');
    if (!['PENDING', 'ESCALATED'].includes(check.rows[0].status)) {
      return fail(res, 400, `Cannot approve a request with status ${check.rows[0].status}`);
    }

    // Stock availability check (best-effort guard before approval)
    const simType = String(check.rows[0].sim_type || 'PHYSICAL').toUpperCase();
    const qty = Math.max(0, parseInt(String(check.rows[0].quantity || 0), 10));
    if (qty <= 0) return fail(res, 400, 'Invalid request quantity');

    if (simType === 'ESIM') {
      const availRes = await query(
        `SELECT COUNT(*) FILTER (WHERE status = 'available')::int AS available
         FROM esim_stock WHERE mvno_id = $1`,
        [mvnoId]
      );
      const available = Number(availRes.rows[0]?.available ?? 0);
      if (available < qty) {
        return fail(res, 409, `Insufficient eSIM stock. Available: ${available}, requested: ${qty}`);
      }
    } else {
      const physRes = await query(
        `SELECT COALESCE(SUM(b.remaining_sims), 0)::int AS available
         FROM boxes b
         JOIN cartons c ON c.id = b.carton_id
         WHERE c.mvno_id = $1`,
        [mvnoId]
      );
      const available = Number(physRes.rows[0]?.available ?? 0);
      if (available < qty) {
        return fail(res, 409, `Insufficient physical SIM stock. Available: ${available}, requested: ${qty}`);
      }
    }

    // Auto-assign stock for issuance, then issue immediately.
    const requestRow = check.rows[0];
    const distributorId = requestRow.requester_id as string | null;
    if (!distributorId) return fail(res, 400, 'Request has no distributor requester_id');

    if (simType === 'ESIM') {
      const iccidRes = await query(
        `SELECT iccid
         FROM esim_stock
         WHERE mvno_id = $1 AND status = 'available'
         ORDER BY iccid
         LIMIT $2`,
        [mvnoId, qty]
      );
      const iccids = iccidRes.rows.map((r: any) => String(r.iccid)).filter(Boolean);
      if (iccids.length < qty) {
        return fail(res, 409, `Insufficient eSIM stock. Available: ${iccids.length}, requested: ${qty}`);
      }

      await query(
        `UPDATE stock_issuance_requests
         SET status = 'READY_FOR_APPROVAL',
             reviewed_by = $1,
             reviewed_at = NOW(),
             notes = COALESCE($2, notes),
             assigned_esim_iccids = $3,
             assigned_box_quantities = '[]'::jsonb,
             updated_at = NOW()
         WHERE id = $4`,
        [jwt.email, notes, iccids, id]
      );
    } else {
      // Allocate from boxes belonging to this MVNO.
      const boxesRes = await query(
        `SELECT b.id::text AS box_id, COALESCE(b.remaining_sims, 0)::int AS remaining
         FROM boxes b
         JOIN cartons c ON c.id = b.carton_id
         WHERE c.mvno_id = $1 AND COALESCE(b.remaining_sims, 0) > 0
         ORDER BY COALESCE(b.remaining_sims, 0) DESC, b.created_at ASC`,
        [mvnoId]
      );

      let remainingQty = qty;
      const assigned: Array<{ box_id: string; quantity: number }> = [];
      for (const row of boxesRes.rows) {
        if (remainingQty <= 0) break;
        const boxRemaining = Math.max(0, Number(row.remaining || 0));
        if (boxRemaining <= 0) continue;
        const take = Math.min(boxRemaining, remainingQty);
        assigned.push({ box_id: String(row.box_id), quantity: take });
        remainingQty -= take;
      }
      if (remainingQty > 0) {
        return fail(res, 409, `Insufficient physical SIM stock. Available: ${qty - remainingQty}, requested: ${qty}`);
      }

      await query(
        `UPDATE stock_issuance_requests
         SET status = 'READY_FOR_APPROVAL',
             reviewed_by = $1,
             reviewed_at = NOW(),
             notes = COALESCE($2, notes),
             assigned_box_quantities = $3::jsonb,
             assigned_esim_iccids = NULL,
             updated_at = NOW()
         WHERE id = $4`,
        [jwt.email, notes, JSON.stringify(assigned), id]
      );
    }

    const issued = await stockService.issueApprovedStockRequest(id);

    // Audit log
    await query(
      `INSERT INTO stock_audit_logs (request_id, action, performed_by, performed_by_email, details)
       VALUES ($1, 'REQUEST_APPROVED', $2, $3, $4)`,
      [id, jwt.id, jwt.email, JSON.stringify({ notes, approved_at: new Date().toISOString(), issued_status: issued.request?.status || null })]).catch(() => {});

    const io = getIo();
    io?.to('mvno:paxtel').emit('mvno_admin:request_updated', { id, status: 'APPROVED' });

    return ok(res, { id, status: issued.request?.status || 'COMPLETED', pdf_url: issued.pdf_url ?? null }, 'Request approved and issued successfully');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ── PATCH /api/mvno-admin/sim-requests/:id/reject ────────────────────────────
router.patch('/mvno-admin/sim-requests/:id/reject', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const mvnoId = jwt.mvno_id as string;
    const { id } = req.params;
    const reason = String(req.body.reason || '').trim();
    if (!reason) return fail(res, 400, 'Rejection reason is required');

    const check = await query(
      `SELECT * FROM stock_issuance_requests WHERE id = $1 AND mvno_id = $2`, [id, mvnoId]);
    if (!check.rows[0]) return fail(res, 404, 'Request not found or not in your MVNO');
    if (!['PENDING', 'ESCALATED'].includes(check.rows[0].status)) {
      return fail(res, 400, `Cannot reject a request with status ${check.rows[0].status}`);
    }

    await query(
      `UPDATE stock_issuance_requests
       SET status = 'REJECTED', rejection_reason = $1,
           reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [reason, jwt.email, id]);

    await query(
      `INSERT INTO stock_audit_logs (request_id, action, performed_by, performed_by_email, details)
       VALUES ($1, 'REQUEST_REJECTED', $2, $3, $4)`,
      [id, jwt.id, jwt.email, JSON.stringify({ reason, rejected_at: new Date().toISOString() })]).catch(() => {});

    const io = getIo();
    io?.to('mvno:paxtel').emit('mvno_admin:request_updated', { id, status: 'REJECTED' });
    return ok(res, { id, status: 'REJECTED' }, 'Request rejected');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ── PATCH /api/mvno-admin/sim-requests/:id/escalate ──────────────────────────
router.patch('/mvno-admin/sim-requests/:id/escalate', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const mvnoId = jwt.mvno_id as string;
    const { id } = req.params;
    const reason = String(req.body.reason || 'Manually escalated by MVNO Admin').trim();

    const check = await query(
      `SELECT * FROM stock_issuance_requests WHERE id = $1 AND mvno_id = $2`, [id, mvnoId]);
    if (!check.rows[0]) return fail(res, 404, 'Request not found or not in your MVNO');

    await query(
      `UPDATE stock_issuance_requests
       SET status = 'ESCALATED', escalation_reason = $1,
           escalated_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [reason, id]);

    const io = getIo();
    io?.to('mvno:paxtel').emit('mvno_admin:request_updated', { id, status: 'ESCALATED' });
    return ok(res, { id, status: 'ESCALATED' }, 'Request escalated');
  } catch (e: any) { return fail(res, 500, e.message); }
});

export default router;

