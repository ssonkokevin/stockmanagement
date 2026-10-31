import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import * as stockService from '../services/stock.service.js';
import * as onboardingService from '../services/onboarding.service.js';
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
const upload = multer({ storage: multer.memoryStorage() });
let bossSyncDeprecationLogged = false;

// ...

// ==================== ONBOARDING DOCUMENT UPLOAD ====================
router.post('/onboarding/upload-document', upload.single('file'), async (req: Request, res: Response) => {
  const file = req.file;
  try {
    if (!file) return fail(res, 400, 'No file uploaded');

    if (!onboardingService.ONBOARDING_DOCUMENTS_MIME_TYPES.includes(file.mimetype)) {
      return fail(res, 400, `Unsupported file type: ${file.mimetype}`);
    }
    if (file.size > onboardingService.ONBOARDING_DOCUMENTS_MAX_SIZE_BYTES) {
      return fail(res, 400, 'File exceeds the 10MB size limit');
    }

    const fileExt = path.extname(file.originalname);
    // Deterministic, content-addressed path: identical file content always hashes to the
    // same path, so re-uploading the same document never creates a duplicate file on disk.
    const contentHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const relativePath = `${onboardingService.ONBOARDING_DOCUMENTS_DIR}/${contentHash}${fileExt}`;
    const dirPath = path.join(process.cwd(), 'uploads', onboardingService.ONBOARDING_DOCUMENTS_DIR);
    const filePath = path.join(dirPath, `${contentHash}${fileExt}`);
    const sizeKb = (file.size / 1024).toFixed(1);

    logLine('INF', 'LOCAL_UPLOAD', `[LOCAL UPLOAD] Starting upload -> dir="${onboardingService.ONBOARDING_DOCUMENTS_DIR}" file="${file.originalname}" hash="${contentHash.slice(0, 12)}…" type=${file.mimetype} size=${sizeKb}KB`);

    const deduped = fs.existsSync(filePath);
    if (deduped) {
      logLine('INF', 'LOCAL_UPLOAD', `[LOCAL UPLOAD] ♻️ Duplicate content detected -> file="${file.originalname}" hash="${contentHash.slice(0, 12)}…" (reusing existing file, no new write)`);
    } else {
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(filePath, file.buffer);
    }

    const url = `/uploads/${relativePath}`;
    logLine('INF', 'LOCAL_UPLOAD', `[LOCAL UPLOAD] ✅ ${deduped ? 'Reused existing file' : 'Success'} -> file="${file.originalname}" url="${url}"`);

    return ok(res, { url, name: file.originalname, deduped });
  } catch (e: any) {
    logLine('ERR', 'LOCAL_UPLOAD', `[LOCAL UPLOAD] ❌ Failed -> file="${file?.originalname || 'unknown'}" error=${e.message}`);
    return fail(res, 500, e?.message || 'File upload failed');
  }
});

function ok(res: Response, data: any, message?: string) {
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

// Populate req.auth from Bearer token (soft — routes decide if auth is required via requireAuth()).
router.use(jwtMiddleware);

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
    const { limit, offset, search, carton_number, box_number, mvno, mvno_id, status, iccid_from, iccid_to } = req.query;
    const rows = await stockService.getBoxStockSummary({
      limit: limit ? parseInt(String(limit)) : undefined,
      offset: offset ? parseInt(String(offset)) : undefined,
      search: search ? String(search) : undefined,
      carton_number: carton_number ? String(carton_number) : undefined,
      box_number: box_number ? String(box_number) : undefined,
      mvno: mvno ? String(mvno) : undefined,
      mvno_id: mvno_id ? String(mvno_id) : undefined,
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
    const { search, carton_number, box_number, mvno, mvno_id, status, iccid_from, iccid_to } = req.query;
    const count = await stockService.getBoxStockSummaryCount({
      search: search ? String(search) : undefined,
      carton_number: carton_number ? String(carton_number) : undefined,
      box_number: box_number ? String(box_number) : undefined,
      mvno: mvno ? String(mvno) : undefined,
      mvno_id: mvno_id ? String(mvno_id) : undefined,
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
    const { requestId, approvers } = req.body;
    // approvers: Array<{ name: string; email: string }> — optional, overrides saved emails

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
    
    // Get box details — query directly by box ID so reserved/issued boxes are still found
    let assignedBoxes: any[] = [];
    if (stockRequest.assigned_box_quantities && stockRequest.assigned_box_quantities.length > 0) {
      const boxIds = stockRequest.assigned_box_quantities.map((b: any) => b.box_id).filter(Boolean);
      if (boxIds.length > 0) {
        const boxRows = await query(
          `SELECT b.id, b.box_number, c.carton_number,
                  b.iccid_start, b.iccid_end
             FROM boxes b
             LEFT JOIN cartons c ON b.carton_id = c.id
            WHERE b.id = ANY($1::uuid[])`,
          [boxIds]
        );
        const boxMap = new Map(boxRows.rows.map((r: any) => [r.id, r]));
        assignedBoxes = stockRequest.assigned_box_quantities.map((box: any) => {
          const boxInfo: any = boxMap.get(box.box_id) || {};
          return {
            box_id:       box.box_id,
            box_number:   boxInfo.box_number   ? String(boxInfo.box_number)   : null,
            carton_number: boxInfo.carton_number || null,
            quantity:     box.quantity,
            iccid_start:  boxInfo.iccid_start  || null,
            iccid_end:    boxInfo.iccid_end     || null,
          };
        });
      }
    }
    
    // Get eSIM ICCIDs
    let assignedEsims: string[] = [];
    if (stockRequest.assigned_esim_iccids && stockRequest.assigned_esim_iccids.length > 0) {
      assignedEsims = stockRequest.assigned_esim_iccids;
    }
    
    // If approvers were sent from the portal, update the request before generating tokens
    if (approvers && Array.isArray(approvers) && approvers.length >= 1) {
      const level1 = approvers[0];
      const level2 = approvers[1] || approvers[0];
      // Try with name columns first; fall back without them if migration hasn't run
      try {
        await query(
          `UPDATE stock_issuance_requests
             SET level_1_approver_email = $2,
                 level_2_approver_email = $3,
                 level_1_approver_name  = $4,
                 level_2_approver_name  = $5,
                 updated_at = NOW()
           WHERE id = $1`,
          [requestId,
           level1.email || null, level2.email || null,
           level1.name  || null, level2.name  || null]
        );
      } catch (_) {
        // Name columns may not exist yet — fall back to email-only update
        await query(
          `UPDATE stock_issuance_requests
             SET level_1_approver_email = $2,
                 level_2_approver_email = $3,
                 updated_at = NOW()
           WHERE id = $1`,
          [requestId, level1.email || null, level2.email || null]
        );
      }
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
    // Build name lookup from portal-submitted approvers
    const approverNameMap: Record<string, string> = {};
    if (approvers && Array.isArray(approvers)) {
      approvers.forEach((a: any) => {
        if (a.email && a.name) approverNameMap[a.email.toLowerCase()] = a.name;
      });
    }

    for (const token of tokens) {
      const approverName = approverNameMap[token.approver_email?.toLowerCase()] ||
        (token.approver_role === 'LEVEL_1' ? (stockRequest as any).level_1_approver_name : (stockRequest as any).level_2_approver_name) ||
        null;
      const sent = await emailService.sendApprovalEmail(
        {
          token: token.token,
          request_id: requestId,
          approver_email: token.approver_email,
          approver_role: token.approver_role,
          approver_name: approverName,
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
        config.app.baseUrl,
        req.headers
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

// Look up approver email from a token (no auth required — used by email link flow)
router.get('/approval/token-info/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    if (!token) return fail(res, 400, 'token required');
    const result = await query(
      `SELECT approver_email AS email, approver_role AS role, expires_at, status
         FROM approval_tokens
        WHERE token = $1
        LIMIT 1`,
      [token]
    );
    if (!result.rows[0]) return fail(res, 404, 'Token not found or expired');
    const row = result.rows[0];
    if (row.status === 'expired' || new Date(row.expires_at) < new Date()) {
      return fail(res, 410, 'Token has expired');
    }
    // Try to look up the approver name — silently skip if columns don't exist yet
    let approverName: string | null = null;
    try {
      const reqRow = await query(
        `SELECT sir.level_1_approver_name, sir.level_2_approver_name
           FROM stock_issuance_requests sir
           JOIN stock_approval_tokens sat ON sat.request_id = sir.id
          WHERE sat.token = $1
          LIMIT 1`,
        [token]
      );
      if (reqRow.rows[0]) {
        approverName = row.role === 'LEVEL_1'
          ? reqRow.rows[0].level_1_approver_name
          : reqRow.rows[0].level_2_approver_name;
      }
    } catch (_) { /* columns may not exist yet — name will be null */ }
    return ok(res, { email: row.email, role: row.role, name: approverName });
  } catch (error: any) {
    return fail(res, 500, error.message);
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
    
    const requestId = validation.rows[0].request_id;
    const approverEmail = (validation.rows[0].email || '').toLowerCase();

    // Log the action
    await stockService.addAuditLog(
      requestId,
      action === 'approve' ? 'EMAIL_APPROVED' : 'EMAIL_REJECTED',
      { email: approverEmail, action }
    );

    logLine('INF', 'EMAIL_APPROVAL', `approve/verify recorded ${action} for request ${requestId}`);

    // ── Sync into approval_responses so the consensus check can see this vote ──
    const actionStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
    await query(
      `INSERT INTO approval_responses (request_id, email, status, responded_at, updated_at, token)
       VALUES ($1, $2, $3, NOW(), NOW(), $4)
       ON CONFLICT (request_id, email)
       DO UPDATE SET status = EXCLUDED.status, responded_at = NOW(), updated_at = NOW()`,
      [requestId, approverEmail, actionStatus, token]
    );

    // ── Update the approver slot timestamp on the request ──
    const reqRow = await query(
      `SELECT level_1_approver_email, level_2_approver_email FROM stock_issuance_requests WHERE id = $1`,
      [requestId]
    );
    const l1 = (reqRow.rows[0]?.level_1_approver_email || '').toLowerCase();
    const l2 = (reqRow.rows[0]?.level_2_approver_email || '').toLowerCase();
    if (approverEmail === l1) {
      await query(
        `UPDATE stock_issuance_requests SET level_1_approved_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [requestId]
      );
    } else if (approverEmail === l2) {
      await query(
        `UPDATE stock_issuance_requests SET level_2_approved_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [requestId]
      );
    }

    // ── Inline consensus check ──
    // Deduplicate so 1-approver flows (l1 === l2) complete on a single approval
    const approverEmails = [...new Set([l1, l2].filter(Boolean))];
    const allResponses = await query(
      `SELECT LOWER(email) AS email, status FROM approval_responses
        WHERE request_id = $1 AND LOWER(email) = ANY($2::text[])`,
      [requestId, approverEmails]
    );
    const approvedCount = allResponses.rows.filter((r: any) => r.status === 'APPROVED').length;
    const rejectedCount = allResponses.rows.filter((r: any) => r.status === 'REJECTED').length;

    let consensusReached = false;
    let finalStatus: string | null = null;

    if (rejectedCount > 0) {
      await query(`UPDATE stock_issuance_requests SET status = 'REJECTED', updated_at = NOW() WHERE id = $1`, [requestId]);
      finalStatus = 'REJECTED';
      consensusReached = true;
      logLine('WRN', 'APPROVAL', `Request ${requestId} REJECTED by email-flow consensus`);
    } else if (approverEmails.length > 0 && approvedCount >= approverEmails.length) {
      logLine('INF', 'APPROVAL', `Request ${requestId} fully approved via email (${approvedCount}/${approverEmails.length}). Issuing stock...`);
      try {
        const result = await stockService.issueApprovedStockRequest(requestId);
        finalStatus = 'COMPLETED';
        consensusReached = true;
        logLine('INF', 'APPROVAL', `Request ${requestId} COMPLETED via email flow. PDF: ${result.pdf_url || 'none'}`);
      } catch (issueErr: any) {
        logLine('ERR', 'APPROVAL', `Email-flow issuance failed for ${requestId}: ${issueErr.message}`);
        await query(`UPDATE stock_issuance_requests SET status = 'READY_FOR_APPROVAL', updated_at = NOW() WHERE id = $1`, [requestId]);
      }
    }

    const remaining = approverEmails.length - approvedCount;
    const message = consensusReached
      ? (finalStatus === 'COMPLETED' ? 'Stock Issued — Request Approved Successfully' : `Request ${finalStatus}`)
      : remaining > 0
        ? `Approval recorded (${approvedCount}/${approverEmails.length}). Waiting for ${remaining} more approver${remaining > 1 ? 's' : ''}.`
        : 'Approval recorded.';

    res.json({
      success: true,
      message,
      request_id: requestId,
      consensus_reached: consensusReached,
      final_status: finalStatus,
      approvals: { count: approvedCount, needed: approverEmails.length || 2 },
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
        // Fetch stock details for the email (query boxes directly so reserved boxes are found)
        const l2Request = await stockService.getStockIssuanceRequestById(requestId) as any;
        const l2Mvnos = await stockService.getMvnos();
        const l2Mvno = l2Mvnos.find((m: any) => m.id === l2Request?.mvno_id);
        let l2AssignedBoxes: any[] = [];
        const l2BoxQtys: any[] = Array.isArray(l2Request?.assigned_box_quantities) ? l2Request.assigned_box_quantities : [];
        if (l2BoxQtys.length > 0) {
          const boxIds = l2BoxQtys.map((b: any) => b.box_id).filter(Boolean);
          if (boxIds.length > 0) {
            const boxRows = await query(
              `SELECT b.id, b.box_number, c.carton_number, b.iccid_start, b.iccid_end
                 FROM boxes b LEFT JOIN cartons c ON b.carton_id = c.id
                WHERE b.id = ANY($1::uuid[])`,
              [boxIds]
            );
            const boxMap = new Map(boxRows.rows.map((r: any) => [r.id, r]));
            l2AssignedBoxes = l2BoxQtys.map((box: any) => {
              const bi: any = boxMap.get(box.box_id) || {};
              return { box_id: box.box_id, box_number: bi.box_number ? String(bi.box_number) : null,
                       carton_number: bi.carton_number || null, quantity: box.quantity,
                       iccid_start: bi.iccid_start || null, iccid_end: bi.iccid_end || null };
            });
          }
        }
        const l2AssignedEsims: string[] = Array.isArray(l2Request?.assigned_esim_iccids) ? l2Request.assigned_esim_iccids : [];

        const sent = await emailService.sendApprovalEmail(
          {
            token: level2Token.token,
            request_id: requestId,
            approver_email: level2Approver.approver_email,
            approver_role: level2Approver.approver_role || 'LEVEL_2',
            status: 'pending',
            expires_at: level2Token.expires_at,
            created_at: level2Token.created_at,
            updated_at: (level2Token as any).updated_at || level2Token.created_at,
            mvno_name: l2Mvno?.name || l2Request?.mvno_id,
            mvno_id: l2Request?.mvno_id,
            sim_type: l2Request?.sim_type,
            quantity: l2Request?.quantity,
            assigned_boxes: l2AssignedBoxes,
            assigned_esims: l2AssignedEsims,
          },
          config.app.baseUrl,
          req.headers
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

// Reset stock assignment — clears boxes/eSIMs and sets status back to PENDING
router.post('/stock/reset-assignment/:id', async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id as string;
    const { resetBy } = req.body;
    if (!requestId) return fail(res, 400, 'requestId is required');

    // Return any reserved/issued boxes back to the pool first
    const reqRow = await query(
      `SELECT assigned_box_quantities, assigned_esim_iccids FROM stock_issuance_requests WHERE id = $1`,
      [requestId]
    );
    if (!reqRow.rows[0]) return fail(res, 404, 'Request not found');

    const boxQtys: any[] = reqRow.rows[0].assigned_box_quantities || [];
    for (const bq of boxQtys) {
      if (bq.box_id) {
        await query(
          `UPDATE boxes SET status = 'AVAILABLE', reserved_quantity = 0 WHERE id = $1`,
          [bq.box_id]
        ).catch(() => {/* ignore if box table differs */});
      }
    }

    // Return eSIMs to available pool
    const esimIccids: string[] = reqRow.rows[0].assigned_esim_iccids || [];
    if (esimIccids.length > 0) {
      await query(
        `UPDATE esims SET status = 'AVAILABLE', allocated_request_id = NULL WHERE iccid = ANY($1::text[])`,
        [esimIccids]
      ).catch(() => {});
    }

    await query(
      `UPDATE stock_issuance_requests
          SET assigned_box_quantities = '[]'::jsonb,
              assigned_esim_iccids    = '[]'::jsonb,
              status                  = 'PENDING',
              updated_at              = NOW()
        WHERE id = $1`,
      [requestId]
    );

    await stockService.addAuditLog(requestId, 'ASSIGNMENT_RESET', {
      reset_by: resetBy || 'unknown',
      message: 'Stock assignment cleared — request reset to PENDING for re-assignment',
    });

    logLine('INF', 'STOCK', `Assignment reset for request ${requestId} by ${resetBy || 'unknown'}`);
    return ok(res, { message: 'Assignment cleared. Request is back in Pending for re-assignment.' });
  } catch (error: any) {
    fail(res, 500, error.message);
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
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

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

    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="pick-form-${recordId}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-cache');
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
        config.app.baseUrl,
        req.headers
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
    const {
      level, message, page, user, trace_id, user_agent,
      category, duration_ms, stack, route, event_type,
    } = req.body;
    const traceId = String(res.locals?.traceId || trace_id || 'n/a');

    const cat = String(category || 'FRONTEND').toUpperCase();
    const msgParts = [String(message || '')];
    if (route) msgParts.push(`route=${route}`);
    if (event_type) msgParts.push(`event=${event_type}`);
    if (stack) msgParts.push(`stack=${String(stack).slice(0, 300)}`);

    logLine(toLevel(level), cat, `${String(page || 'unknown')}: ${msgParts.join(' ')}`, {
      trace: traceId,
      user: user ? String(user) : undefined,
      duration_ms: duration_ms ? Number(duration_ms) : undefined,
    });

    res.json({ success: true, trace_id: traceId });
  } catch (error: any) {
    const traceId = String(res.locals?.traceId || 'n/a');
    appendUnifiedLog(`${formatLogTimestamp(new Date())} | ERR | FRONTEND     | Failed to persist frontend log: ${String(error?.message || error)}`);
    res.status(500).json({ success: false, error: error.message, trace_id: traceId });
  }
});

// Observability: summary of recent log activity for the admin dashboard
router.get('/observability/summary', async (req: Request, res: Response) => {
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    const todayKey = (() => {
      const d = new Date();
      return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    })();
    const todayLog = path.join(logsDir, `Hamilton-log-${todayKey}.txt`);
    const errorsLog = path.join(logsDir, 'errors.log');
    const auditLog = path.join(logsDir, 'audit.log');

    function readTail(filePath: string, n = 200): string[] {
      try {
        if (!fs.existsSync(filePath)) return [];
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
        return lines.slice(-n);
      } catch { return []; }
    }

    function countMatches(lines: string[], pattern: string): number {
      return lines.filter(l => l.includes(pattern)).length;
    }

    const todayLines = readTail(todayLog, 2000);
    const errorLines = readTail(errorsLog, 100);
    const auditLines = readTail(auditLog, 100);

    // Count errors today
    const errorsToday = countMatches(todayLines, '| ERR |');
    const warnsToday  = countMatches(todayLines, '| WRN |');

    // Slow requests today
    const slowRequests = todayLines.filter(l => l.includes('SLOW '));

    // Business events today
    const businessEvents = todayLines
      .filter(l => l.includes('| BUSINESS'))
      .slice(-20)
      .map(l => ({ ts: l.slice(0, 23), line: l }));

    // Recent errors (last 20)
    const recentErrors = errorLines.slice(-20).map(l => ({ ts: l.slice(0, 23), line: l }));

    // Recent audit events (last 20)
    const recentAudit = auditLines.slice(-20).map(l => ({ ts: l.slice(0, 23), line: l }));

    // Recent approvals
    const recentApprovals = todayLines
      .filter(l => l.includes('| APPROVAL') || l.includes('| BUSINESS') && l.includes('APPROVAL'))
      .slice(-10)
      .map(l => ({ ts: l.slice(0, 23), line: l }));

    // HTTP stats
    const httpLines = todayLines.filter(l => l.includes('| HTTP_RES'));
    const httpCount = httpLines.length;
    const http4xx = httpLines.filter(l => / 4\d\d/.test(l)).length;
    const http5xx = httpLines.filter(l => / 5\d\d/.test(l)).length;

    // SMTP events today
    const smtpLines = todayLines.filter(l => l.includes('| SMTP'));
    const smtpSent = smtpLines.filter(l => l.toLowerCase().includes('sent')).length;
    const smtpFailed = smtpLines.filter(l => l.toLowerCase().includes('fail')).length;

    return ok(res, {
      summary: {
        errors_today: errorsToday,
        warnings_today: warnsToday,
        http_requests_today: httpCount,
        http_4xx_today: http4xx,
        http_5xx_today: http5xx,
        smtp_sent_today: smtpSent,
        smtp_failed_today: smtpFailed,
        slow_requests_today: slowRequests.length,
        business_events_today: businessEvents.length,
      },
      recent_errors:    recentErrors,
      recent_approvals: recentApprovals,
      recent_audit:     recentAudit,
      business_events:  businessEvents,
      slow_requests:    slowRequests.slice(-10).map(l => ({ ts: l.slice(0, 23), line: l })),
    });
  } catch (error: any) {
    return fail(res, 500, error.message);
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

    // Match by distributor_id (linked record) OR distributor_email (for any requests
    // submitted before the account was properly linked)
    const emailVals: any[]  = [dist.id, jwt.email];
    const emailWhere = `(distributor_id = $1 OR LOWER(distributor_email) = LOWER($2))`;
    const extraWhere: string[] = [];
    const extraVals: any[]  = [];
    if (status) { extraWhere.push(`status = $${emailVals.length + extraVals.length + 1}`); extraVals.push(status); }

    const fullWhere = [emailWhere, ...extraWhere].join(' AND ');
    const allVals   = [...emailVals, ...extraVals];

    const countRes = await query(
      `SELECT COUNT(*) AS total FROM distributor_sim_requests WHERE ${fullWhere}`,
      allVals,
    );
    const rowsRes  = await query(
      `SELECT * FROM distributor_sim_requests WHERE ${fullWhere}
       ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      allVals,
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
    const ticket_number = String(req.body.ticket_number || '').trim();
    if (!ticket_number)                          return fail(res, 400, 'Ticket number is required');
    if (!['PHYSICAL','ESIM'].includes(sim_type)) return fail(res, 400, 'sim_type must be PHYSICAL or ESIM');
    if (!quantity || quantity <= 0)              return fail(res, 400, 'quantity must be a positive number');
    await onboardingService.assertTicketNumberIsUnused(ticket_number);

    // DISTRIBUTOR role users always resolve their own record (ignore form-supplied distributor_id
    // so that submitted requests always appear in their own history).
    // Non-distributor roles (e.g. MVNO_ADMIN using the form) may supply an explicit distributor_id.
    let dist: any = null;
    if (jwt.role !== 'DISTRIBUTOR' && req.body.distributor_id) {
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
         (reference_no, distributor_id, distributor_email, mvno_id, mvno_name, sim_type, quantity, notes, ticket_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [ref, dist.id, jwt.email, dist.mvno_id, dist.mvno_name, sim_type, quantity, notes, ticket_number],
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

// ==================== COMPANY ONBOARDING (Phase 2) ====================

function requireAuth(req: Request): { id: string; email: string; role: string; full_name?: string } | null {
  return (req as any).auth || null;
}

function requireAuthResponse(res: Response, auth: any, role?: string) {
  if (!auth) return fail(res, 401, 'Authentication required');
  if (role && auth.role !== role) return fail(res, 403, `${role} access required`);
  return null;
}

const ENTITY_TYPES = [
  'COMPANY', 'NGO', 'TRUST', 'COOPERATIVE', 'MDA_GOVERNMENT',
  'POLITICAL_PARTY', 'FOREIGN_MISSION', 'REGIONAL_INTERNATIONAL_ORG',
];

const PARTNERSHIP_TYPES = ['SIM_DISTRIBUTOR', 'MOBILE_MONEY_DISTRIBUTOR', 'ORDINARY'];

// Reference data
router.get('/onboarding/entity-types', (_req: Request, res: Response) => ok(res, ENTITY_TYPES));
router.get('/onboarding/partnership-types', (_req: Request, res: Response) => ok(res, PARTNERSHIP_TYPES));

// Document checklist for a given entity type + partnership selection
router.get('/onboarding/document-checklist', async (req: Request, res: Response) => {
  try {
    const entityType = String(req.query.entityType || '').toUpperCase() as any;
    const partnershipTypes = String(req.query.partnershipTypes || '')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean) as any;
    if (!ENTITY_TYPES.includes(entityType)) return fail(res, 400, 'Valid entityType is required');
    const checklist = await onboardingService.getDocumentChecklistForCompany(entityType, partnershipTypes);
    return ok(res, checklist);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Search fee for a given entity type
router.get('/onboarding/search-fee', async (req: Request, res: Response) => {
  try {
    const entityType = String(req.query.entityType || '').toUpperCase() as any;
    if (!ENTITY_TYPES.includes(entityType)) return fail(res, 400, 'Valid entityType is required');
    const fee = await onboardingService.getSearchFeeSetting(entityType);
    return ok(res, fee);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Submit a new company onboarding request
router.post('/onboarding/companies', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');

    const input = req.body as onboardingService.CompanySubmissionInput;
    if (!input.ticket_number || !String(input.ticket_number).trim()) {
      return fail(res, 400, 'Ticket number is required');
    }
    if (!input.entity_type || !input.name || !input.physical_address || !input.company_email || !input.company_phone || !input.contact_name || !input.contact_phone || !input.contact_email || !input.contact_nin_passport) {
      return fail(res, 400, 'Required company fields missing');
    }
    if (!input.partnership_types || !Array.isArray(input.partnership_types) || input.partnership_types.length === 0) {
      return fail(res, 400, 'At least one partnership type is required');
    }

    const company = await onboardingService.submitCompany({
      ...input,
      created_by: auth.email,
    });
    return ok(res, company, 'Company onboarding request submitted');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// List company onboarding requests (Super Admin)
router.get('/onboarding/companies', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const result = await onboardingService.getCompanies({
      status: req.query.status as string,
      entityType: req.query.entityType as string,
      partnershipType: req.query.partnershipType as string,
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    return ok(res, result);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Get company onboarding details (Super Admin)
router.get('/onboarding/companies/:id', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const company = await onboardingService.getCompanyById(req.params.id as string);
    if (!company) return fail(res, 404, 'Company not found');
    return ok(res, company);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Update a company document tick/file (Super Admin)
router.post('/onboarding/companies/:id/documents', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const { document_key, ticked, file_url, file_name, ticked_by } = req.body;
    if (!document_key) return fail(res, 400, 'document_key required');

    const updated = await onboardingService.updateCompanyDocument(
      req.params.id as string,
      document_key,
      { ticked, file_url, file_name, ticked_by: ticked_by || auth.email },
      auth.email
    );
    if (!updated) return fail(res, 404, 'Document not found');
    return ok(res, updated, 'Document updated');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Approve a company approval seat (Super Admin)
router.post('/onboarding/companies/:id/approve', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const { seat_order, approver_email } = req.body;
    if (!seat_order || !approver_email) return fail(res, 400, 'seat_order and approver_email required');

    const company = await onboardingService.approveCompanySeat(
      req.params.id as string,
      parseInt(seat_order),
      approver_email,
      auth.email
    );
    return ok(res, company, 'Approval seat approved');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Reject a company approval seat (Super Admin)
router.post('/onboarding/companies/:id/reject', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const { seat_order, approver_email, reason } = req.body;
    if (!seat_order || !approver_email || !reason) return fail(res, 400, 'seat_order, approver_email, and reason required');

    const company = await onboardingService.rejectCompany(
      req.params.id as string,
      parseInt(seat_order),
      approver_email,
      reason,
      auth.email
    );
    return ok(res, company, 'Company request rejected');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// -------------------- KYC SIM Agent onboarding (Phase 3) --------------------

// KYC agent document checklist (public reference data)
router.get('/onboarding/kyc-agents/checklist', async (_req: Request, res: Response) => {
  try {
    const checklist = await onboardingService.getKycAgentChecklist();
    return ok(res, checklist);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Submit a new KYC SIM agent (any authenticated field user)
router.post('/onboarding/kyc-agents', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');

    const input = req.body as onboardingService.KycAgentSubmissionInput;
    if (!input.ticket_number?.trim()) return fail(res, 400, 'ticket_number is required');
    if (!input.distributor_id) return fail(res, 400, 'distributor_id is required');
    if (!input.surname?.trim() || !input.given_names?.trim() || !input.phone?.trim()) {
      return fail(res, 400, 'Surname, given names, and phone are required');
    }
    if (!input.district?.trim() || !input.county?.trim() || !input.subcounty?.trim() || !input.parish?.trim() || !input.village?.trim()) {
      return fail(res, 400, 'District, county, subcounty, parish, and village are required');
    }
    if (input.reg_point_lat == null || input.reg_point_lng == null) return fail(res, 400, 'Registration point GPS coordinates are required');

    const agent = await onboardingService.submitKycAgent({ ...input, created_by: auth.email });
    return ok(res, agent, 'KYC agent submitted');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// List KYC agents (Super Admin)
router.get('/onboarding/kyc-agents', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const result = await onboardingService.getKycAgents({
      status: req.query.status as string,
      distributorId: req.query.distributorId as string,
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    return ok(res, result);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Get KYC agent detail (Super Admin)
router.get('/onboarding/kyc-agents/:id', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const agent = await onboardingService.getKycAgentById(req.params.id as string);
    if (!agent) return fail(res, 404, 'KYC agent not found');
    return ok(res, agent);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Update a KYC agent document tick/file (Super Admin)
router.post('/onboarding/kyc-agents/:id/documents', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const { document_key, ticked, file_url, file_name, ticked_by } = req.body;
    if (!document_key) return fail(res, 400, 'document_key required');

    const updated = await onboardingService.updateKycAgentDocument(
      req.params.id as string,
      document_key,
      { ticked, file_url, file_name, ticked_by: ticked_by || auth.email },
      auth.email
    );
    if (!updated) return fail(res, 404, 'Document not found');
    return ok(res, updated, 'Document updated');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Approve a KYC agent (Super Admin)
router.post('/onboarding/kyc-agents/:id/approve', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const agent = await onboardingService.approveKycAgent(req.params.id as string, auth.email);
    return ok(res, agent, 'KYC agent approved');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Reject a KYC agent (Super Admin)
router.post('/onboarding/kyc-agents/:id/reject', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const { reason } = req.body;
    if (!reason) return fail(res, 400, 'reason required');

    const agent = await onboardingService.rejectKycAgent(req.params.id as string, reason, auth.email);
    return ok(res, agent, 'KYC agent rejected');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// -------------------- Mobile Money Agent onboarding (Phase 3B) --------------------
// Distinct entity from KYC SIM agents above — tracked in its own mm_agents table.

// Mobile Money agent document checklist (public reference data)
router.get('/onboarding/mm-agents/checklist', async (_req: Request, res: Response) => {
  try {
    const checklist = await onboardingService.getMmAgentChecklist();
    return ok(res, checklist);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Submit a new Mobile Money agent (any authenticated field user)
router.post('/onboarding/mm-agents', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');

    const input = req.body as onboardingService.MmAgentSubmissionInput;
    if (!input.ticket_number?.trim()) return fail(res, 400, 'ticket_number is required');
    if (!input.distributor_id) return fail(res, 400, 'distributor_id is required');
    if (!input.outlet_name?.trim()) return fail(res, 400, 'Outlet name is required');
    if (!input.first_name?.trim() || !input.last_name?.trim() || !input.phone?.trim()) {
      return fail(res, 400, 'First name, last name, and phone are required');
    }
    if (!input.district?.trim() || !input.village?.trim()) return fail(res, 400, 'District and village are required');
    if (input.reg_point_lat == null || input.reg_point_lng == null) return fail(res, 400, 'Registration point GPS coordinates are required');

    const agent = await onboardingService.submitMmAgent({ ...input, created_by: auth.email });
    return ok(res, agent, 'Mobile Money agent submitted');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// List Mobile Money agents (Super Admin)
router.get('/onboarding/mm-agents', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const result = await onboardingService.getMmAgents({
      status: req.query.status as string,
      distributorId: req.query.distributorId as string,
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    return ok(res, result);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Get Mobile Money agent detail (Super Admin)
router.get('/onboarding/mm-agents/:id', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const agent = await onboardingService.getMmAgentById(req.params.id as string);
    if (!agent) return fail(res, 404, 'Mobile Money agent not found');
    return ok(res, agent);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Update a Mobile Money agent document tick/file (Super Admin)
router.post('/onboarding/mm-agents/:id/documents', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const { document_key, ticked, file_url, file_name, ticked_by } = req.body;
    if (!document_key) return fail(res, 400, 'document_key required');

    const updated = await onboardingService.updateMmAgentDocument(
      req.params.id as string,
      document_key,
      { ticked, file_url, file_name, ticked_by: ticked_by || auth.email },
      auth.email
    );
    if (!updated) return fail(res, 404, 'Document not found');
    return ok(res, updated, 'Document updated');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Approve a Mobile Money agent (Super Admin)
router.post('/onboarding/mm-agents/:id/approve', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const agent = await onboardingService.approveMmAgent(req.params.id as string, auth.email);
    return ok(res, agent, 'Mobile Money agent approved');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// Reject a Mobile Money agent (Super Admin)
router.post('/onboarding/mm-agents/:id/reject', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const { reason } = req.body;
    if (!reason) return fail(res, 400, 'reason required');

    const agent = await onboardingService.rejectMmAgent(req.params.id as string, reason, auth.email);
    return ok(res, agent, 'Mobile Money agent rejected');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// -------------------- Mobile Money Distributor onboarding (Phase 3C) --------------------

router.get('/onboarding/mm-distributors', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');
    const result = await onboardingService.getMmDistributors({
      status: req.query.status as string,
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    return ok(res, result);
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.get('/onboarding/mm-distributors/:id', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');
    const distributor = await onboardingService.getMmDistributorById(req.params.id as string);
    if (!distributor) return fail(res, 404, 'Mobile Money distributor not found');
    return ok(res, distributor);
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.post('/onboarding/mm-distributors', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    const input = req.body as onboardingService.MmDistributorSubmissionInput;
    if (!input.ticket_number?.trim()) return fail(res, 400, 'ticket_number is required');
    const distributor = await onboardingService.submitMmDistributor({ ...input, created_by: auth.email });
    return ok(res, distributor, 'Mobile Money distributor submitted');
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.post('/onboarding/mm-distributors/:id/approve', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');
    const distributor = await onboardingService.approveMmDistributor(req.params.id as string, auth.email);
    return ok(res, distributor, 'Mobile Money distributor approved');
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.post('/onboarding/mm-distributors/:id/reject', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');
    const { reason } = req.body;
    if (!reason) return fail(res, 400, 'reason required');
    const distributor = await onboardingService.rejectMmDistributor(req.params.id as string, reason, auth.email);
    return ok(res, distributor, 'Mobile Money distributor rejected');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// -------------------- Merchant onboarding (Phase 3D) --------------------

router.get('/onboarding/merchants/checklist', async (_req: Request, res: Response) => {
  try {
    const checklist = await onboardingService.getMerchantChecklist();
    return ok(res, checklist);
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.get('/onboarding/merchants', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');
    const result = await onboardingService.getMerchants({
      status: req.query.status as string,
      merchantType: req.query.merchantType as string,
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    return ok(res, result);
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.get('/onboarding/merchants/:id', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');
    const merchant = await onboardingService.getMerchantById(req.params.id as string);
    if (!merchant) return fail(res, 404, 'Merchant not found');
    return ok(res, merchant);
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.post('/onboarding/merchants', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    const input = req.body as onboardingService.MerchantSubmissionInput;
    if (!input.ticket_number?.trim()) return fail(res, 400, 'ticket_number is required');
    const merchant = await onboardingService.submitMerchant({ ...input, created_by: auth.email });
    return ok(res, merchant, 'Merchant onboarding request submitted');
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.post('/onboarding/merchants/:id/documents', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');
    const { document_key, ticked, file_url, file_name, ticked_by } = req.body;
    if (!document_key) return fail(res, 400, 'document_key required');
    const updated = await onboardingService.updateMerchantDocument(
      req.params.id as string,
      document_key,
      { ticked, file_url, file_name, ticked_by: ticked_by || auth.email },
      auth.email
    );
    if (!updated) return fail(res, 404, 'Document not found');
    return ok(res, updated, 'Document updated');
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.post('/onboarding/merchants/:id/approve', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');
    const merchant = await onboardingService.approveMerchant(req.params.id as string, auth.email);
    return ok(res, merchant, 'Merchant approved');
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.post('/onboarding/merchants/:id/reject', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');
    const { reason } = req.body;
    if (!reason) return fail(res, 400, 'reason required');
    const merchant = await onboardingService.rejectMerchant(req.params.id as string, reason, auth.email);
    return ok(res, merchant, 'Merchant rejected');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// -------------------- Authenticated document preview/download (Super Admin) --------------------
// Serves onboarding documents (KYC/company/agent/merchant) through an authenticated
// endpoint instead of the raw, unauthenticated `/uploads` static route, so the
// in-portal DocumentViewer can enforce access control. Reuses the same 4 document
// tables already used by the onboarding review endpoints above.

const DOCUMENT_TABLE_BY_ENTITY: Record<string, string> = {
  'company': 'company_documents',
  'kyc-agent': 'kyc_agent_documents',
  'mm-agent': 'mm_agent_documents',
  'merchant': 'merchant_documents',
};

const DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Resolve a stored `/uploads/...` file_url to an absolute path, refusing to
 *  serve anything outside the uploads directory (defense in depth against
 *  path traversal, even though filenames are opaque content hashes). */
function resolveUploadedFilePath(fileUrl: string): string | null {
  if (!fileUrl.startsWith('/uploads/')) return null;
  const uploadsRoot = path.join(process.cwd(), 'uploads');
  const resolved = path.normalize(path.join(process.cwd(), fileUrl));
  if (!resolved.startsWith(uploadsRoot)) return null;
  return resolved;
}

function streamStoredFile(res: Response, absolutePath: string, fileName: string | null, download: boolean) {
  if (!fs.existsSync(absolutePath)) return fail(res, 404, 'File not found on disk');
  const stat = fs.statSync(absolutePath);
  const ext = path.extname(fileName || absolutePath).toLowerCase();
  const contentType = DOCUMENT_MIME_BY_EXT[ext] || 'application/octet-stream';
  const safeName = (fileName || path.basename(absolutePath)).replace(/"/g, '');

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'private, no-cache');
  fs.createReadStream(absolutePath).pipe(res);
}

router.get('/onboarding/documents/:entityType/:documentId/preview', async (req: Request, res: Response) => {
  try {
    const auth = requireAuth(req);
    if (!auth) return fail(res, 401, 'Authentication required');
    if (auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'SUPER_ADMIN access required');

    const table = DOCUMENT_TABLE_BY_ENTITY[req.params.entityType as string];
    if (!table) return fail(res, 400, 'Invalid entity type');

    const { rows } = await query<{ file_url: string | null; file_name: string | null }>(
      `SELECT file_url, file_name FROM ${table} WHERE id = $1`,
      [req.params.documentId]
    );
    const doc = rows[0];
    if (!doc) return fail(res, 404, 'Document not found');
    if (!doc.file_url) return fail(res, 404, 'No file uploaded for this document');

    const absolutePath = resolveUploadedFilePath(doc.file_url);
    if (!absolutePath) return fail(res, 410, 'Document is no longer available at its stored location');

    streamStoredFile(res, absolutePath, doc.file_name, req.query.download === '1');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ==================== MVNO SETTINGS & REPORTS (used by main app) ====================
// These endpoints back the "MVNO Settings" and "Reports" tabs in the unified
// Super Admin / MVNO Admin app (frontend/src/components/MvnoSettings.tsx and
// MvnoReports.tsx). Kept after paxtel-admin removal because they are consumed
// directly by the live frontend, not by the deleted standalone admin app.

/** Middleware helper: verify JWT is MVNO_ADMIN/MANAGEMENT/SUPER_ADMIN and return payload, else 401/403 */
function requireMvnoAdmin(req: Request, res: Response): Record<string, any> | null {
  const jwt = getJwtPayload(req);
  if (!jwt) { fail(res, 401, 'Authentication required'); return null; }
  if (jwt.role !== 'MVNO_ADMIN' && jwt.role !== 'SUPER_ADMIN' && jwt.role !== 'MANAGEMENT') {
    fail(res, 403, 'Access denied — MVNO Admin role required');
    return null;
  }
  return jwt;
}

function resolveMvnoId(jwt: Record<string,any>, query_mvno?: string): string {
  if ((jwt.role === 'SUPER_ADMIN' || jwt.role === 'MANAGEMENT') && query_mvno) return String(query_mvno);
  return jwt.mvno_id as string;
}

// ── GET /api/mvno-admin/settings ──────────────────────────────────────────────
router.get('/mvno-admin/settings', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const mvnoId = resolveMvnoId(jwt, req.query.mvno_id as string);
    if (!mvnoId) return ok(res, { mvnoConfig: {}, notifConfig: {} });

    const mvnoSet = await query(`SELECT * FROM mvno_settings WHERE mvno_id = $1`, [mvnoId]);
    const row = mvnoSet.rows[0] || {};
    return ok(res, { mvnoConfig: row, notifConfig: row });
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ── POST /api/mvno-admin/settings/mvno ────────────────────────────────────────
router.post('/mvno-admin/settings/mvno', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const targetMvnoId = resolveMvnoId(jwt, req.body.mvno_id);
    if (!targetMvnoId) return fail(res, 400, 'MVNO ID required');

    const {
      lowStockThresholdPhysical, lowStockThresholdEsim, autoApproveThreshold,
      escalationEnabled, escalationDelayHours,
      workingHoursStart, workingHoursEnd, timezone,
    } = req.body;

    await query(
      `INSERT INTO mvno_settings
         (mvno_id, low_stock_threshold_physical, low_stock_threshold_esim,
          auto_approve_threshold, escalation_enabled, escalation_delay_hours,
          working_hours_start, working_hours_end, timezone, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (mvno_id) DO UPDATE SET
         low_stock_threshold_physical = EXCLUDED.low_stock_threshold_physical,
         low_stock_threshold_esim     = EXCLUDED.low_stock_threshold_esim,
         auto_approve_threshold       = EXCLUDED.auto_approve_threshold,
         escalation_enabled           = EXCLUDED.escalation_enabled,
         escalation_delay_hours       = EXCLUDED.escalation_delay_hours,
         working_hours_start          = EXCLUDED.working_hours_start,
         working_hours_end            = EXCLUDED.working_hours_end,
         timezone                     = EXCLUDED.timezone,
         updated_at                   = NOW()`,
      [targetMvnoId,
       lowStockThresholdPhysical ?? 5000, lowStockThresholdEsim ?? 2000,
       autoApproveThreshold ?? 100, escalationEnabled ?? true,
       escalationDelayHours ?? 24, workingHoursStart ?? '09:00',
       workingHoursEnd ?? '17:00', timezone ?? 'Africa/Kampala']
    );

    const io = getIo();
    io?.to(`mvno:${targetMvnoId}`).emit('mvno_admin:settings_updated', { mvno_id: targetMvnoId });

    return ok(res, { mvno_id: targetMvnoId }, 'MVNO settings saved');
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ── POST /api/mvno-admin/settings/notifications ───────────────────────────────
router.post('/mvno-admin/settings/notifications', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const targetMvnoId = resolveMvnoId(jwt, req.body.mvno_id);
    if (!targetMvnoId) return fail(res, 400, 'MVNO ID required');

    const {
      emailNotifications, smsNotifications,
      lowStockAlerts, requestAlerts, approvalAlerts, escalationAlerts,
    } = req.body;

    await query(
      `INSERT INTO mvno_settings
         (mvno_id, email_notifications, sms_notifications,
          low_stock_alerts, request_alerts, approval_alerts, escalation_alerts, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (mvno_id) DO UPDATE SET
         email_notifications = EXCLUDED.email_notifications,
         sms_notifications   = EXCLUDED.sms_notifications,
         low_stock_alerts    = EXCLUDED.low_stock_alerts,
         request_alerts      = EXCLUDED.request_alerts,
         approval_alerts     = EXCLUDED.approval_alerts,
         escalation_alerts   = EXCLUDED.escalation_alerts,
         updated_at          = NOW()`,
      [targetMvnoId,
       emailNotifications ?? true, smsNotifications ?? false,
       lowStockAlerts ?? true, requestAlerts ?? true,
       approvalAlerts ?? true, escalationAlerts ?? true]
    );

    const io = getIo();
    io?.to(`mvno:${targetMvnoId}`).emit('mvno_admin:settings_updated', { mvno_id: targetMvnoId });

    return ok(res, { mvno_id: targetMvnoId }, 'Notification settings saved');
  } catch (e: any) { return fail(res, 500, e.message); }
});

/** Build report rows + summary for a given report type. Shared by generate/export. */
async function buildMvnoReport(type: string, mvnoId: string, filters: { dateFrom?: string; dateTo?: string }): Promise<{ rows: any[]; summary: Record<string, any> }> {
  const { dateFrom, dateTo } = filters;

  if (type === 'stock-summary') {
    const [physRes, esimRes] = await Promise.all([
      query(`SELECT
               COALESCE(SUM(total_sims),0)::int    AS total_received,
               COALESCE(SUM(total_sims - COALESCE(issued_sims,0)),0)::int AS available,
               COALESCE(SUM(COALESCE(issued_sims,0)),0)::int AS distributed
             FROM boxes b JOIN cartons c ON c.id = b.carton_id WHERE c.mvno_id = $1`, [mvnoId]),
      query(`SELECT
               COUNT(*)::int AS total_received,
               COUNT(*) FILTER (WHERE status='available')::int  AS available,
               COUNT(*) FILTER (WHERE status='distributed')::int AS activated
             FROM esim_stock WHERE mvno_id = $1`, [mvnoId]),
    ]);
    const rows = [
      { metric: 'Physical — Total Received', value: physRes.rows[0]?.total_received ?? 0 },
      { metric: 'Physical — Available',      value: physRes.rows[0]?.available ?? 0 },
      { metric: 'Physical — Distributed',    value: physRes.rows[0]?.distributed ?? 0 },
      { metric: 'eSIM — Total Received',     value: esimRes.rows[0]?.total_received ?? 0 },
      { metric: 'eSIM — Available',          value: esimRes.rows[0]?.available ?? 0 },
      { metric: 'eSIM — Activated',          value: esimRes.rows[0]?.activated ?? 0 },
    ];
    return { rows, summary: { ...physRes.rows[0], ...esimRes.rows[0] } };
  }

  if (type === 'distributor-performance') {
    const conds: string[] = ['dsr.mvno_id = $1'];
    const params: any[] = [mvnoId]; let pi = 2;
    if (dateFrom) { conds.push(`dsr.created_at >= $${pi++}::date`); params.push(dateFrom); }
    if (dateTo)   { conds.push(`dsr.created_at < ($${pi++}::date + INTERVAL '1 day')`); params.push(dateTo); }
    const dataRes = await query(`
      SELECT COALESCE(d.name,'Unknown') AS distributor_name,
             COUNT(*)::int AS total_requests,
             COUNT(*) FILTER (WHERE dsr.status IN ('APPROVED','COMPLETED'))::int AS approved,
             COUNT(*) FILTER (WHERE dsr.status = 'REJECTED')::int AS rejected,
             COALESCE(SUM(dsr.quantity) FILTER (WHERE dsr.status IN ('APPROVED','COMPLETED')),0)::int AS total_sims_received
      FROM distributor_sim_requests dsr
      LEFT JOIN distributors d ON d.id = dsr.distributor_id
      WHERE ${conds.join(' AND ')}
      GROUP BY d.name ORDER BY total_requests DESC`, params);
    return { rows: dataRes.rows, summary: { distributors: dataRes.rows.length } };
  }

  if (type === 'monthly-trends') {
    const dataRes = await query(`
      SELECT TO_CHAR(date_trunc('month', dsr.created_at), 'YYYY-MM') AS month,
             COUNT(*)::int AS requests_submitted,
             COUNT(*) FILTER (WHERE dsr.status IN ('APPROVED','COMPLETED'))::int AS requests_approved,
             COALESCE(SUM(dsr.quantity) FILTER (WHERE dsr.sim_type='PHYSICAL' AND dsr.status IN ('APPROVED','COMPLETED')),0)::int AS physical_distributed,
             COALESCE(SUM(dsr.quantity) FILTER (WHERE dsr.sim_type='ESIM'     AND dsr.status IN ('APPROVED','COMPLETED')),0)::int AS esim_distributed
      FROM distributor_sim_requests dsr
      WHERE dsr.mvno_id = $1 AND dsr.created_at >= NOW() - INTERVAL '12 months'
      GROUP BY 1 ORDER BY 1 DESC`, [mvnoId]);
    return { rows: dataRes.rows, summary: { months: dataRes.rows.length } };
  }

  if (type === 'replenishment-history') {
    const conds: string[] = ['dsr.mvno_id = $1'];
    const params: any[] = [mvnoId]; let pi = 2;
    if (dateFrom) { conds.push(`dsr.created_at >= $${pi++}::date`); params.push(dateFrom); }
    if (dateTo)   { conds.push(`dsr.created_at < ($${pi++}::date + INTERVAL '1 day')`); params.push(dateTo); }
    const dataRes = await query(`
      SELECT dsr.reference_no, COALESCE(d.name,'Unknown') AS distributor_name,
             dsr.sim_type, dsr.quantity, dsr.status, dsr.created_at
      FROM distributor_sim_requests dsr
      LEFT JOIN distributors d ON d.id = dsr.distributor_id
      WHERE ${conds.join(' AND ')} ORDER BY dsr.created_at DESC`, params);
    return { rows: dataRes.rows, summary: { total: dataRes.rows.length } };
  }

  if (type === 'escalation-report') {
    const conds: string[] = [`dsr.mvno_id = $1`, `dsr.status = 'ESCALATED'`];
    const params: any[] = [mvnoId]; let pi = 2;
    if (dateFrom) { conds.push(`dsr.created_at >= $${pi++}::date`); params.push(dateFrom); }
    if (dateTo)   { conds.push(`dsr.created_at < ($${pi++}::date + INTERVAL '1 day')`); params.push(dateTo); }
    const dataRes = await query(`
      SELECT dsr.reference_no, COALESCE(d.name,'Unknown') AS distributor,
             dsr.created_at AS escalated_at, dsr.reviewed_at AS resolved_at, dsr.reviewed_by AS resolved_by
      FROM distributor_sim_requests dsr
      LEFT JOIN distributors d ON d.id = dsr.distributor_id
      WHERE ${conds.join(' AND ')} ORDER BY dsr.created_at DESC`, params);
    return { rows: dataRes.rows, summary: { escalations: dataRes.rows.length } };
  }

  return { rows: [], summary: {} };
}

// ── POST /api/mvno-admin/reports/generate ─────────────────────────────────────
router.post('/mvno-admin/reports/generate', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const { type, filters, mvno_id } = req.body;
    const mvnoId = resolveMvnoId(jwt, mvno_id);
    if (!mvnoId) return fail(res, 400, 'MVNO ID required');
    if (!type) return fail(res, 400, 'Report type required');

    const data = await buildMvnoReport(String(type), mvnoId, filters || {});
    return ok(res, data);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ── GET /api/mvno-admin/reports/export ────────────────────────────────────────
router.get('/mvno-admin/reports/export', async (req: Request, res: Response) => {
  try {
    const jwt = requireMvnoAdmin(req, res);
    if (!jwt) return;
    const type     = String(req.query.type || '');
    const format   = String(req.query.format || 'csv').toLowerCase();
    const mvnoId   = resolveMvnoId(jwt, req.query.mvno_id as string);
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : undefined;
    const dateTo   = req.query.dateTo   ? String(req.query.dateTo)   : undefined;
    if (!mvnoId) return fail(res, 400, 'MVNO ID required');
    if (!type)   return fail(res, 400, 'Report type required');

    const { rows } = await buildMvnoReport(type, mvnoId, { dateFrom, dateTo });

    if (format === 'excel') {
      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(type);
      if (rows.length) {
        sheet.columns = Object.keys(rows[0]).map(k => ({ header: k.replace(/_/g, ' ').toUpperCase(), key: k }));
        rows.forEach((r: any) => sheet.addRow(r));
      }
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${type}.xlsx"`);
      await workbook.xlsx.write(res);
      return res.end();
    }

    const headers = rows.length ? Object.keys(rows[0]) : [];
    const csv = [headers.join(',')]
      .concat(rows.map((r: any) => headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}.csv"`);
    return res.send(csv);
  } catch (e: any) { return fail(res, 500, e.message); }
});

// ==================== STRAY STOCK ROUTES ====================

router.get('/stray-stock', async (req: Request, res: Response) => {
  try {
    const data = await stockService.getStrayStock();
    return ok(res, data);
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.post('/stray-stock', async (req: Request, res: Response) => {
  try {
    const { iccid, msisdn, mvno_id, reason, marked_by, marked_by_email, notes } = req.body || {};
    const result = await stockService.markAsStray({
      iccid: String(iccid || ''),
      msisdn,
      mvno_id,
      reason,
      marked_by: marked_by ? String(marked_by) : undefined,
      marked_by_email: marked_by_email ? String(marked_by_email) : undefined,
      notes: notes ? String(notes) : undefined,
    });
    if (!result.success) return fail(res, 400, result.error || 'Failed to mark as stray');
    return ok(res, { id: result.id }, 'Marked as stray');
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.put('/stray-stock/:id/return', async (req: Request, res: Response) => {
  try {
    const result = await stockService.returnStrayToPool(String(req.params.id));
    if (!result.success) return fail(res, 400, result.error || 'Failed to return to pool');
    return ok(res, {}, 'Returned to pool');
  } catch (e: any) { return fail(res, 500, e.message); }
});

router.put('/stray-stock/:id/write-off', async (req: Request, res: Response) => {
  try {
    const result = await stockService.writeOffStray(String(req.params.id));
    if (!result.success) return fail(res, 400, result.error || 'Failed to write off');
    return ok(res, {}, 'Written off');
  } catch (e: any) { return fail(res, 500, e.message); }
});

export default router;

