import { v4 as uuidv4, v5 as uuidv5, validate as validateUuid } from 'uuid';
import { randomBytes } from 'crypto';
import type { PoolClient } from 'pg';
import { query, transaction } from '../config/database.js';
import { logLine } from '../logging/unified-logger.js';

// UUID validation helper function
function isValidUUID(id: string): boolean {
  return validateUuid(id);
}

function normalizeIccid(value: any): string {
  return String(value || '').trim();
}

// eSIM ordering rule:
// - First 19 digits are sequential
// - Final digit is an operator suffix
function compareEsimIccids(aRaw: any, bRaw: any): number {
  const a = normalizeIccid(aRaw);
  const b = normalizeIccid(bRaw);
  const aPrefix = a.slice(0, 19);
  const bPrefix = b.slice(0, 19);
  const prefixCmp = aPrefix.localeCompare(bPrefix);
  if (prefixCmp !== 0) return prefixCmp;
  return a.slice(19).localeCompare(b.slice(19));
}

function sortEsimIccids(values: any[]): string[] {
  const sorted = (Array.isArray(values) ? values : [])
    .map(normalizeIccid)
    .filter(Boolean)
    .sort(compareEsimIccids);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of sorted) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Stable namespace for deterministic idempotency keys (NOT a secret)
const PROVISION_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

let provisioningSchemaReady = false;
let provisioningSchemaPromise: Promise<void> | null = null;

async function ensureProvisioningSchema(): Promise<void> {
  if (provisioningSchemaReady) {
    return;
  }

  if (provisioningSchemaPromise) {
    await provisioningSchemaPromise;
    return;
  }

  provisioningSchemaPromise = (async () => {
    await query(
      `ALTER TABLE IF EXISTS boxes
         ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`
    );

    await query(
      `CREATE TABLE IF NOT EXISTS sim_stock (
        id SERIAL PRIMARY KEY,
        box_id UUID UNIQUE NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
        mvno_id UUID REFERENCES mvnos(id),
        mvno TEXT,
        carton_number TEXT NOT NULL,
        box_number TEXT NOT NULL,
        iccid_start VARCHAR(25),
        iccid_end VARCHAR(25),
        total_sims INT NOT NULL DEFAULT 0,
        assigned_sims INT NOT NULL DEFAULT 0,
        current_owner TEXT,
        status TEXT NOT NULL DEFAULT 'AVAILABLE',
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_sim_stock_carton_box
         ON sim_stock (carton_number, box_number)`
    );

    await query(
      `CREATE TABLE IF NOT EXISTS distribution_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID NOT NULL,
        distributor_id UUID REFERENCES distributors(id),
        mvno_id UUID REFERENCES mvnos(id),
        sim_type TEXT NOT NULL,
        carton_number TEXT,
        box_number TEXT,
        box_id UUID REFERENCES boxes(id),
        sim_count INT NOT NULL,
        purpose TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );

    await query(
      `ALTER TABLE IF EXISTS sim_stock
         ADD COLUMN IF NOT EXISTS iccid_start VARCHAR(25)`
    );

    await query(
      `ALTER TABLE IF EXISTS sim_stock
         ADD COLUMN IF NOT EXISTS iccid_end VARCHAR(25)`
    );

    await query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM pg_constraint WHERE conname = 'distribution_history_request_id_key'
         ) THEN
           ALTER TABLE distribution_history
             DROP CONSTRAINT distribution_history_request_id_key;
         END IF;
       END $$;`
    );

    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_distribution_history_request_box
         ON distribution_history (
           request_id,
           sim_type,
           COALESCE(box_id, '00000000-0000-0000-0000-000000000000'::uuid),
           COALESCE(carton_number, ''),
           COALESCE(box_number, '')
         )`
    );

    await ensureDistributionFunctionsCompatibility();

    // Data repair: legacy `distribute_esims` versions inserted placeholder rows into
    // box_pick_records with NULL box_id. Physical distributions should always have a box_id,
    // and eSIM distributions are sourced from pick_history only.
    await query(
      `DO $$
       BEGIN
         IF to_regclass('public.box_pick_records') IS NOT NULL THEN
           DELETE FROM box_pick_records WHERE box_id IS NULL;
         END IF;
       END $$;`
    );

    // Best-effort backfill for sim_stock from legacy tables
    await query(
      `INSERT INTO sim_stock (
         box_id, mvno_id, mvno, carton_number, box_number, iccid_start, iccid_end, total_sims, assigned_sims, current_owner, status, last_updated
       )
       SELECT
         b.id,
         c.mvno_id,
         m.name::text,
         c.carton_number::text,
         b.box_number::text,
         b.iccid_start::text,
         b.iccid_end::text,
         COALESCE(b.total_sims, 0)::int,
         COALESCE(b.issued_sims, 0)::int,
         NULL::text,
         CASE WHEN COALESCE(b.remaining_sims, 0) <= 0 THEN 'ASSIGNED' ELSE 'AVAILABLE' END::text,
         COALESCE(b.updated_at, b.created_at, NOW())
       FROM boxes b
       JOIN cartons c ON b.carton_id = c.id
       LEFT JOIN mvnos m ON c.mvno_id = m.id
       WHERE TRUE
       ON CONFLICT (box_id) DO UPDATE
       SET mvno_id = EXCLUDED.mvno_id,
           mvno = EXCLUDED.mvno,
           carton_number = EXCLUDED.carton_number,
           box_number = EXCLUDED.box_number,
           iccid_start = EXCLUDED.iccid_start,
           iccid_end = EXCLUDED.iccid_end,
           total_sims = EXCLUDED.total_sims,
           assigned_sims = EXCLUDED.assigned_sims,
           last_updated = EXCLUDED.last_updated`
    );

    provisioningSchemaReady = true;
  })();

  try {
    await provisioningSchemaPromise;
  } finally {
    provisioningSchemaPromise = provisioningSchemaReady ? provisioningSchemaPromise : null;
  }
}

async function ensureDistributionFunctionsCompatibility(): Promise<void> {
  await query(
    `CREATE OR REPLACE FUNCTION distribute_esims(
      p_distributor_id UUID,
      p_mvno_id UUID,
      p_iccids TEXT[],
      p_purpose TEXT DEFAULT NULL
    )
    RETURNS TABLE(success BOOLEAN, message TEXT, distributed_count INTEGER)
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_distribution_id UUID := gen_random_uuid();
      v_count INTEGER := 0;
      v_iccid TEXT;
      v_operator TEXT;
    BEGIN
      SELECT m.name INTO v_operator FROM mvnos m WHERE m.id = p_mvno_id;

      BEGIN
        FOR v_iccid IN SELECT unnest(p_iccids) LOOP
          IF NOT EXISTS (
            SELECT 1 FROM esim_stock
            WHERE iccid = v_iccid
              AND status IN ('IN_STOCK', 'available', 'IN_STORE')
          ) THEN
            RETURN QUERY SELECT FALSE, 'ICCID ' || v_iccid || ' is not available', 0;
            RETURN;
          END IF;
        END LOOP;

        UPDATE esim_stock
        SET
          status = 'assigned',
          issued_to_distributor_id = p_distributor_id,
          issued_date = NOW(),
          distribution_id = v_distribution_id
        WHERE iccid = ANY(p_iccids)
          AND status IN ('IN_STOCK', 'available', 'IN_STORE');

        GET DIAGNOSTICS v_count = ROW_COUNT;

        RETURN QUERY SELECT TRUE, 'Successfully distributed ' || v_count || ' eSIMs', v_count;
      EXCEPTION
        WHEN OTHERS THEN
          RETURN QUERY SELECT FALSE, 'Transaction failed: ' || SQLERRM, 0;
      END;
    END;
    $$;`
  );

  await query(
    `CREATE OR REPLACE FUNCTION distribute_physical_box(
      p_distributor_id UUID,
      p_box_id UUID,
      p_quantity INTEGER,
      p_purpose TEXT DEFAULT NULL
    )
    RETURNS TABLE(success BOOLEAN, message TEXT)
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_box RECORD;
      v_distribution_id UUID := gen_random_uuid();
      v_iccid_start TEXT;
      v_iccid_end TEXT;
      v_new_iccid TEXT;
      v_i INTEGER;
    BEGIN
      BEGIN
        SELECT b.*, c.carton_number, m.id as mvno_id
        INTO v_box
        FROM boxes b
        JOIN cartons c ON b.carton_id = c.id
        JOIN mvnos m ON c.mvno_id = m.id
        WHERE b.id = p_box_id
        FOR UPDATE;

        IF v_box IS NULL THEN
          RETURN QUERY SELECT FALSE, 'Box not found';
          RETURN;
        END IF;

        IF COALESCE(v_box.remaining_sims, v_box.total_sims) < p_quantity THEN
          RETURN QUERY SELECT FALSE, 'Insufficient SIMs in box. Available: ' || COALESCE(v_box.remaining_sims, v_box.total_sims);
          RETURN;
        END IF;

        -- Offset ICCID start by already-issued SIMs so we pick from where the last pick left off
        v_iccid_start := LPAD(
          (v_box.iccid_start::numeric + COALESCE(v_box.issued_sims, 0))::text,
          LENGTH(v_box.iccid_start), '0'
        );
        v_new_iccid := v_iccid_start;

        IF p_quantity > 1 THEN
          FOR v_i IN 1..(p_quantity - 1) LOOP
            v_new_iccid := increment_iccid(v_new_iccid);
          END LOOP;
        END IF;
        v_iccid_end := v_new_iccid;

        UPDATE boxes
        SET
          remaining_sims = remaining_sims - p_quantity,
          issued_sims = COALESCE(issued_sims, 0) + p_quantity
        WHERE id = p_box_id
          AND remaining_sims >= p_quantity;

        IF NOT FOUND THEN
          RETURN QUERY SELECT FALSE, 'Failed to update box. Stock may have changed.';
          RETURN;
        END IF;

        INSERT INTO box_pick_records (box_id, distributor_id, quantity, sims_picked, iccid_start, iccid_end, distribution_id)
        VALUES (p_box_id, p_distributor_id, p_quantity, p_quantity, v_iccid_start, v_iccid_end, v_distribution_id);

        RETURN QUERY SELECT TRUE, 'Successfully distributed ' || p_quantity || ' SIMs from box ' || v_box.box_number;
      EXCEPTION
        WHEN OTHERS THEN
          RETURN QUERY SELECT FALSE, 'Transaction failed: ' || SQLERRM;
      END;
    END;
    $$;`
  );

  await query(
    `CREATE OR REPLACE FUNCTION distribute_physical_boxes(
      p_distributor_id UUID,
      p_box_quantities JSONB,
      p_purpose TEXT DEFAULT NULL
    )
    RETURNS TABLE(success BOOLEAN, message TEXT, total_distributed INTEGER)
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_distribution_id UUID := gen_random_uuid();
      v_item JSONB;
      v_box_id UUID;
      v_quantity INTEGER;
      v_box RECORD;
      v_iccid_start TEXT;
      v_iccid_end TEXT;
      v_new_iccid TEXT;
      v_i INTEGER;
      v_total INTEGER := 0;
      v_box_count INTEGER := 0;
    BEGIN
      BEGIN
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_box_quantities) LOOP
          v_box_id := (v_item->>'box_id')::UUID;
          v_quantity := (v_item->>'quantity')::INTEGER;

          SELECT b.*, c.carton_number
          INTO v_box
          FROM boxes b
          JOIN cartons c ON b.carton_id = c.id
          WHERE b.id = v_box_id
          FOR UPDATE;

          IF v_box IS NULL THEN
            RETURN QUERY SELECT FALSE, 'Box not found: ' || v_box_id, 0;
            RETURN;
          END IF;

          IF COALESCE(v_box.remaining_sims, v_box.total_sims) < v_quantity THEN
            RETURN QUERY SELECT FALSE, 'Insufficient SIMs in box ' || v_box.box_number || '. Available: ' || COALESCE(v_box.remaining_sims, v_box.total_sims), v_total;
            RETURN;
          END IF;

          -- Offset ICCID start by already-issued SIMs so we pick from where the last pick left off
          v_iccid_start := LPAD(
            (v_box.iccid_start::numeric + COALESCE(v_box.issued_sims, 0))::text,
            LENGTH(v_box.iccid_start), '0'
          );
          v_new_iccid := v_iccid_start;

          IF v_quantity > 1 THEN
            FOR v_i IN 1..(v_quantity - 1) LOOP
              v_new_iccid := increment_iccid(v_new_iccid);
            END LOOP;
          END IF;
          v_iccid_end := v_new_iccid;

          UPDATE boxes
          SET
            remaining_sims = remaining_sims - v_quantity,
            issued_sims = COALESCE(issued_sims, 0) + v_quantity
          WHERE id = v_box_id
            AND remaining_sims >= v_quantity;

          IF NOT FOUND THEN
            RETURN QUERY SELECT FALSE, 'Failed to update box ' || v_box.box_number || '. Stock may have changed.', v_total;
            RETURN;
          END IF;

          INSERT INTO box_pick_records (box_id, distributor_id, quantity, sims_picked, iccid_start, iccid_end, distribution_id)
          VALUES (v_box_id, p_distributor_id, v_quantity, v_quantity, v_iccid_start, v_iccid_end, v_distribution_id);

          v_total := v_total + v_quantity;
          v_box_count := v_box_count + 1;
        END LOOP;

        RETURN QUERY SELECT TRUE, 'Successfully distributed ' || v_total || ' SIMs from ' || v_box_count || ' boxes', v_total;
      EXCEPTION
        WHEN OTHERS THEN
          RETURN QUERY SELECT FALSE, 'Transaction failed: ' || SQLERRM, v_total;
      END;
    END;
    $$;`
  );
}

export async function ensureDistributionCompatibility(): Promise<void> {
  await ensureDistributionFunctionsCompatibility();
  // Ensure contact_person column exists on pick_history (added for manual provisioning tracking)
  await query(`ALTER TABLE IF EXISTS pick_history ADD COLUMN IF NOT EXISTS contact_person TEXT`);
}

export async function ensureMvnoAdminColumns(): Promise<void> {
  await query(`
    ALTER TABLE IF EXISTS stock_issuance_requests
      ADD COLUMN IF NOT EXISTS rejection_reason  TEXT,
      ADD COLUMN IF NOT EXISTS escalation_reason TEXT,
      ADD COLUMN IF NOT EXISTS reviewed_by       TEXT,
      ADD COLUMN IF NOT EXISTS reviewed_at       TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS escalated_at      TIMESTAMPTZ
  `);
}

function buildManualProvisioningRequestId(payload: {
  distributor_id: string;
  mvno_id: string;
  sim_type: 'PHYSICAL' | 'ESIM';
  box_quantities?: { box_id: string; quantity: number }[];
  iccids?: string[];
  effective_date?: string;
  purpose?: string;
}): string {
  const simType = payload.sim_type;
  if (simType === 'ESIM') {
    const iccids = sortEsimIccids(payload.iccids || []);
    const basis = JSON.stringify({
      kind: 'manual_provision_esim',
      distributor_id: payload.distributor_id,
      mvno_id: payload.mvno_id,
      iccids,
      effective_date: payload.effective_date || null,
      purpose: payload.purpose || null,
    });
    return uuidv5(basis, PROVISION_NAMESPACE);
  }

  const boxes = Array.isArray(payload.box_quantities)
    ? payload.box_quantities
        .map((b) => ({ box_id: String(b?.box_id || '').trim(), quantity: Math.floor(Number(b?.quantity || 0)) }))
        .filter((b) => b.box_id && b.quantity > 0)
        .sort((a, b) => a.box_id.localeCompare(b.box_id))
    : [];

  const basis = JSON.stringify({
    kind: 'manual_provision_physical',
    distributor_id: payload.distributor_id,
    mvno_id: payload.mvno_id,
    boxes,
    effective_date: payload.effective_date || null,
    purpose: payload.purpose || null,
  });
  return uuidv5(basis, PROVISION_NAMESPACE);
}

async function insertDistributionHistoryIdempotent(
  client: PoolClient,
  args: {
    request_id: string;
    distributor_id: string;
    mvno_id: string;
    sim_type: 'PHYSICAL' | 'ESIM';
    carton_number?: string | null;
    box_number?: string | null;
    box_id?: string | null;
    sim_count: number;
    purpose?: string | null;
    notes?: string | null;
  }
): Promise<'inserted' | 'skipped'> {
  const existing = await client.query(
    `SELECT id
       FROM distribution_history
      WHERE request_id = $1
        AND sim_type = $2
        AND COALESCE(box_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND COALESCE(carton_number, '') = COALESCE($4, '')
        AND COALESCE(box_number, '') = COALESCE($5, '')
      LIMIT 1`,
    [
      args.request_id,
      args.sim_type,
      args.box_id ?? null,
      args.carton_number ?? null,
      args.box_number ?? null,
    ]
  );

  if (existing.rowCount) {
    return 'skipped';
  }

  const res = await client.query(
    `INSERT INTO distribution_history (
       request_id, distributor_id, mvno_id, sim_type, carton_number, box_number, box_id, sim_count, purpose, notes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      args.request_id,
      args.distributor_id,
      args.mvno_id,
      args.sim_type,
      args.carton_number ?? null,
      args.box_number ?? null,
      args.box_id ?? null,
      args.sim_count,
      args.purpose ?? null,
      args.notes ?? null,
    ]
  );
  return res.rowCount ? 'inserted' : 'skipped';
}

/**
 * Controlled provisioning for PHYSICAL stock:
 * - Locks sim_stock row
 * - Rejects if already assigned (current_owner IS NOT NULL)
 * - Updates boxes + sim_stock + box_pick_records in one transaction (same connection)
 */
export async function ProvisionStock(
  client: PoolClient,
  args: {
    distributorId: string;
    distributorName: string;
    mvnoId: string;
    mvnoName: string;
    boxId: string;
    simCount: number;
    purpose?: string | null;
  }
): Promise<{ iccid_start: string; iccid_end: string; carton_number: string; box_number: string }> {
  if (!args.simCount || args.simCount <= 0) {
    throw new Error('sim_count must be > 0');
  }

  const lock = await client.query(
    `SELECT ss.*, b.iccid_start::text AS b_iccid_start
     FROM sim_stock ss
     JOIN boxes b ON b.id = ss.box_id
     WHERE ss.box_id = $1::uuid
     FOR UPDATE OF ss, b`,
    [args.boxId]
  );
  if (!lock.rows.length) {
    throw new Error('Stock row not found for box');
  }

  const row = lock.rows[0];
  const normalizedStatus = String(row.status || '').toUpperCase();
  if (row.current_owner || normalizedStatus === 'ASSIGNED' || normalizedStatus === 'ISSUED') {
    const err: any = new Error('Stock already assigned');
    err.code = 'STOCK_ALREADY_ASSIGNED';
    throw err;
  }
  if (String(row.mvno_id) !== String(args.mvnoId)) {
    throw new Error('MVNO mismatch for selected box');
  }

  const remaining = Number(row.total_sims || 0) - Number(row.assigned_sims || 0);
  if (remaining < args.simCount) {
    throw new Error(`Insufficient SIMs in box. Available: ${remaining}`);
  }

  // Reuse the canonical DB function for ICCID range + box decrement + pick record insert,
  // but only after sim_stock ownership checks + row locks above.
  const distRes = await client.query(`SELECT * FROM distribute_physical_box($1::uuid, $2::uuid, $3::int, $4::text)`, [
    args.distributorId,
    args.boxId,
    args.simCount,
    args.purpose || null,
  ]);
  const dist = distRes.rows?.[0];
  if (!dist?.success) {
    throw new Error(String(dist?.message || 'Failed to distribute physical SIMs'));
  }

  // Fetch ICCID range from the latest pick record for this box (created by distribute_physical_box)
  const pickRes = await client.query(
    `SELECT iccid_start::text AS iccid_start, iccid_end::text AS iccid_end
       FROM box_pick_records
      WHERE box_id = $1::uuid
      ORDER BY picked_at DESC
      LIMIT 1`,
    [args.boxId]
  );

  const iccid_start = String(pickRes.rows[0]?.iccid_start || '');
  const iccid_end = String(pickRes.rows[0]?.iccid_end || '');

  await client.query(
    `UPDATE sim_stock
     SET current_owner = $2,
         assigned_sims = LEAST(COALESCE(assigned_sims, 0) + $3, COALESCE(total_sims, 0)),
         status = CASE
           WHEN LEAST(COALESCE(assigned_sims, 0) + $3, COALESCE(total_sims, 0)) >= COALESCE(total_sims, 0)
             THEN 'ISSUED'
           ELSE 'PARTIAL'
         END,
         last_updated = NOW()
     WHERE box_id = $1::uuid`,
    [args.boxId, args.distributorName, args.simCount]
  );

  return {
    iccid_start,
    iccid_end,
    carton_number: String(row.carton_number),
    box_number: String(row.box_number),
  };
}

export async function getSimStock(params: {
  limit?: number;
  offset?: number;
  search?: string;
  carton_number?: string;
  box_number?: string;
  mvno?: string;
  status?: string;
  iccid_from?: string;
  iccid_to?: string;
} = {}): Promise<any[]> {
  await ensureProvisioningSchema();
  const where: string[] = [];
  const values: any[] = [];

  const add = (sql: string, value: any) => {
    values.push(value);
    where.push(sql.replace('$?', `$${values.length}`));
  };

  if (params.search) {
    const searchVal = `%${params.search}%`;
    values.push(searchVal);
    values.push(searchVal);
    values.push(searchVal);
    values.push(searchVal);
    values.push(searchVal);
    where.push(
      `(ss.carton_number ILIKE $${values.length - 4}
        OR ss.box_number ILIKE $${values.length - 3}
        OR COALESCE(ss.iccid_start, b.iccid_start, '') ILIKE $${values.length - 2}
        OR COALESCE(ss.iccid_end, b.iccid_end, '') ILIKE $${values.length - 1}
        OR COALESCE(m.name::text, ss.mvno, '') ILIKE $${values.length})`
    );
  }
  if (params.carton_number) add(`ss.carton_number ILIKE $?`, `%${params.carton_number}%`);
  if (params.box_number) add(`ss.box_number ILIKE $?`, `%${params.box_number}%`);
  if (params.mvno) add(`COALESCE(m.name::text, ss.mvno, '') ILIKE $?`, `%${params.mvno}%`);
  if (params.status) add(`UPPER(COALESCE(ss.status, 'IN_STORE')) = UPPER($?)`, params.status);
  if (params.iccid_from) add(`COALESCE(ss.iccid_start, b.iccid_start::text, '') >= $?`, params.iccid_from);
  if (params.iccid_to) add(`COALESCE(ss.iccid_end, b.iccid_end::text, '') <= $?`, params.iccid_to);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(params.limit ?? 1000, 1), 5000);
  const offset = Math.max(params.offset ?? 0, 0);

  values.push(limit, offset);

  const limitIdx = values.length - 1;
  const offsetIdx = values.length;

  const res = await query(
    `
    WITH carton_order AS (
      SELECT
        c.id AS carton_id,
        c.mvno_id,
        NULLIF(
          regexp_replace(
            CASE
              WHEN POSITION('/' IN c.carton_number) > 0 THEN SPLIT_PART(c.carton_number, '/', 1)
              ELSE c.carton_number
            END,
            '[^0-9]',
            '',
            'g'
          ),
          ''
        )::int AS carton_seq
      FROM cartons c
    ),
    carton_totals AS (
      SELECT c.mvno_id, COUNT(*)::int AS total_cartons
      FROM cartons c
      WHERE c.mvno_id IS NOT NULL
      GROUP BY c.mvno_id
    )
    SELECT
      ss.id,
      ss.box_id,
      ss.mvno_id,
      COALESCE(m.name::text, ss.mvno, 'UNKNOWN') AS mvno,
      ss.carton_number,
      ss.box_number,
      ((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(NULLIF(regexp_replace(ss.box_number, '[^0-9]', '', 'g'), '')::int, 0)) AS global_box_number,
      (
        ((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(NULLIF(regexp_replace(ss.box_number, '[^0-9]', '', 'g'), '')::int, 0))::text
        || '/' ||
        (COALESCE(ct.total_cartons, 0) * 20)::text
      ) AS box_display,
      COALESCE(ss.iccid_start, b.iccid_start::text) AS iccid_start,
      COALESCE(ss.iccid_end, b.iccid_end::text) AS iccid_end,
      COALESCE(ss.total_sims, 0) AS total_sims,
      GREATEST(COALESCE(ss.total_sims, 0) - COALESCE(ss.assigned_sims, 0), 0) AS remaining_sims,
      COALESCE(ss.assigned_sims, 0) AS issued_sims,
      CASE
        WHEN COALESCE(ss.total_sims, 0) > 0
          THEN ROUND((GREATEST(COALESCE(ss.total_sims, 0) - COALESCE(ss.assigned_sims, 0), 0)::numeric / ss.total_sims::numeric) * 100)
        ELSE 0
      END AS remaining_percent,
      CASE
        WHEN UPPER(COALESCE(ss.status, '')) IN ('ASSIGNED', 'ISSUED', 'PARTIAL') OR ss.current_owner IS NOT NULL THEN 'ISSUED'
        ELSE 'IN_STORE'
      END AS status,
      ss.current_owner,
      ss.last_updated
    FROM sim_stock ss
    LEFT JOIN boxes b ON b.id = ss.box_id
    LEFT JOIN cartons c ON c.id = b.carton_id
    LEFT JOIN carton_order co ON co.carton_id = c.id
    LEFT JOIN carton_totals ct ON ct.mvno_id = COALESCE(ss.mvno_id, c.mvno_id)
    LEFT JOIN mvnos m ON COALESCE(ss.mvno_id, c.mvno_id) = m.id
    ${whereSql}
    ORDER BY m.name NULLS LAST, co.carton_seq NULLS LAST, COALESCE(NULLIF(regexp_replace(ss.box_number, '[^0-9]', '', 'g'), '')::int, 0) NULLS LAST
    LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values
  );
  return res.rows;
}

// Legacy rollup kept for reference/debugging; current UI uses filtered getDistributionHistory(filters).
export async function getDistributionHistoryLegacy(): Promise<any[]> {
  await ensureProvisioningSchema();
  const res = await query(`
    WITH carton_order AS (
      SELECT
        c.id AS carton_id,
        c.mvno_id,
        NULLIF(
          regexp_replace(
            CASE
              WHEN POSITION('/' IN c.carton_number) > 0 THEN SPLIT_PART(c.carton_number, '/', 1)
              ELSE c.carton_number
            END,
            '[^0-9]',
            '',
            'g'
          ),
          ''
        )::int AS carton_seq
      FROM cartons c
    ),
    carton_totals AS (
      SELECT c.mvno_id, COUNT(*)::int AS total_cartons
      FROM cartons c
      WHERE c.mvno_id IS NOT NULL
      GROUP BY c.mvno_id
    ),
    box_rollup AS (
      SELECT
        dh.request_id,
        STRING_AGG(
          (
            ((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(b.box_number, 0))::text
            || '/' ||
            (COALESCE(ct.total_cartons, 0) * 20)::text
          ),
          ', '
          ORDER BY COALESCE(co.carton_seq, 1), b.box_number
        ) AS box_display,
        STRING_AGG(DISTINCT COALESCE(dh.carton_number, c.carton_number), ', ') AS carton_number,
        MIN(COALESCE(ss.iccid_start, b.iccid_start::text)) AS iccid_start,
        MAX(COALESCE(ss.iccid_end, b.iccid_end::text)) AS iccid_end,
        SUM(dh.sim_count)::int AS total_sims
      FROM distribution_history dh
      LEFT JOIN boxes b ON b.id = dh.box_id
      LEFT JOIN sim_stock ss ON ss.box_id = b.id
      LEFT JOIN cartons c ON c.id = b.carton_id
      LEFT JOIN carton_order co ON co.carton_id = c.id
      LEFT JOIN carton_totals ct ON ct.mvno_id = COALESCE(ss.mvno_id, c.mvno_id, dh.mvno_id)
      WHERE dh.box_id IS NOT NULL
      GROUP BY dh.request_id
    )
    SELECT
      ph.id::text AS id,
      COALESCE(ph.manual_request_id, ph.request_id) AS request_id,
      COALESCE(d.name, 'Unknown')::text AS distributor_name,
      'DISTRIBUTOR'::text AS distributor_type,
      COALESCE(br.carton_number, abr.carton_number, ph.carton_number::text, '') AS carton_number,
      0::int AS box_number,
      COALESCE(NULLIF(abr.box_display, '0/800'), NULLIF(br.box_display, '0/800'), NULLIF(ph.box_number::text, ''), '-') AS box_display,
      COALESCE(br.total_sims, ph.quantity, 0)::int AS sims_picked,
      COALESCE(br.iccid_start, abr.iccid_start, '') AS iccid_start,
      COALESCE(br.iccid_end, abr.iccid_end, '') AS iccid_end,
      ph.issued_at::text AS pick_date,
      ph.issued_at AS picked_at,
      COALESCE(ph.mvno_name, m.name::text, '') AS mvno,
      ph.pick_form_url::text AS pick_form_url,
      UPPER(COALESCE(ph.sim_type, 'PHYSICAL'))::text AS sim_type,
      'COMPLETED'::text AS distribution_status,
      COALESCE(ph.distribution_type, 'APPROVED')::text AS distribution_type,
      ph.issued_by::text AS issued_by
    FROM pick_history ph
    LEFT JOIN distributors d ON d.id = ph.distributor_id
    LEFT JOIN mvnos m ON m.id = ph.mvno_id
    LEFT JOIN box_rollup br ON br.request_id = COALESCE(ph.manual_request_id, ph.request_id)
    LEFT JOIN LATERAL (
      SELECT
        STRING_AGG(
          (
            ((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(b.box_number, 0))::text
            || '/' ||
            (COALESCE(ct.total_cartons, 0) * 20)::text
          ),
          ', '
          ORDER BY COALESCE(co.carton_seq, 1), b.box_number
        ) AS box_display,
        STRING_AGG(DISTINCT c.carton_number, ', ') AS carton_number,
        MIN(COALESCE(ss.iccid_start, b.iccid_start::text)) AS iccid_start,
        MAX(COALESCE(ss.iccid_end, b.iccid_end::text)) AS iccid_end
      FROM jsonb_array_elements(COALESCE(ph.assigned_boxes, '[]'::jsonb)) AS ab(item)
      JOIN boxes b ON b.id = (ab.item->>'box_id')::uuid
      LEFT JOIN sim_stock ss ON ss.box_id = b.id
      LEFT JOIN cartons c ON c.id = b.carton_id
      LEFT JOIN carton_order co ON co.carton_id = c.id
      LEFT JOIN carton_totals ct ON ct.mvno_id = COALESCE(ss.mvno_id, c.mvno_id, ph.mvno_id)
    ) abr ON true
    ORDER BY ph.issued_at DESC
    LIMIT 2000
  `);
  return res.rows;
}


export interface MvnoRow {
  id: string;
  name: string;
  created_at: string;
}

export interface DistributorRow {
  id: string;
  name: string;
  region: string | null;
  country: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  status: string;
  request_token: string | null;
  request_token_expires: string | null;
  created_at: string;
  updated_at: string;
  type: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  mvno_id: string | null;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  distributor_code: string | null;
  company_id: string | null;
  mvno_name: string | null;
}

export interface BoxStockSummaryRow {
  box_id: string;
  carton_number: string | null;
  box_number: number;
  box_display: string;
  mvno: string;
  iccid_start: string | null;
  iccid_end: string | null;
  total_sims: number;
  remaining_sims: number;
  issued_sims: number;
  remaining_percent: number;
  status: string;
}

export interface CurrentStockRow {
  mvno: string;
  sim_type: 'PHYSICAL' | 'ESIM';
  total_stock: number;
  in_store: number;
  issued: number;
  activated: number;
  sold: number;
  failed: number;
}

export interface DashboardMetricsRow {
  total_stock: number;
  distributed: number;
  activated: number;
  physical_distributed: number;
  esim_distributed: number;
  physical_remaining: number;
  esim_remaining: number;
}

export interface DashboardTrendRow {
  month_label: string;
  physical_distributed: number;
  esim_distributed: number;
}

export interface DashboardMetricsResult {
  metrics: DashboardMetricsRow;
  trend: DashboardTrendRow[];
}

export interface DistributorSummaryRow {
  distributor_id: string;
  distributor_name: string;
  physical_stock: number;
  esim_stock: number;
  total_issued: number;
  last_issued_date: string | null;
}

export interface EsimTotalsRow {
  total_esims: number;
  total_available: number;
  total_assigned: number;
  total_activated: number;
}

export interface EsimByOperatorRow {
  operator: string;
  total_esims: number;
  available: number;
  assigned: number;
  activated: number;
}

export interface EsimStockRow {
  id: string;
  iccid: string;
  imsi: string | null;
  operator: string | null;
  msisdn: string | null;
  mvno_id: string | null;
  status: string;
  issued_to_distributor_id: string | null;
  issued_date: string | null;
  distribution_id: string | null;
  created_at: string;
  updated_at: string;
}

// ==================== STOCK ISSUANCE REQUEST OPERATIONS ====================

export interface StockIssuanceRequest {
  id: string;
  mvno_id: string;
  requester_id: string;
  contact_person?: string;
  contact_email?: string;
  signature?: string;
  sim_type: 'PHYSICAL' | 'ESIM';
  quantity: number;
  status: 'PENDING' | 'LEVEL_1_APPROVED' | 'LEVEL_2_APPROVED' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'WAITING_FOR_APPROVAL' | 'READY_FOR_APPROVAL' | 'STOCK_ISSUED' | 'ESCALATED';
  assigned_box_quantities: any[];
  assigned_esim_iccids: string[];
  level_1_approver_id?: string;
  level_1_approver_email?: string;
  level_1_approved_at?: string;
  level_2_approver_id?: string;
  level_2_approver_email?: string;
  level_2_approved_at?: string;
  rejection_reason?: string;
  notes?: string;
  cancelled_by?: string;
  cancelled_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ApprovalToken {
  id: string;
  request_id: string;
  approver_role: string;
  approver_email: string;
  token: string;
  expires_at: string;
  used: boolean;
  used_at?: string;
  created_at: string;
}

export interface StockIssuanceReport {
  id: string;
  request_id: string;
  distributor_name?: string;
  distributor_id?: string;
  sim_type?: string;
  quantity?: number;
  assigned_boxes?: any;
  assigned_esims?: any;
  level_1_approved_by?: string;
  level_1_approved_email?: string;
  level_1_approved_at?: string;
  level_2_approved_by?: string;
  level_2_approved_email?: string;
  level_2_approved_at?: string;
  report_generated_at?: string;
  created_at: string;
}

function generateApprovalTokenValue(): string {
  return randomBytes(32).toString('hex');
}

// Create a new stock issuance request
export async function createStockIssuanceRequest(
  mvnoId: string,
  requesterId: string,
  simType: 'PHYSICAL' | 'ESIM',
  quantity: number,
  notes?: string,
  contactPerson?: string,
  contactEmail?: string,
  signature?: string
): Promise<StockIssuanceRequest> {
  // Ensure columns exist
  await query(
    `ALTER TABLE IF EXISTS stock_issuance_requests
       ADD COLUMN IF NOT EXISTS contact_person TEXT,
       ADD COLUMN IF NOT EXISTS contact_email TEXT,
       ADD COLUMN IF NOT EXISTS signature TEXT`
  );

  const result = await query(
    `INSERT INTO stock_issuance_requests (
       mvno_id, requester_id, sim_type, quantity, status, notes,
       contact_person, contact_email, signature, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3, $4, 'PENDING', $5, $6, $7, $8, NOW(), NOW())
     RETURNING *`,
    [mvnoId, requesterId, simType, quantity, notes || null, contactPerson || null, contactEmail || null, signature || null]
  );
  
  return result.rows[0];
}

// Get all stock issuance requests
export async function getAllStockIssuanceRequests(): Promise<StockIssuanceRequest[]> {
  const result = await query(
    `SELECT 
      sir.*,
      d.name as distributor_name
    FROM stock_issuance_requests sir
    LEFT JOIN distributors d ON sir.requester_id = d.id
    ORDER BY sir.created_at DESC`
  );
  return result.rows;
}

export async function getDashboardMetrics(params: {
  mvno_id?: string;
  date_from?: string;
  date_to?: string;
}): Promise<DashboardMetricsResult> {
  const values: any[] = [];
  const distributionFilters: string[] = [];

  if (params.mvno_id) {
    values.push(params.mvno_id);
    distributionFilters.push(`dr.mvno_id = $${values.length}::uuid`);
  }
  if (params.date_from) {
    values.push(params.date_from);
    distributionFilters.push(`dr.recorded_at >= $${values.length}::timestamptz`);
  }
  if (params.date_to) {
    values.push(params.date_to);
    distributionFilters.push(`dr.recorded_at <= $${values.length}::timestamptz`);
  }

  const distributionWhereSql = distributionFilters.length ? `WHERE ${distributionFilters.join(' AND ')}` : '';

  const metricsResult = await query(
    `
    WITH distribution_rows AS (
      -- Physical SIMs: use box_pick_records only (actual per-box distributed quantities)
      SELECT
        c.mvno_id,
        'PHYSICAL'::text AS sim_type,
        COALESCE(bpr.sims_picked, 0)::int AS quantity,
        bpr.picked_at AS issued_at,
        bpr.picked_at AS recorded_at
      FROM box_pick_records bpr
      LEFT JOIN boxes b ON bpr.box_id = b.id
      LEFT JOIN cartons c ON b.carton_id = c.id

      UNION ALL

      -- Manual physical provisioning: pick_history with distribution_type='MANUAL' + sim_type='PHYSICAL'
      -- Exclude records where a box_pick_record already exists (avoids double-counting)
      SELECT
        ph.mvno_id,
        'PHYSICAL'::text AS sim_type,
        COALESCE(ph.quantity, 0)::int AS quantity,
        ph.issued_at,
        ph.issued_at AS recorded_at
      FROM pick_history ph
      WHERE ph.distribution_type = 'MANUAL'
        AND UPPER(COALESCE(ph.sim_type, 'PHYSICAL')) = 'PHYSICAL'
        AND ph.manual_request_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stock_audit_logs sal
          WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
            AND sal.details->>'pick_history_id' = ph.id::text
        )
        AND NOT EXISTS (
          SELECT 1 FROM box_pick_records bpr2
          WHERE bpr2.distributor_id = ph.distributor_id
            AND bpr2.box_id = (ph.assigned_boxes->0->>'box_id')::uuid
        )

      UNION ALL

      -- eSIM: use pick_history only (eSIMs don't create box_pick_records)
      SELECT
        ph.mvno_id,
        'ESIM'::text AS sim_type,
        COALESCE(ph.quantity, 0)::int AS quantity,
        ph.issued_at,
        ph.issued_at AS recorded_at
      FROM pick_history ph
      LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
      WHERE UPPER(COALESCE(ph.sim_type, sir.sim_type, 'PHYSICAL')) = 'ESIM'
        AND COALESCE(ph.distribution_type, 'APPROVED') IN ('APPROVED', 'MANUAL')
        AND (
          ph.request_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM stock_audit_logs sal
            WHERE sal.request_id = ph.request_id
              AND sal.action = 'DISTRIBUTION_REVERSED'
          )
        )
    ),
    filtered_distribution AS (
      SELECT *
      FROM distribution_rows dr
      ${distributionWhereSql}
    ),
    request_distribution AS (
      SELECT
        COALESCE(SUM(CASE WHEN fd.sim_type = 'PHYSICAL' THEN fd.quantity ELSE 0 END), 0)::int AS physical_distributed,
        COALESCE(SUM(CASE WHEN fd.sim_type = 'ESIM' THEN fd.quantity ELSE 0 END), 0)::int AS esim_distributed,
        COALESCE(SUM(fd.quantity), 0)::int AS distributed
      FROM filtered_distribution fd
    ),
    stock_totals AS (
      SELECT
        COALESCE((SELECT SUM(COALESCE(remaining_sims, 0)) FROM boxes), 0)::int AS physical_remaining,
        COALESCE((SELECT COUNT(*) FROM esim_stock WHERE COALESCE(status, 'available') = 'available'), 0)::int AS esim_remaining,
        (COALESCE((SELECT SUM(COALESCE(remaining_sims, 0)) FROM boxes), 0) + 
         COALESCE((SELECT COUNT(*) FROM esim_stock WHERE COALESCE(status, 'available') = 'available'), 0))::int AS total_stock
    ),
    activated_totals AS (
      SELECT
        COALESCE((SELECT COUNT(*) FROM esim_stock WHERE COALESCE(status, 'available') = 'active'), 0)::int AS activated
    )
    SELECT
      st.total_stock,
      rd.distributed,
      at.activated,
      rd.physical_distributed,
      rd.esim_distributed,
      st.physical_remaining,
      st.esim_remaining
    FROM stock_totals st
    CROSS JOIN request_distribution rd
    CROSS JOIN activated_totals at
    `,
    values
  );

  // Dynamic granularity based on date range for stock-market-style chart
  let granularity = 'month';
  let labelFormat = 'Mon YYYY';
  if (params.date_from && params.date_to) {
    const days = Math.ceil(
      (new Date(params.date_to).getTime() - new Date(params.date_from).getTime()) / 86400000
    );
    if (days <= 31) { granularity = 'day'; labelFormat = 'DD Mon'; }
    else if (days <= 90) { granularity = 'week'; labelFormat = 'DD Mon'; }
    else if (days <= 365) { granularity = 'week'; labelFormat = 'DD Mon YY'; }
  }

  const trendResult = await query(
    `
    WITH distribution_rows AS (
      SELECT
        c.mvno_id,
        'PHYSICAL'::text AS sim_type,
        COALESCE(bpr.sims_picked, 0)::int AS quantity,
        bpr.picked_at AS issued_at,
        bpr.picked_at AS recorded_at
      FROM box_pick_records bpr
      LEFT JOIN boxes b ON bpr.box_id = b.id
      LEFT JOIN cartons c ON b.carton_id = c.id

      UNION ALL

      -- Manual physical provisioning (exclude if box_pick_record already exists)
      SELECT
        ph.mvno_id,
        'PHYSICAL'::text AS sim_type,
        COALESCE(ph.quantity, 0)::int AS quantity,
        ph.issued_at,
        ph.issued_at AS recorded_at
      FROM pick_history ph
      WHERE ph.distribution_type = 'MANUAL'
        AND UPPER(COALESCE(ph.sim_type, 'PHYSICAL')) = 'PHYSICAL'
        AND ph.manual_request_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stock_audit_logs sal
          WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
            AND sal.details->>'pick_history_id' = ph.id::text
        )
        AND NOT EXISTS (
          SELECT 1 FROM box_pick_records bpr2
          WHERE bpr2.distributor_id = ph.distributor_id
            AND bpr2.box_id = (ph.assigned_boxes->0->>'box_id')::uuid
        )

      UNION ALL

      SELECT
        ph.mvno_id,
        'ESIM'::text AS sim_type,
        COALESCE(ph.quantity, 0)::int AS quantity,
        ph.issued_at,
        ph.issued_at AS recorded_at
      FROM pick_history ph
      LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
      WHERE UPPER(COALESCE(ph.sim_type, sir.sim_type, 'PHYSICAL')) = 'ESIM'
        AND COALESCE(ph.distribution_type, 'APPROVED') IN ('APPROVED', 'MANUAL')
        AND (
          ph.request_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM stock_audit_logs sal
            WHERE sal.request_id = ph.request_id
              AND sal.action = 'DISTRIBUTION_REVERSED'
          )
        )
    ),
    filtered_distribution AS (
      SELECT *
      FROM distribution_rows dr
      ${distributionWhereSql}
    ),
    bucketed AS (
      SELECT
        DATE_TRUNC('${granularity}', fd.issued_at) AS bucket,
        COALESCE(SUM(CASE WHEN fd.sim_type = 'PHYSICAL' THEN fd.quantity ELSE 0 END), 0)::int AS physical_distributed,
        COALESCE(SUM(CASE WHEN fd.sim_type = 'ESIM' THEN fd.quantity ELSE 0 END), 0)::int AS esim_distributed
      FROM filtered_distribution fd
      GROUP BY DATE_TRUNC('${granularity}', fd.issued_at)
    )
    SELECT
      bucket::text AS date,
      TO_CHAR(bucket, '${labelFormat}')::text AS label,
      physical_distributed,
      esim_distributed,
      (physical_distributed + esim_distributed)::int AS total,
      SUM(physical_distributed + esim_distributed) OVER (ORDER BY bucket)::int AS cumulative_total,
      SUM(physical_distributed) OVER (ORDER BY bucket)::int AS cumulative_physical,
      SUM(esim_distributed) OVER (ORDER BY bucket)::int AS cumulative_esim
    FROM bucketed
    ORDER BY bucket
    `,
    values
  );

  return {
    metrics: metricsResult.rows[0] || {
      total_stock: 0,
      distributed: 0,
      activated: 0,
      physical_distributed: 0,
      esim_distributed: 0,
      physical_remaining: 0,
      esim_remaining: 0,
    },
    trend: trendResult.rows,
  };
}

export async function getDistributorSummary(params: {
  mvno_id?: string;
  date_from?: string;
  date_to?: string;
}): Promise<DistributorSummaryRow[]> {
  await ensureManualProvisioningSchema();

  const values: any[] = [];
  const filters: string[] = [];

  if (params.mvno_id) {
    values.push(params.mvno_id);
    filters.push(`x.mvno_id = $${values.length}::uuid`);
  }
  if (params.date_from) {
    values.push(params.date_from);
    filters.push(`x.recorded_at >= $${values.length}::timestamptz`);
  }
  if (params.date_to) {
    values.push(params.date_to);
    filters.push(`x.recorded_at <= $${values.length}::timestamptz`);
  }

  const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const result = await query(
    `
    WITH distribution_rows AS (
      -- Physical SIMs: use box_pick_records only (actual per-box distributed quantities)
      SELECT
        bpr.distributor_id,
        COALESCE(d.name, 'Unknown')::text AS distributor_name,
        'PHYSICAL'::text AS sim_type,
        COALESCE(bpr.sims_picked, 0)::int AS quantity,
        bpr.picked_at AS issued_at,
        bpr.picked_at AS recorded_at,
        c.mvno_id
      FROM box_pick_records bpr
      LEFT JOIN distributors d ON bpr.distributor_id = d.id
      LEFT JOIN boxes b ON bpr.box_id = b.id
      LEFT JOIN cartons c ON b.carton_id = c.id

      UNION ALL

      -- Manual physical provisioning: pick_history with distribution_type='MANUAL' + sim_type='PHYSICAL'
      SELECT
        ph.distributor_id,
        COALESCE(d.name, 'Unknown')::text AS distributor_name,
        'PHYSICAL'::text AS sim_type,
        COALESCE(ph.quantity, 0)::int AS quantity,
        ph.issued_at,
        ph.issued_at AS recorded_at,
        ph.mvno_id
      FROM pick_history ph
      LEFT JOIN distributors d ON ph.distributor_id = d.id
      WHERE ph.distribution_type = 'MANUAL'
        AND UPPER(COALESCE(ph.sim_type, 'PHYSICAL')) = 'PHYSICAL'
        AND ph.manual_request_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stock_audit_logs sal
          WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
            AND sal.details->>'pick_history_id' = ph.id::text
        )
        AND NOT EXISTS (
          SELECT 1 FROM box_pick_records bpr2
          WHERE bpr2.distributor_id = ph.distributor_id
            AND bpr2.box_id = (ph.assigned_boxes->0->>'box_id')::uuid
        )

      UNION ALL

      -- eSIM: use pick_history only (eSIMs don't create box_pick_records)
      SELECT
        COALESCE(ph.distributor_id, sir.requester_id) AS distributor_id,
        COALESCE(d.name, 'Unknown')::text AS distributor_name,
        'ESIM'::text AS sim_type,
        COALESCE(ph.quantity, 0)::int AS quantity,
        ph.issued_at,
        ph.issued_at AS recorded_at,
        ph.mvno_id
      FROM pick_history ph
      LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
      LEFT JOIN distributors d ON COALESCE(ph.distributor_id, sir.requester_id) = d.id
      WHERE UPPER(COALESCE(ph.sim_type, sir.sim_type, 'PHYSICAL')) = 'ESIM'
        AND COALESCE(ph.distribution_type, 'APPROVED') IN ('APPROVED', 'MANUAL')
        AND (
          ph.request_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM stock_audit_logs sal
            WHERE sal.request_id = ph.request_id
              AND sal.action = 'DISTRIBUTION_REVERSED'
          )
        )
    ),
    filtered AS (
      SELECT *
      FROM distribution_rows x
      ${whereSql}
    )
    SELECT
      COALESCE(x.distributor_id::text, '') AS distributor_id,
      x.distributor_name,
      COALESCE(SUM(CASE WHEN x.sim_type = 'PHYSICAL' THEN x.quantity ELSE 0 END), 0)::int AS physical_stock,
      COALESCE(SUM(CASE WHEN x.sim_type = 'ESIM' THEN x.quantity ELSE 0 END), 0)::int AS esim_stock,
      COALESCE(SUM(x.quantity), 0)::int AS total_issued,
      MAX(x.issued_at) AS last_issued_date
    FROM filtered x
    GROUP BY x.distributor_id, x.distributor_name
    ORDER BY total_issued DESC, x.distributor_name ASC
    `,
    values
  );

  return result.rows;
}

// Update request with approver emails
export async function updateRequestApprovers(
  requestId: string,
  level1ApproverEmail?: string,
  level2ApproverEmail?: string
): Promise<void> {
  await query(
    `UPDATE stock_issuance_requests 
     SET level_1_approver_email = COALESCE($2, level_1_approver_email),
         level_2_approver_email = COALESCE($3, level_2_approver_email)
     WHERE id = $1`,
    [requestId, level1ApproverEmail || null, level2ApproverEmail || null]
  );
}

export async function getDistributorById(id: string): Promise<DistributorRow | null> {
  const result = await query(
    `SELECT
        d.id,
        d.name,
        d.region,
        NULL::text as country,
        d.email as contact_email,
        COALESCE(d.contact_phone, d.phone) as contact_phone,
        CASE WHEN d.is_active THEN 'active' ELSE 'inactive' END as status,
        d.request_token,
        d.request_token_expires,
        d.created_at,
        d.updated_at,
        d.type::text,
        d.location,
        d.latitude,
        d.longitude,
        d.address,
        d.mvno_id,
        d.contact_person,
        COALESCE(d.contact_phone, d.phone) as phone,
        d.email
     FROM distributors d
     WHERE d.id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function getDistributorByToken(token: string): Promise<DistributorRow | null> {
  try {
    const result = await query(
      `SELECT
          d.id,
          d.name,
          d.region,
          NULL::text as country,
          d.email as contact_email,
          COALESCE(d.contact_phone, d.phone) as contact_phone,
          CASE WHEN d.is_active THEN 'active' ELSE 'inactive' END as status,
          d.request_token,
          d.request_token_expires,
          d.created_at,
          d.updated_at,
          d.type::text,
          d.location,
          d.latitude,
          d.longitude,
          d.address,
          d.mvno_id,
          d.contact_person,
          COALESCE(d.contact_phone, d.phone) as phone,
          d.email
       FROM distributors d
       WHERE d.request_token = $1
         AND (d.request_token_expires IS NULL OR d.request_token_expires > NOW())
       LIMIT 1`,
      [token]
    );
    return result.rows[0] || null;
  } catch (error: any) {
    if (error?.code === '22P02') return null;
    throw error;
  }
}

export async function updateDistributor(id: string, patch: Record<string, any>): Promise<DistributorRow> {
  const allowed = new Set([
    'name',
    'region',
    'email',
    'phone',
    'contact_phone',
    'is_active',
    'request_token',
    'request_token_expires',
    'type',
    'location',
    'mvno_id',
    'contact_person',
    'notes',
  ]);

  const keys = Object.keys(patch || {}).filter((k) => allowed.has(k));
  if (keys.length === 0) {
    const existing = await getDistributorById(id);
    if (!existing) throw new Error('Distributor not found');
    return existing;
  }

  const sets: string[] = [];
  const values: any[] = [];
  for (const k of keys) {
    values.push(patch[k]);
    sets.push(`${k} = $${values.length}`);
  }
  values.push(id);

  const result = await query(
    `UPDATE distributors
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING
        id,
        name,
        region,
        NULL::text as country,
        email as contact_email,
        COALESCE(contact_phone, phone) as contact_phone,
        CASE WHEN is_active THEN 'active' ELSE 'inactive' END as status,
        request_token,
        request_token_expires,
        created_at,
        updated_at,
        type::text,
        location,
        latitude,
        longitude,
        address,
        mvno_id,
        contact_person,
        COALESCE(contact_phone, phone) as phone,
        email`,
    values
  );

  const row = result.rows[0];
  if (!row) throw new Error('Distributor not found');
  return row;
}

// ==================== MVNOS & DISTRIBUTORS ====================

export async function getMvnos(): Promise<MvnoRow[]> {
  const result = await query('SELECT id, name, created_at FROM mvnos ORDER BY name');
  return result.rows;
}

export async function getDistributors(activeOnly: boolean): Promise<DistributorRow[]> {
  const result = await query(
    `SELECT
        d.id,
        d.name,
        d.region,
        NULL::text as country,
        d.email as contact_email,
        COALESCE(d.contact_phone, d.phone) as contact_phone,
        CASE WHEN d.is_active THEN 'active' ELSE 'inactive' END as status,
        d.request_token,
        d.request_token_expires,
        d.created_at,
        d.updated_at,
        d.type::text,
        d.location,
        d.latitude,
        d.longitude,
        d.address,
        d.mvno_id,
        d.contact_person,
        COALESCE(d.contact_phone, d.phone) as phone,
        d.email,
        d.distributor_code,
        d.company_id,
        COALESCE(m.name::text, c.name) AS mvno_name
     FROM distributors d
     LEFT JOIN mvnos m ON m.id = d.mvno_id
     LEFT JOIN companies c ON c.id = d.company_id
     ${activeOnly ? "WHERE d.is_active = true" : ''}
     ORDER BY d.name`
  );
  return result.rows;
}

export async function createDistributor(input: {
  name: string;
  region?: string | null;
  type?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
}): Promise<DistributorRow> {
  const result = await query(
    `INSERT INTO distributors (name, region, type, email, phone, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING
        id,
        name,
        region,
        NULL::text as country,
        email as contact_email,
        COALESCE(contact_phone, phone) as contact_phone,
        CASE WHEN is_active THEN 'active' ELSE 'inactive' END as status,
        created_at,
        updated_at,
        type::text,
        location,
        latitude,
        longitude,
        address,
        mvno_id,
        contact_person,
        COALESCE(contact_phone, phone) as phone,
        email
    `,
    [
      input.name,
      input.region || null,
      input.type || 'DISTRIBUTOR',
      input.contact_email || null,
      input.contact_phone || null,
    ]
  );
  return result.rows[0];
}

export interface PhysicalStockSummaryRow {
  mvno_id: string;
  mvno_name: string;
  carton_count: number;
  box_count: number;
  total_remaining: number;
  total_issued: number;
  total_sims: number;
}

export async function getPhysicalStockSummary(): Promise<PhysicalStockSummaryRow[]> {
  // Keep only rows with mvno_id set; frontend uses mvno_id to join.
  const result = await query(
    `
    SELECT
      b.mvno_id,
      COALESCE(m.name::text, 'HAMILTON') AS mvno_name,
      COUNT(DISTINCT b.carton_id)::int AS carton_count,
      COUNT(DISTINCT b.id)::int AS box_count,
      SUM(COALESCE(b.remaining_sims, 0))::int AS total_remaining,
      SUM(COALESCE(b.issued_sims, 0))::int AS total_issued,
      SUM(COALESCE(b.total_sims, 0))::int AS total_sims
    FROM boxes b
    LEFT JOIN mvnos m ON b.mvno_id = m.id
    WHERE b.mvno_id IS NOT NULL
    GROUP BY b.mvno_id, COALESCE(m.name::text, 'HAMILTON')
    ORDER BY mvno_name
    `
  );
  return result.rows;
}

export interface CartonRow {
  id: string;
  carton_number: string;
  mvno_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export async function getCartons(mvnoId?: string): Promise<CartonRow[]> {
  const values: any[] = [];
  const where: string[] = [];
  if (mvnoId) {
    values.push(mvnoId);
    where.push(`c.mvno_id = $${values.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await query(
    `SELECT c.id, c.carton_number, c.mvno_id, c.created_at, NULL::timestamp as updated_at
     FROM cartons c
     ${whereSql}
     ORDER BY c.carton_number`,
    values
  );
  return result.rows;
}

export interface BoxRow {
  id: string;
  carton_id: string | null;
  carton_number: string | null;
  box_number: string | null;
  box_display: string;
  remaining_sims: number;
  iccid_start: string | null;
  iccid_end: string | null;
}

export async function getBoxes(cartonId?: string): Promise<BoxRow[]> {
  const values: any[] = [];
  const where: string[] = [];
  
  if (cartonId) {
    // Validate UUID before using in query to prevent SQL errors
    if (!isValidUUID(cartonId)) {
      throw new Error(`Invalid carton_id format: ${cartonId}`);
    }
    values.push(cartonId);
    where.push(`b.carton_id = $${values.length}::uuid`);
  }

  // Only show boxes that actually have remaining SIMs after subtracting active assignments and pick_history distributions
  where.push(`LEAST(
    COALESCE(b.remaining_sims, 0) - COALESCE(active_assignments.reserved_qty, 0),
    COALESCE(b.total_sims, 0) - COALESCE(ph_contributions.total_picked, 0) - COALESCE(active_assignments.reserved_qty, 0)
  ) > 0`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await query(
    `
    WITH carton_order AS (
      SELECT
        c.id AS carton_id,
        c.mvno_id,
        NULLIF(
          regexp_replace(
            CASE
              WHEN POSITION('/' IN c.carton_number) > 0 THEN SPLIT_PART(c.carton_number, '/', 1)
              ELSE c.carton_number
            END,
            '[^0-9]',
            '',
            'g'
          ),
          ''
        )::int AS carton_seq
      FROM cartons c
    ),
    carton_totals AS (
      SELECT
        c.mvno_id,
        COUNT(*)::int AS total_cartons
      FROM cartons c
      WHERE c.mvno_id IS NOT NULL
      GROUP BY c.mvno_id
    )
    SELECT
      b.id,
      b.carton_id,
      c.carton_number,
      b.box_number::text AS box_number,
      (((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(b.box_number, 0))::text || '/' ||
        (COALESCE(ct.total_cartons, 0) * 20)::text
      ) AS box_display,
      LEAST(
        GREATEST(COALESCE(b.remaining_sims, 0) - COALESCE(active_assignments.reserved_qty, 0), 0),
        GREATEST(COALESCE(b.total_sims, 0) - COALESCE(ph_contributions.total_picked, 0) - COALESCE(active_assignments.reserved_qty, 0), 0),
        COALESCE(
          CASE
            WHEN b.iccid_start ~ '^[0-9]+$' AND b.iccid_end ~ '^[0-9]+$'
              THEN GREATEST((b.iccid_end::numeric - b.iccid_start::numeric + 1), 0)::int
            ELSE NULL
          END,
          GREATEST(COALESCE(b.total_sims, 0), 0)
        )
      ) AS remaining_sims,
      COALESCE(b.total_sims, 0) AS total_sims,
      COALESCE(b.issued_sims, 0) AS issued_sims,
      CASE
        WHEN b.iccid_start ~ '^[0-9]+$'
          THEN LPAD((b.iccid_start::numeric + COALESCE(b.issued_sims, 0))::text, LENGTH(b.iccid_start), '0')
        ELSE b.iccid_start
      END AS iccid_start,
      b.iccid_end
    FROM boxes b
    LEFT JOIN cartons c ON b.carton_id = c.id
    LEFT JOIN carton_order co ON c.id = co.carton_id
    LEFT JOIN carton_totals ct ON ct.mvno_id = COALESCE(b.mvno_id, c.mvno_id)
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM((abq.item->>'quantity')::int), 0) AS reserved_qty
      FROM stock_issuance_requests sir
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sir.assigned_box_quantities, '[]'::jsonb)) AS abq(item)
      WHERE sir.status NOT IN ('COMPLETED', 'REJECTED', 'CANCELLED')
        AND abq.item->>'box_id' = b.id::text
    ) active_assignments ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM((item->>'quantity')::int), 0) AS total_picked
      FROM pick_history ph_inner
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ph_inner.assigned_boxes, '[]'::jsonb)) AS item
      WHERE item->>'box_id' = b.id::text
        AND NOT EXISTS (
          SELECT 1 FROM stock_audit_logs sal
          WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
            AND sal.details->>'pick_history_id' = ph_inner.id::text
        )
    ) ph_contributions ON true
    ${whereSql}
    ORDER BY co.carton_seq NULLS LAST, b.box_number NULLS LAST, c.carton_number NULLS LAST
    `,
    values
  );
  return result.rows;
}

async function reverseIssuedStockMovement(
  request: StockIssuanceRequest,
  reversedBy: string,
  reason?: string
): Promise<{ reversed_units: number }> {
  if (!request.requester_id) {
    throw new Error('Request has no requester/distributor');
  }

  const assignedBoxes = Array.isArray(request.assigned_box_quantities) ? request.assigned_box_quantities : [];
  const assignedEsims = Array.isArray(request.assigned_esim_iccids) ? request.assigned_esim_iccids : [];

  if (request.sim_type === 'ESIM') {
    if (!assignedEsims.length) {
      return { reversed_units: 0 };
    }

    const esimRollbackResult = await query(
      `
      UPDATE esim_stock
      SET status = 'available',
          issued_to_distributor_id = NULL,
          issued_date = NULL,
          distribution_id = NULL,
          updated_at = NOW()
      WHERE iccid = ANY($1::text[])
        AND mvno_id = $2
        AND issued_to_distributor_id = $3
      RETURNING iccid
      `,
      [assignedEsims, request.mvno_id, request.requester_id]
    );

    return { reversed_units: esimRollbackResult.rowCount || 0 };
  }

  const boxQuantities = assignedBoxes
    .map((item: any) => ({
      box_id: item?.box_id,
      quantity: Number(item?.quantity || 0),
    }))
    .filter((item: any) => item.box_id && item.quantity > 0);

  if (!boxQuantities.length) {
    return { reversed_units: 0 };
  }

  let restoredUnits = 0;

  await transaction(async (client) => {
    for (const item of boxQuantities) {
      const updateResult = await client.query(
        `
        WITH target AS (
          SELECT
            b.id,
            COALESCE(b.issued_sims, 0)::int AS issued_before,
            COALESCE(b.remaining_sims, 0)::int AS remaining_before,
            COALESCE(b.total_sims, 0)::int AS total_before
          FROM boxes b
          WHERE b.id = $1
          FOR UPDATE
        ),
        calc AS (
          SELECT
            t.id,
            LEAST($2::int, GREATEST(t.issued_before, 0))::int AS rollback_qty,
            t.issued_before,
            t.remaining_before,
            t.total_before
          FROM target t
        )
        UPDATE boxes b
        SET remaining_sims = LEAST(
              GREATEST(calc.total_before, 0),
              calc.remaining_before + calc.rollback_qty
            ),
            issued_sims = GREATEST(calc.issued_before - calc.rollback_qty, 0),
            status = CASE
              WHEN calc.rollback_qty > 0 THEN 'IN_STORE'::sim_status
              ELSE b.status
            END
        FROM calc
        WHERE b.id = calc.id
        RETURNING calc.rollback_qty::int AS restored_qty
        `,
        [item.box_id, item.quantity]
      );

      restoredUnits += Number(updateResult.rows[0]?.restored_qty || 0);
    }
  });

  const reversedUnits = restoredUnits;

  return { reversed_units: reversedUnits };
}

async function hasAuditAction(requestId: string, action: string): Promise<boolean> {
  const result = await query(
    `SELECT 1
     FROM stock_audit_logs
     WHERE request_id = $1
       AND action = $2
     LIMIT 1`,
    [requestId, action]
  );
  return result.rows.length > 0;
}

async function updateRequestStatusWithFallback(
  requestId: string,
  statuses: string[],
  extraSetSql = '',
  extraParams: any[] = []
): Promise<StockIssuanceRequest> {
  for (const status of statuses) {
    try {
      const params = [status, ...extraParams, requestId];
      const result = await query(
        `UPDATE stock_issuance_requests
         SET status = $1,
             updated_at = NOW()
             ${extraSetSql}
         WHERE id = $${params.length}
         RETURNING *`,
        params
      );

      if (result.rows[0]) {
        return result.rows[0];
      }
    } catch (error: any) {
      if (error?.code === '23514') {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Unable to set request status. Tried: ${statuses.join(', ')}`);
}

export async function reverseDistributionToApproval(
  requestId: string,
  reversedBy: string,
  reason?: string
): Promise<StockIssuanceRequest> {
  const request = await getStockIssuanceRequestById(requestId);
  if (!request) {
    throw new Error('Request not found');
  }

  if (!(request.status === 'COMPLETED' || request.status === 'STOCK_ISSUED')) {
    throw new Error(`Cannot reverse request in status '${request.status}'. Only COMPLETED/STOCK_ISSUED can be reversed.`);
  }

  const rollback = await reverseIssuedStockMovement(request, reversedBy, reason || 'Reverse distribution to approval');

  await addAuditLog(
    request.id,
    'DISTRIBUTION_REVERSED',
    {
      sim_type: request.sim_type,
      reversed_units: rollback.reversed_units,
      reason: reason || 'Reverse distribution to approval',
      stock_rollback_applied: rollback.reversed_units > 0,
    },
    reversedBy
  );

  return updateRequestStatusWithFallback(requestId, ['READY_FOR_APPROVAL', 'WAITING_FOR_APPROVAL', 'LEVEL_2_APPROVED']);
}

// Reverse manual provisioning - returns stock directly to pool
export async function reverseManualProvisioning(
  recordId: string,
  reversedBy: string,
  reason?: string
): Promise<{ success: boolean; message: string; reversed_units: number }> {
  // Find the manual provisioning record
  const pickHistoryResult = await query(
    'SELECT * FROM pick_history WHERE id = $1 OR manual_request_id = $1 LIMIT 1',
    [recordId]
  );
  
  if (pickHistoryResult.rows.length === 0) {
    throw new Error('Manual provisioning record not found');
  }
  
  const ph = pickHistoryResult.rows[0];
  
  // Check if already reversed (manual provisioning records use details->>'pick_history_id' since ph.id is not an FK to stock_issuance_requests)
  const alreadyReversed = await query(
    `SELECT 1 FROM stock_audit_logs
     WHERE action = 'MANUAL_DISTRIBUTION_REVERSED'
       AND details->>'pick_history_id' = $1
     LIMIT 1`,
    [ph.id]
  );
  
  if (alreadyReversed.rows.length > 0) {
    throw new Error('This distribution has already been reversed');
  }
  
  let reversedUnits = 0;
  
  // Handle physical SIMs - return boxes to stock
  if (ph.sim_type === 'PHYSICAL' && ph.assigned_boxes) {
    const assignedBoxes = ph.assigned_boxes;
    
    for (const boxAssignment of assignedBoxes) {
      const boxId = boxAssignment.box_id;
      const quantity = boxAssignment.quantity || 0;
      
      // Update box remaining_sims to restore the distributed quantity
      await query(
        'UPDATE boxes SET remaining_sims = remaining_sims + $1 WHERE id = $2',
        [quantity, boxId]
      );
      
      // Update sim_stock to restore the distributed SIMs
      // Note: sim_stock table has iccid_start/iccid_end columns, not individual iccid rows
      await query(
        `UPDATE sim_stock 
         SET assigned_sims = GREATEST(assigned_sims - $2, 0),
             status = CASE WHEN assigned_sims - $2 <= 0 THEN 'available' ELSE status END,
             mvno_id = CASE WHEN assigned_sims - $2 <= 0 THEN NULL ELSE mvno_id END,
             last_updated = NOW()
         WHERE box_id = $1 AND status = 'distributed'`,
        [boxId, quantity]
      );
      
      reversedUnits += quantity;
    }
  }
  
  // Handle eSIMs - return to available status
  if (ph.sim_type === 'ESIM' && ph.assigned_esims) {
    const assignedEsims = ph.assigned_esims;
    
    await query(
      'UPDATE esim_stock SET status = \'available\', issued_to_distributor_id = NULL, issued_date = NULL WHERE iccid = ANY($1) AND status = \'distributed\'',
      [assignedEsims]
    );
    
    reversedUnits = assignedEsims.length;
  }
  
  // Add audit log - pass null for requestId because ph.id is a pick_history UUID,
  // not a stock_issuance_requests UUID, and the FK would be violated.
  await addAuditLog(
    null,
    'MANUAL_DISTRIBUTION_REVERSED',
    {
      pick_history_id: ph.id,
      sim_type: ph.sim_type,
      distributor_id: ph.distributor_id,
      mvno_id: ph.mvno_id,
      reversed_units: reversedUnits,
      reason: reason || 'Manual provisioning reversal - stock returned to pool',
      stock_rollback_applied: reversedUnits > 0,
    },
    reversedBy
  );
  
  return {
    success: true,
    message: `Successfully reversed ${reversedUnits} ${ph.sim_type} units and returned them to stock pool`,
    reversed_units: reversedUnits
  };
}

// Cancel in Approve Stock flow: return request to Stock Requests and rollback issued stock once
export async function cancelStockRequest(
  requestId: string,
  cancelledBy: string
): Promise<StockIssuanceRequest> {
  const request = await getStockIssuanceRequestById(requestId);
  if (!request) {
    throw new Error('Request not found');
  }
  
  const cancellableStatuses = ['PENDING', 'WAITING_FOR_APPROVAL', 'AWAITING_EMAIL_APPROVAL', 'READY_FOR_APPROVAL', 'LEVEL_1_APPROVED', 'LEVEL_2_APPROVED', 'STOCK_ISSUED', 'COMPLETED'];
  if (!cancellableStatuses.includes(request.status)) {
    throw new Error(`Cannot cancel request with status '${request.status}'. Only pending or approved requests can be cancelled.`);
  }

  if (request.status === 'STOCK_ISSUED' || request.status === 'COMPLETED') {
    const rollbackAlreadyApplied = await hasAuditAction(requestId, 'CANCELLATION_ROLLBACK_APPLIED');
    if (!rollbackAlreadyApplied) {
      const rollback = await reverseIssuedStockMovement(request, cancelledBy, 'Cancellation rollback');
      await addAuditLog(
        requestId,
        'CANCELLATION_ROLLBACK_APPLIED',
        {
          sim_type: request.sim_type,
          reversed_units: rollback.reversed_units,
          duplicate_safe: true,
        },
        cancelledBy
      );
    }
  }
  
  const updated = await updateRequestStatusWithFallback(
    requestId,
    ['PENDING', 'READY_FOR_APPROVAL', 'WAITING_FOR_APPROVAL'],
    `,
     assigned_box_quantities = '[]'::jsonb,
     assigned_esim_iccids = NULL,
     cancelled_by = $2,
     cancelled_at = NOW()`,
    [cancelledBy]
  );

  logLine('INF', 'CANCEL', `Request ${requestId} cancelled by ${cancelledBy}`);
  return updated;
}

export async function assignIssuanceRequest(requestId: string, payload: any): Promise<StockIssuanceRequest> {
  const simType = String(payload?.sim_type || '').trim().toUpperCase() || undefined;
  const assignedBoxes = payload?.assigned_box_quantities ?? null;
  const assignedEsims = payload?.assigned_esim_iccids ?? null;

  const existing = await getStockIssuanceRequestById(requestId);
  if (!existing) {
    throw new Error('Request not found');
  }

  const hasAssignedBoxes = Array.isArray(existing.assigned_box_quantities) && existing.assigned_box_quantities.length > 0;
  const hasAssignedEsims = Array.isArray(existing.assigned_esim_iccids) && existing.assigned_esim_iccids.length > 0;
  if (hasAssignedBoxes || hasAssignedEsims) {
    throw new Error('Stock has already been assigned for this request');
  }

  // Normalize to DB column formats
  const assignedBoxQuantitiesJson = assignedBoxes ? JSON.stringify(assignedBoxes) : JSON.stringify([]);
  let assignedEsimIccids = Array.isArray(assignedEsims) ? assignedEsims : [];
  if (simType === 'ESIM') {
    assignedEsimIccids = sortEsimIccids(assignedEsimIccids);
  }

  if (simType === 'ESIM' && assignedEsimIccids.length === 0) {
    throw new Error('Please select at least one eSIM before sending for approval');
  }
  if (simType !== 'ESIM') {
    const physicalAssignments = Array.isArray(assignedBoxes) ? assignedBoxes : [];
    if (physicalAssignments.length === 0) {
      throw new Error('Please select at least one box quantity before sending for approval');
    }
  }

  const result = await query(
    `UPDATE stock_issuance_requests
     SET assigned_box_quantities = $1,
         assigned_esim_iccids = $2,
         status = 'PENDING',
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [assignedBoxQuantitiesJson, assignedEsimIccids, requestId]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Request not found');
  return row;
}

export async function getPlatformUserByEmail(email: string): Promise<any | null> {
  const result = await query(
    `SELECT * FROM platform_users WHERE email = $1 LIMIT 1`,
    [email]
  );
  return result.rows[0] || null;
}

// ==================== BOX STOCK SUMMARY (PHYSICAL SIMS) ====================

export async function getBoxStockSummary(params: {
  limit?: number;
  offset?: number;
  search?: string;
  carton_number?: string;
  box_number?: string;
  mvno?: string;
  mvno_id?: string;
  status?: string;
  iccid_from?: string;
  iccid_to?: string;
}): Promise<BoxStockSummaryRow[]> {
  const where: string[] = [];
  const values: any[] = [];

  const add = (sql: string, value: any) => {
    values.push(value);
    where.push(sql.replace('$?', `$${values.length}`));
  };

  // Handle search filter - it has 4 conditions so we need to add values manually
  if (params.search) {
    const searchVal = `%${params.search}%`;
    values.push(searchVal); // carton_number
    values.push(searchVal); // box_number
    values.push(searchVal); // iccid_start
    values.push(searchVal); // iccid_end
    where.push(
      `(c.carton_number ILIKE $${values.length - 3} OR b.box_number::text ILIKE $${values.length - 2} OR b.iccid_start ILIKE $${values.length - 1} OR b.iccid_end ILIKE $${values.length})`
    );
  }
  if (params.carton_number) add(`c.carton_number ILIKE $?`, `%${params.carton_number}%`);
  if (params.box_number) add(`b.box_number::text ILIKE $?`, `%${params.box_number}%`);
  if (params.mvno) add(`m.name::text ILIKE $?`, `%${params.mvno}%`);
  if (params.mvno_id) add(`COALESCE(b.mvno_id, c.mvno_id) = $?::uuid`, params.mvno_id);
  if (params.status) add(`b.status = $?`, params.status);
  if (params.iccid_from) add(`b.iccid_start >= $?`, params.iccid_from);
  if (params.iccid_to) add(`b.iccid_end <= $?`, params.iccid_to);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(params.limit ?? 1000, 1), 5000);
  const offset = Math.max(params.offset ?? 0, 0);

  values.push(limit);
  values.push(offset);

  const result = await query(
    `
    WITH mvno_box_totals AS (
      SELECT mvno_id, COUNT(*)::int AS total_boxes
      FROM boxes
      WHERE mvno_id IS NOT NULL
      GROUP BY mvno_id
    ),
    carton_order AS (
      SELECT c.id AS carton_id, c.carton_number, c.mvno_id,
             NULLIF(
               regexp_replace(
                 CASE
                   WHEN POSITION('/' IN c.carton_number) > 0 THEN SPLIT_PART(c.carton_number, '/', 1)
                   ELSE c.carton_number
                 END,
                 '[^0-9]',
                 '',
                 'g'
               ),
               ''
             )::int AS carton_seq
      FROM cartons c
    )
    SELECT
      b.id AS box_id,
      c.carton_number,
      COALESCE(b.box_number, 0) AS box_number,
      -- Calculate cumulative box number: (carton_seq - 1) * boxes_per_carton + box_number
      -- Format as "current_box/total_boxes"
      (
        SELECT mt.total_boxes
        FROM mvno_box_totals mt
        WHERE mt.mvno_id = COALESCE(b.mvno_id, c.mvno_id)
      ) AS total_mvno_boxes,
      ((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(b.box_number, 0)) AS cumulative_box_number,
      -- Display format: "cumulative/total" e.g., "21/800"
      (((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(b.box_number, 0))::text || '/' ||
        COALESCE(
          (SELECT mt.total_boxes FROM mvno_box_totals mt WHERE mt.mvno_id = COALESCE(b.mvno_id, c.mvno_id))::text,
          '0'
        )
      ) AS box_display,
      COALESCE(m.name::text, 'UNKNOWN') AS mvno,
      b.iccid_start,
      b.iccid_end,
      COALESCE(b.total_sims, 0) AS total_sims,
      LEAST(
        GREATEST(COALESCE(b.remaining_sims, 0) - COALESCE(active_assignments.reserved_qty, 0), 0),
        GREATEST(COALESCE(b.total_sims, 0) - COALESCE(ph_contributions.total_picked, 0) - COALESCE(active_assignments.reserved_qty, 0), 0),
        COALESCE(
          CASE
            WHEN b.iccid_start ~ '^[0-9]+$' AND b.iccid_end ~ '^[0-9]+$'
              THEN GREATEST((b.iccid_end::numeric - b.iccid_start::numeric + 1), 0)::int
            ELSE NULL
          END,
          GREATEST(COALESCE(b.total_sims, 0), 0)
        )
      ) AS remaining_sims,
      COALESCE(b.issued_sims, 0) AS issued_sims,
      CASE WHEN COALESCE(b.total_sims, 0) > 0
        THEN ROUND((LEAST(GREATEST(COALESCE(b.remaining_sims, 0) - COALESCE(active_assignments.reserved_qty, 0), 0), GREATEST(COALESCE(b.total_sims, 0) - COALESCE(ph_contributions.total_picked, 0) - COALESCE(active_assignments.reserved_qty, 0), 0))::numeric / b.total_sims::numeric) * 100)
        ELSE 0
      END AS remaining_percent,
      COALESCE(b.status::text, 'unknown') AS status
    FROM boxes b
    LEFT JOIN cartons c ON b.carton_id = c.id
    LEFT JOIN carton_order co ON c.id = co.carton_id
    LEFT JOIN mvnos m ON COALESCE(b.mvno_id, c.mvno_id) = m.id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM((abq.item->>'quantity')::int), 0) AS reserved_qty
      FROM stock_issuance_requests sir
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sir.assigned_box_quantities, '[]'::jsonb)) AS abq(item)
      WHERE sir.status NOT IN ('COMPLETED', 'REJECTED', 'CANCELLED')
        AND abq.item->>'box_id' = b.id::text
    ) active_assignments ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM((item->>'quantity')::int), 0) AS total_picked
      FROM pick_history ph_inner
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ph_inner.assigned_boxes, '[]'::jsonb)) AS item
      WHERE item->>'box_id' = b.id::text
        AND NOT EXISTS (
          SELECT 1 FROM stock_audit_logs sal
          WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
            AND sal.details->>'pick_history_id' = ph_inner.id::text
        )
    ) ph_contributions ON true
    ${whereSql}
    ORDER BY m.name NULLS LAST, co.carton_seq NULLS LAST, b.box_number NULLS LAST
    LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values
  );

  return result.rows;
}

export async function getBoxStockSummaryCount(params: {
  search?: string;
  carton_number?: string;
  box_number?: string;
  mvno?: string;
  mvno_id?: string;
  status?: string;
  iccid_from?: string;
  iccid_to?: string;
}): Promise<number> {
  const where: string[] = [];
  const values: any[] = [];

  const add = (sql: string, value: any) => {
    values.push(value);
    where.push(sql.replace('$?', `$${values.length}`));
  };

  // Handle search filter - it has 4 conditions so we need to add values manually
  if (params.search) {
    const searchVal = `%${params.search}%`;
    values.push(searchVal); // carton_number
    values.push(searchVal); // box_number
    values.push(searchVal); // iccid_start
    values.push(searchVal); // iccid_end
    where.push(
      `(c.carton_number ILIKE $${values.length - 3} OR b.box_number::text ILIKE $${values.length - 2} OR b.iccid_start ILIKE $${values.length - 1} OR b.iccid_end ILIKE $${values.length})`
    );
  }

  if (params.carton_number) add(`c.carton_number ILIKE $?`, `%${params.carton_number}%`);
  if (params.box_number) add(`b.box_number::text ILIKE $?`, `%${params.box_number}%`);
  if (params.mvno) add(`m.name::text ILIKE $?`, `%${params.mvno}%`);
  if (params.mvno_id) add(`COALESCE(b.mvno_id, c.mvno_id) = $?::uuid`, params.mvno_id);
  if (params.status) add(`b.status = $?`, params.status);
  if (params.iccid_from) add(`b.iccid_start >= $?`, params.iccid_from);
  if (params.iccid_to) add(`b.iccid_end <= $?`, params.iccid_to);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const result = await query(
    `
    SELECT COUNT(*)::int AS count
    FROM boxes b
    LEFT JOIN cartons c ON b.carton_id = c.id
    LEFT JOIN mvnos m ON COALESCE(b.mvno_id, c.mvno_id) = m.id
    ${whereSql}
    `,
    values
  );
  return result.rows[0]?.count || 0;
}

// ==================== ESIM STOCK ====================

export async function getTotalEsimStock(): Promise<EsimTotalsRow> {
  const result = await query(
    `
    SELECT
      COUNT(*)::int AS total_esims,
      COUNT(*) FILTER (WHERE status = 'available')::int AS total_available,
      COUNT(*) FILTER (WHERE status = 'assigned')::int AS total_assigned,
      COUNT(*) FILTER (WHERE status = 'active')::int AS total_activated
    FROM esim_stock
    `
  );
  return result.rows[0];
}

export async function getEsimStockByOperator(): Promise<EsimByOperatorRow[]> {
  const result = await query(
    `
    SELECT
      COALESCE(m.name::text, e.operator::text, 'UNKNOWN') AS operator,
      COUNT(*)::int AS total_esims,
      COUNT(*) FILTER (WHERE COALESCE(e.status, 'available') = 'available')::int AS available,
      COUNT(*) FILTER (WHERE COALESCE(e.status, 'available') = 'assigned')::int AS assigned,
      COUNT(*) FILTER (WHERE COALESCE(e.status, 'available') = 'active')::int AS activated
    FROM esim_stock e
    LEFT JOIN mvnos m ON e.mvno_id = m.id
    GROUP BY COALESCE(m.name::text, e.operator::text, 'UNKNOWN')
    ORDER BY operator
    `
  );
  return result.rows;
}

export async function getEsimStock(params: {
  limit?: number;
  offset?: number;
  mvno?: string;
  status?: string;
  search?: string;
}): Promise<EsimStockRow[]> {
  const where: string[] = [];
  const values: any[] = [];
  const add = (sql: string, value: any) => {
    values.push(value);
    where.push(sql.replace('$?', `$${values.length}`));
  };

  if (params.mvno) add(`COALESCE(m.name::text, e.operator::text, '') ILIKE $?`, `%${params.mvno}%`);
  if (params.status) add(`e.status = $?`, params.status);
  // Handle search filter - it has 2 conditions so we need to add values manually
  if (params.search) {
    const searchVal = `%${params.search}%`;
    values.push(searchVal); // iccid
    values.push(searchVal); // imsi
    where.push(
      `(e.iccid ILIKE $${values.length - 1} OR e.imsi ILIKE $${values.length})`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(params.limit ?? 1000, 1), 5000);
  const offset = Math.max(params.offset ?? 0, 0);
  values.push(limit);
  values.push(offset);

  const result = await query(
    `
    SELECT
      e.id,
      e.iccid,
      e.imsi,
      COALESCE(m.name::text, e.operator::text, 'UNKNOWN') AS operator,
      NULL::text AS msisdn,
      e.mvno_id,
      COALESCE(e.status, 'available') AS status,
      e.issued_to_distributor_id,
      e.issued_date,
      e.distribution_id,
      e.created_at,
      e.created_at AS updated_at
    FROM esim_stock e
    LEFT JOIN mvnos m ON e.mvno_id = m.id
    ${whereSql}
    -- ICCID ordering: sort by the sequential prefix (first 19 digits), then suffix digit
    ORDER BY
      SUBSTRING(COALESCE(e.iccid, '') FROM 1 FOR 19) ASC,
      SUBSTRING(COALESCE(e.iccid, '') FROM 20) ASC,
      e.id ASC
    LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values
  );
  return result.rows;
}

export async function getEsimStockCount(params: { mvno?: string; status?: string; search?: string }): Promise<number> {
  const where: string[] = [];
  const values: any[] = [];
  const add = (sql: string, value: any) => {
    values.push(value);
    where.push(sql.replace('$?', `$${values.length}`));
  };
  if (params.mvno) add(`COALESCE(m.name::text, e.operator::text, '') ILIKE $?`, `%${params.mvno}%`);
  if (params.status) add(`e.status = $?`, params.status);
  // Handle search filter - it has 2 conditions so we need to add values manually
  if (params.search) {
    const searchVal = `%${params.search}%`;
    values.push(searchVal); // iccid
    values.push(searchVal); // imsi
    where.push(
      `(e.iccid ILIKE $${values.length - 1} OR e.imsi ILIKE $${values.length})`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await query(
    `
    SELECT COUNT(*)::int AS count
    FROM esim_stock e
    LEFT JOIN mvnos m ON e.mvno_id = m.id
    ${whereSql}
    `,
    values
  );
  return result.rows[0]?.count || 0;
}

// ==================== EXPORT AND AUDIT ====================

export interface ExportFilters {
  mvno_id?: string;
  distributor_id?: string;
  date_from?: string;
  date_to?: string;
  format?: string;
  user_email?: string;
  user_role?: string;
}

export async function exportDistributionHistory(filters: ExportFilters): Promise<{ success: boolean; message: string; data?: any[]; csv?: string }> {
  const values: any[] = [];
  const whereClauses: string[] = [];

  // Build WHERE clauses for filters
  if (filters.mvno_id) {
    values.push(filters.mvno_id);
    whereClauses.push(`x.mvno_id = $${values.length}`);
  }
  if (filters.distributor_id) {
    values.push(filters.distributor_id);
    whereClauses.push(`x.distributor_id = $${values.length}`);
  }
  if (filters.date_from) {
    values.push(filters.date_from);
    whereClauses.push(`x.picked_at >= $${values.length}::timestamptz`);
  }
  if (filters.date_to) {
    values.push(filters.date_to);
    whereClauses.push(`x.picked_at <= $${values.length}::timestamptz`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const result = await query(
    `
    WITH combined AS (
      SELECT
        COALESCE(ph.request_id, ph.manual_request_id, '')::text AS request_id,
        ph.issued_at AS picked_at,
        COALESCE(d.name, 'Unknown')::text AS distributor_name,
        COALESCE(ph.distributor_id, sir.requester_id) AS distributor_id,
        UPPER(COALESCE(ph.sim_type, sir.sim_type, 'PHYSICAL'))::text AS sim_type,
        COALESCE(ph.mvno_name::text, m.name::text, '')::text AS mvno,
        ph.mvno_id AS mvno_id,
        COALESCE(ph.carton_number, '')::text AS carton_number,
        COALESCE(ph.box_number::text, '')::text AS box_number,
        COALESCE(ph.quantity, 0)::int AS sims_picked,
        COALESCE(ph.distribution_type, 'APPROVED')::text AS distribution_type,
        COALESCE(ph.issued_by, 'System')::text AS issued_by,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.request_id = ph.request_id AND sal.action = 'DISTRIBUTION_REVERSED'
          ) THEN 'REVERSED'::text
          ELSE COALESCE(sir.status, 'COMPLETED')::text
        END AS distribution_status
      FROM pick_history ph
      LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
      LEFT JOIN distributors d ON COALESCE(ph.distributor_id, sir.requester_id) = d.id
      LEFT JOIN mvnos m ON ph.mvno_id = m.id

      UNION ALL

      SELECT
        ''::text AS request_id,
        bpr.picked_at AS picked_at,
        COALESCE(d2.name, 'Unknown')::text AS distributor_name,
        bpr.distributor_id AS distributor_id,
        'PHYSICAL'::text AS sim_type,
        COALESCE(m2.name, '')::text AS mvno,
        c2.mvno_id AS mvno_id,
        COALESCE(c2.carton_number, '')::text AS carton_number,
        COALESCE(b2.box_number::text, '')::text AS box_number,
        COALESCE(bpr.sims_picked, 0)::int AS sims_picked,
        'MANUAL'::text AS distribution_type,
        'System'::text AS issued_by,
        'COMPLETED'::text AS distribution_status
      FROM box_pick_records bpr
      LEFT JOIN boxes b2 ON bpr.box_id = b2.id
      LEFT JOIN cartons c2 ON b2.carton_id = c2.id
      LEFT JOIN mvnos m2 ON c2.mvno_id = m2.id
      LEFT JOIN distributors d2 ON bpr.distributor_id = d2.id
      WHERE bpr.box_id IS NOT NULL
    )
    SELECT
      x.request_id,
      x.picked_at,
      x.distributor_name,
      x.sim_type,
      x.mvno,
      x.carton_number,
      x.box_number,
      x.sims_picked,
      x.distribution_type,
      x.issued_by,
      x.distribution_status
    FROM combined x
    ${whereSql}
    ORDER BY x.picked_at DESC
    LIMIT 50000
    `,
    values
  );

  const data = result.rows;

  if (filters.format === 'csv') {
    const headers = ['request_id', 'picked_at', 'distributor_name', 'sim_type', 'mvno', 'carton_number', 'box_number', 'sims_picked', 'distribution_type', 'issued_by', 'distribution_status'];
    const csvRows = [
      headers.join(','),
      ...data.map(row => 
        headers.map(h => {
          const val = row[h];
          if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
            return `"${String(val).replace(/"/g, '""')}"`;
          }
          return val || '';
        }).join(',')
      )
    ];
    return { success: true, message: `Exported ${data.length} records`, data, csv: csvRows.join('\n') };
  }

  return { success: true, message: `Exported ${data.length} records`, data };
}

export async function logExportAction(params: {
  action: string;
  user_id?: string | null;
  user_email: string;
  user_role: string;
  filters: string;
  record_count: number;
}): Promise<void> {
  await query(
    `INSERT INTO audit_logs (action, user_id, user_email, user_role, details, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      params.action,
      params.user_id,
      params.user_email,
      params.user_role,
      JSON.stringify({
        filters: params.filters,
        record_count: params.record_count,
      })
    ]
  );
}

// ==================== CURRENT STOCK VIEW (DASHBOARD) ====================

export async function getCurrentStockView(): Promise<CurrentStockRow[]> {
  const result = await query(
    `
    WITH physical AS (
      SELECT
        COALESCE(m.name::text, 'UNKNOWN') AS mvno,
        'PHYSICAL'::text AS sim_type,
        SUM(COALESCE(b.total_sims, 0))::int AS total_stock,
        SUM(COALESCE(b.remaining_sims, 0))::int AS in_store,
        SUM(COALESCE(b.issued_sims, 0))::int AS issued,
        0::int AS activated,
        0::int AS sold,
        0::int AS failed
      FROM boxes b
      LEFT JOIN mvnos m ON b.mvno_id = m.id
      GROUP BY COALESCE(m.name::text, 'UNKNOWN')
    ),
    esim AS (
      SELECT
        COALESCE(m.name::text, e.operator::text, 'UNKNOWN') AS mvno,
        'ESIM'::text AS sim_type,
        COUNT(*)::int AS total_stock,
        COUNT(*) FILTER (WHERE COALESCE(e.status, 'available') = 'available')::int AS in_store,
        COUNT(*) FILTER (WHERE COALESCE(e.status, 'available') = 'assigned')::int AS issued,
        COUNT(*) FILTER (WHERE COALESCE(e.status, 'available') = 'active')::int AS activated,
        0::int AS sold,
        0::int AS failed
      FROM esim_stock e
      LEFT JOIN mvnos m ON e.mvno_id = m.id
      GROUP BY COALESCE(m.name::text, e.operator::text, 'UNKNOWN')
    ),
    combined AS (
      SELECT * FROM physical
      UNION ALL
      SELECT * FROM esim
    ),
    totals AS (
      SELECT
        'TOTAL'::text AS mvno,
        sim_type,
        SUM(total_stock)::int AS total_stock,
        SUM(in_store)::int AS in_store,
        SUM(issued)::int AS issued,
        SUM(activated)::int AS activated,
        SUM(sold)::int AS sold,
        SUM(failed)::int AS failed
      FROM combined
      GROUP BY sim_type
    )
    SELECT *
    FROM (
      SELECT * FROM combined
      UNION ALL
      SELECT * FROM totals
    ) stock
    ORDER BY (mvno = 'TOTAL')::int, mvno, sim_type
    `
  );
  return result.rows;
}

// Get stock issuance request by ID
export async function getStockIssuanceRequestById(id: string): Promise<StockIssuanceRequest | null> {
  const result = await query(
    'SELECT * FROM stock_issuance_requests WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

// Get stock issuance requests by MVNO
export async function getStockIssuanceRequestsByMvno(mvnoId: string): Promise<StockIssuanceRequest[]> {
  const result = await query(
    `SELECT 
      sir.*,
      d.name as distributor_name
    FROM stock_issuance_requests sir
    LEFT JOIN distributors d ON sir.requester_id = d.id
    WHERE sir.mvno_id = $1 
    ORDER BY sir.created_at DESC`,
    [mvnoId]
  );
  return result.rows;
}

// ==================== APPROVAL TOKEN OPERATIONS ====================

// Create approval tokens for a request
export async function createApprovalTokens(requestId: string): Promise<ApprovalToken[]> {
  const existing = await query(
    `SELECT *
     FROM stock_approval_tokens
     WHERE request_id = $1
       AND used = false
       AND expires_at > NOW()
     ORDER BY created_at`,
    [requestId]
  );
  if (existing.rows.length >= 2) {
    return existing.rows;
  }

  // First, get the request to check if it has custom approver emails
  const requestResult = await query(
    'SELECT * FROM stock_issuance_requests WHERE id = $1',
    [requestId]
  );
  const request = requestResult.rows[0];

  // Use request-specific approver emails if provided, otherwise fall back to config
  let level1Email = request?.level_1_approver_email;
  let level2Email = request?.level_2_approver_email;

  // If request doesn't have custom emails, try to get from config
  if (!level1Email || !level2Email) {
    const approversResult = await query(
      `SELECT approver_level, approver_email, COALESCE(approver_role, approver_level) AS approver_role
       FROM stock_approver_config
       WHERE is_active = true
         AND approver_level IN ('LEVEL_1', 'LEVEL_2')`
    );

    const level1Config = approversResult.rows.find((r: any) => r.approver_level === 'LEVEL_1');
    const level2Config = approversResult.rows.find((r: any) => r.approver_level === 'LEVEL_2');

    // Use config emails as fallback
    level1Email = level1Email || level1Config?.approver_email;
    level2Email = level2Email || level2Config?.approver_email;
  }

  if (!level1Email || !level2Email) {
    throw new Error('Approver emails must be configured either in the request or in stock_approver_config');
  }

  const level1 = { approver_email: level1Email, approver_role: 'LEVEL_1' };
  const level2 = { approver_email: level2Email, approver_role: 'LEVEL_2' };

  await query(
    `DELETE FROM stock_approval_tokens
     WHERE request_id = $1
       AND used = false`,
    [requestId]
  );

  const tokenLevel1 = generateApprovalTokenValue();
  const tokenLevel2 = generateApprovalTokenValue();

  const inserted = await query(
    `INSERT INTO stock_approval_tokens (request_id, approver_role, approver_email, token, expires_at)
     VALUES
       ($1, $2, $3, $4, NOW() + INTERVAL '24 hours'),
       ($1, $5, $6, $7, NOW() + INTERVAL '24 hours')
     RETURNING *`,
    [
      requestId,
      level1.approver_role || 'LEVEL_1',
      level1.approver_email,
      tokenLevel1,
      level2.approver_role || 'LEVEL_2',
      level2.approver_email,
      tokenLevel2,
    ]
  );

  return inserted.rows;
}

// Get approval token by token value
export async function getApprovalTokenByToken(token: string): Promise<ApprovalToken | null> {
  const result = await query(
    `SELECT * FROM stock_approval_tokens 
     WHERE token = $1 AND used = false AND expires_at > NOW()`,
    [token]
  );
  return result.rows[0] || null;
}

// Get active approval token by request and approver level
export async function getApprovalTokenByRequestAndLevel(
  requestId: string,
  level: 'LEVEL_1' | 'LEVEL_2'
): Promise<ApprovalToken | null> {
  const result = await query(
    `SELECT *
     FROM stock_approval_tokens
     WHERE request_id = $1
       AND approver_role = $2
       AND used = false
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [requestId, level]
  );
  return result.rows[0] || null;
}

// Get all approval tokens for a request
export async function getApprovalTokensByRequestId(
  requestId: string
): Promise<ApprovalToken[]> {
  const result = await query(
    `SELECT * FROM stock_approval_tokens WHERE request_id = $1 ORDER BY created_at DESC`,
    [requestId]
  );
  return result.rows;
}

// Validate and use token
export async function validateAndUseToken(
  token: string,
  approverEmail: string
): Promise<{ success: boolean; message: string; request_id?: string; approver_level?: string; approver_email?: string }> {
  const result = await query(
    'SELECT * FROM validate_and_use_token($1, $2)',
    [token, approverEmail]
  );
  return result.rows[0];
}

// Validate token for approval response (new consensus system)
export async function validateAndUseTokenForApproval(
  token: string,
  action: string
): Promise<{ success: boolean; message: string; request_id?: string; email?: string }> {
  try {
    const result = await query(
      'SELECT * FROM record_approval_response($1, $2)',
      [token, action]
    );
    return result.rows[0] || { success: false, message: 'No response recorded' };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

// Add audit log
export async function addAuditLog(
  requestId: string | null,
  action: string,
  details: any,
  performedBy?: string,
  performedByEmail?: string
): Promise<void> {
  await query(
    `INSERT INTO stock_audit_logs (request_id, action, details, performed_by, performed_by_email)
     VALUES ($1, $2, $3, $4, $5)`,
    [requestId, action, JSON.stringify(details), performedBy, performedByEmail]
  );
}

// Generate pick history after L2 approval
export async function generatePickHistory(requestId: string): Promise<void> {
  // Get the request details
  const requestResult = await query(
    'SELECT * FROM stock_issuance_requests WHERE id = $1',
    [requestId]
  );
  
  if (requestResult.rows.length === 0) {
    throw new Error('Request not found');
  }
  
  const request = requestResult.rows[0];
  
  // Get MVNO name
  let mvnoName = '';
  if (request.mvno_id) {
    const mvnoResult = await query('SELECT name FROM mvnos WHERE id = $1', [request.mvno_id]);
    mvnoName = mvnoResult.rows[0]?.name || '';
  }
  
  // Extract carton and box numbers from assigned_box_quantities
  let cartonNumber = '';
  let boxNumber = null;
  
  if (request.assigned_box_quantities && Array.isArray(request.assigned_box_quantities) && request.assigned_box_quantities.length > 0) {
    // Get first box details
    const firstBox = request.assigned_box_quantities[0];
    if (firstBox.box_id) {
      const boxResult = await query(
        `SELECT b.box_number, c.carton_number 
         FROM boxes b 
         JOIN cartons c ON b.carton_id = c.id 
         WHERE b.id = $1`,
        [firstBox.box_id]
      );
      if (boxResult.rows.length > 0) {
        cartonNumber = boxResult.rows[0].carton_number;
        boxNumber = boxResult.rows[0].box_number;
      }
    }
  }
  
  // Compute actual distributed quantity from assignments (not from request.quantity which is the requested amount)
  const assignedBoxQtys = Array.isArray(request.assigned_box_quantities) ? request.assigned_box_quantities : [];
  const assignedEsimIccidsRaw = Array.isArray(request.assigned_esim_iccids) ? request.assigned_esim_iccids : [];
  const simTypeUpper = String(request.sim_type || '').trim().toUpperCase();
  const assignedEsimIccids = simTypeUpper === 'ESIM' ? sortEsimIccids(assignedEsimIccidsRaw) : assignedEsimIccidsRaw;
  const actualQuantity = simTypeUpper === 'ESIM'
    ? assignedEsimIccids.length
    : assignedBoxQtys.reduce((sum: number, item: any) => sum + (Number(item?.quantity) || 0), 0);

  // Look up the distribution_id from box_pick_records (created by distributePhysicalBoxes moments ago)
  let distributionId: string | null = null;
  if (simTypeUpper !== 'ESIM') {
    const distResult = await query(
      `SELECT distribution_id FROM box_pick_records
       WHERE distributor_id = $1
       ORDER BY picked_at DESC LIMIT 1`,
      [request.requester_id]
    );
    distributionId = distResult.rows[0]?.distribution_id || null;
  }

  // Insert into pick_history
  await query(
    `INSERT INTO pick_history (
      request_id, distributor_id, mvno_id, mvno_name, sim_type, quantity,
      carton_number, box_number, assigned_boxes, assigned_esims,
      approved_by_l1, approved_by_l1_email,
      approved_by_l2, approved_by_l2_email,
      issued_at, distribution_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      requestId,
      request.requester_id,
      request.mvno_id,
      mvnoName,
      simTypeUpper,
      actualQuantity || request.quantity,
      cartonNumber,
      boxNumber,
      JSON.stringify(request.assigned_box_quantities),
      JSON.stringify(assignedEsimIccids),
      request.level_1_approver_id,
      request.level_1_approver_email,
      request.level_2_approver_id,
      request.level_2_approver_email,
      new Date(),
      distributionId
    ]
  );
}

// Update request status
export async function updateRequestStatus(requestId: string, status: string): Promise<void> {
  await query(
    'UPDATE stock_issuance_requests SET status = $1, updated_at = NOW() WHERE id = $2',
    [status, requestId]
  );
}

// Approve Level 1
export async function approveLevel1(
  requestId: string,
  approverId: string,
  approverEmail: string
): Promise<{ success: boolean; message: string }> {
  const result = await query(
    'SELECT * FROM approve_level_1($1, $2, $3)',
    [requestId, approverId, approverEmail]
  );
  return result.rows[0];
}

// Approve Level 2
export async function approveLevel2(
  requestId: string,
  approverId: string,
  approverEmail: string
): Promise<{ success: boolean; message: string }> {
  const result = await query(
    'SELECT * FROM approve_level_2($1, $2, $3)',
    [requestId, approverId, approverEmail]
  );
  return result.rows[0];
}

// Reject request
export async function rejectStockRequest(
  requestId: string,
  rejecterId: string,
  rejecterEmail: string,
  reason: string
): Promise<{ success: boolean; message: string }> {
  const result = await query(
    'SELECT * FROM reject_stock_request($1, $2, $3, $4)',
    [requestId, rejecterId, rejecterEmail, reason]
  );
  return result.rows[0];
}

// ==================== STOCK ISSUANCE REPORT OPERATIONS ====================

// Get reports by request
export async function getReportsByRequestId(requestId: string): Promise<StockIssuanceReport[]> {
  const result = await query(
    'SELECT * FROM stock_issuance_reports WHERE request_id = $1',
    [requestId]
  );
  return result.rows;
}

// Get all reports
export async function getAllReports(): Promise<StockIssuanceReport[]> {
  const result = await query(
    'SELECT * FROM stock_issuance_reports ORDER BY created_at DESC'
  );
  return result.rows;
}

// ==================== APPROVER CONFIG ====================

export interface ApproverConfig {
  id: string;
  approver_level: 'LEVEL_1' | 'LEVEL_2';
  approver_name: string;
  approver_email: string;
  approver_role?: string;
  is_active: boolean;
}

// Get all approvers
export async function getAllApprovers(): Promise<ApproverConfig[]> {
  const result = await query(
    'SELECT * FROM stock_approver_config WHERE is_active = true'
  );
  return result.rows;
}

// Get approver by level
export async function getApproverByLevel(level: 'LEVEL_1' | 'LEVEL_2'): Promise<ApproverConfig | null> {
  const result = await query(
    'SELECT * FROM stock_approver_config WHERE approver_level = $1 AND is_active = true',
    [level]
  );
  return result.rows[0] || null;
}

// ==================== DISTRIBUTION FUNCTIONS ====================

interface ManualProvisionPayload {
  distributor_id: string;
  mvno_id: string;
  sim_type: 'PHYSICAL' | 'ESIM';
  box_quantities?: { box_id: string; quantity: number }[];
  iccids?: string[];
  effective_date?: string;
  contact_person?: string;
  purpose?: string;
  performed_by?: string;
  performed_by_email?: string;
  performed_by_role?: string;
  /** Optional idempotency key (UUID). If omitted, server derives a deterministic key. */
  request_id?: string;
}

interface ManualProvisionResult {
  success: boolean;
  message: string;
  quantity: number;
  history_id: string;
  pdf_url: string | null;
  approval_emails: string[];
}

async function ensureManualProvisioningSchema(): Promise<void> {
  await ensureProvisioningSchema();

  await query(
    `CREATE TABLE IF NOT EXISTS system_config (
      config_key TEXT PRIMARY KEY,
      config_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`
  );

  await query(
    `ALTER TABLE IF EXISTS pick_history
      ADD COLUMN IF NOT EXISTS manual_request_id UUID,
      ADD COLUMN IF NOT EXISTS distribution_type VARCHAR(30),
      ADD COLUMN IF NOT EXISTS distributor_id UUID,
      ADD COLUMN IF NOT EXISTS approved_by_l3_email VARCHAR(255),
      ADD COLUMN IF NOT EXISTS issued_by TEXT,
      ADD COLUMN IF NOT EXISTS pick_form_url TEXT,
      ADD COLUMN IF NOT EXISTS request_id UUID,
      ADD COLUMN IF NOT EXISTS distribution_id UUID,
      ADD COLUMN IF NOT EXISTS contact_person TEXT`
  );

  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_history_request_id_not_null
       ON pick_history (request_id)
      WHERE request_id IS NOT NULL`
  );

  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_history_manual_request_id_not_null
       ON pick_history (manual_request_id)
      WHERE manual_request_id IS NOT NULL`
  );

  await query(
    `UPDATE pick_history
     SET distribution_type = 'APPROVED'
     WHERE distribution_type IS NULL`
  );

  // Data repair: remove orphaned pick_history records for PHYSICAL SIMs that have no
  // linked request_id. These are stale seeded records; box_pick_records is the source
  // of truth for physical SIM distributions.
  await query(
    `DELETE FROM pick_history
     WHERE request_id IS NULL
       AND manual_request_id IS NULL
       AND UPPER(COALESCE(sim_type, 'PHYSICAL')) = 'PHYSICAL'`
  );

  // Data repair: remove ghost system-written pick_history rows that are superseded
  // by a manual provision covering the same distributor + same boxes. These arise when
  // a box is first auto-stamped by the system and then re-provisioned manually.
  await query(
    `DELETE FROM pick_history ph
     WHERE ph.manual_request_id IS NULL
       AND ph.pick_form_url IS NULL
       AND COALESCE(ph.issued_by, '') IN ('', 'System')
       AND UPPER(COALESCE(ph.sim_type, 'PHYSICAL')) = 'PHYSICAL'
       AND EXISTS (
         SELECT 1 FROM pick_history ph2
         WHERE ph2.manual_request_id IS NOT NULL
           AND ph2.distributor_id = ph.distributor_id
           AND ph2.assigned_boxes IS NOT NULL
           AND (
             -- ghost also has assigned_boxes that are a subset
             (ph.assigned_boxes IS NOT NULL AND ph2.assigned_boxes::jsonb @> ph.assigned_boxes::jsonb)
             OR
             -- ghost has no assigned_boxes; check box_pick_records overlap
             (ph.assigned_boxes IS NULL AND EXISTS (
               SELECT 1 FROM box_pick_records bpr
               CROSS JOIN LATERAL jsonb_array_elements(ph2.assigned_boxes) AS ab(item)
               WHERE bpr.distributor_id = ph.distributor_id
                 AND bpr.box_id = (ab.item->>'box_id')::uuid
                 AND (ph.distribution_id IS NULL OR bpr.distribution_id = ph.distribution_id)
             ))
           )
       )`
  );
}

export async function getManualProvisioningApprovalEmails(): Promise<string[]> {
  await ensureManualProvisioningSchema();

  const cfgResult = await query(
    `SELECT config_value
     FROM system_config
     WHERE config_key = 'manual_provisioning_approval_emails'
     LIMIT 1`
  );

  const configured = cfgResult.rows[0]?.config_value;
  if (Array.isArray(configured) && configured.length >= 3) {
    return configured.slice(0, 3).map((v: any) => String(v));
  }

  const approvers = await query(
    `SELECT approver_email
     FROM stock_approver_config
     WHERE is_active = true
     ORDER BY approver_level`
  );

  const collected: string[] = [];
  for (const row of approvers.rows) {
    const email = String(row.approver_email || '').trim();
    if (email && !collected.includes(email)) collected.push(email);
  }

  const fallbackEmails = ['ops@hamiltel.com', 'audit@hamiltel.com', 'compliance@hamiltel.com'];
  for (const email of fallbackEmails) {
    if (collected.length >= 3) break;
    if (!collected.includes(email)) collected.push(email);
  }

  const finalEmails = collected.slice(0, 3);

  await query(
    `INSERT INTO system_config (config_key, config_value, updated_at)
     VALUES ('manual_provisioning_approval_emails', $1::jsonb, NOW())
     ON CONFLICT (config_key)
     DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()`,
    [JSON.stringify(finalEmails)]
  );

  return finalEmails;
}

export async function manualProvisionStock(payload: ManualProvisionPayload): Promise<ManualProvisionResult> {
  await ensureManualProvisioningSchema();

  const rawRole = String(payload.performed_by_role || '').trim().toUpperCase();
  let role = rawRole.replace(/[\s-]+/g, '_');
  if (role === 'SUPERADMIN' || role === 'ADMIN') role = 'SUPER_ADMIN';
  if (role === 'PLATFORMADMIN') role = 'PLATFORM_ADMIN';
  if (role === 'STOCKMANAGER') role = 'STOCK_MANAGER';
  const allowedRoles = new Set(['SUPER_ADMIN', 'PLATFORM_ADMIN', 'MANAGEMENT', 'STOCK_MANAGER', 'MVNO_ADMIN']);
  if (role && !allowedRoles.has(role)) {
    throw new Error('Manual provisioning is restricted to Admin or Stock Manager roles.');
  }

  const distributorResult = await query(
    `SELECT id, name, contact_person, email AS contact_email FROM distributors WHERE id = $1 LIMIT 1`,
    [payload.distributor_id]
  );
  if (!distributorResult.rows.length) {
    throw new Error('Distributor not found');
  }

  const mvnoResult = await query(
    `SELECT id, name FROM mvnos WHERE id = $1 LIMIT 1`,
    [payload.mvno_id]
  );
  if (!mvnoResult.rows.length) {
    throw new Error('MVNO not found');
  }

  const approvalEmails = await getManualProvisioningApprovalEmails();
  const [approvedByL1, approvedByL2, approvedByL3] = approvalEmails;

  const simType = payload.sim_type === 'ESIM' ? 'ESIM' : 'PHYSICAL';
  const effectiveDateRaw = String(payload.effective_date || '').trim();
  const issuedAt = effectiveDateRaw
    ? new Date(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(effectiveDateRaw) ? `${effectiveDateRaw}T12:00:00` : effectiveDateRaw)
    : new Date();
  if (Number.isNaN(issuedAt.getTime())) {
    throw new Error('effective_date is invalid');
  }
  let quantity = 0;
  let assignedBoxes: { box_id: string; quantity: number }[] = [];
  let assignedEsims: string[] = [];

  const provisioningRequestId = (() => {
    const explicit = String(payload.request_id || '').trim();
    if (explicit) {
      if (!isValidUUID(explicit)) throw new Error('request_id must be a valid UUID');
      return explicit;
    }
    return buildManualProvisioningRequestId({
      distributor_id: payload.distributor_id,
      mvno_id: payload.mvno_id,
      sim_type: simType,
      box_quantities: payload.box_quantities,
      iccids: payload.iccids,
      effective_date: payload.effective_date,
      purpose: payload.purpose,
    });
  })();

  let idempotentReplay = false;

  if (simType === 'ESIM') {
    const iccids = sortEsimIccids(payload.iccids || []);
    if (!iccids.length) {
      throw new Error('Please select at least one eSIM ICCID.');
    }

    await transaction(async (client) => {
      const dh = await insertDistributionHistoryIdempotent(client, {
        request_id: provisioningRequestId,
        distributor_id: payload.distributor_id,
        mvno_id: payload.mvno_id,
        sim_type: 'ESIM',
        carton_number: null,
        box_number: null,
        box_id: null,
        sim_count: iccids.length,
        purpose: payload.purpose || 'Manual provisioning',
        notes: 'idempotent manual provisioning (eSIM)',
      });

      if (dh === 'skipped') {
        quantity = iccids.length;
        assignedEsims = iccids;
        idempotentReplay = true;
        return;
      }

      const availability = await client.query(
        `SELECT COUNT(*)::int AS available_count
         FROM esim_stock
         WHERE mvno_id = $1
           AND COALESCE(status, 'available') = 'available'
           AND iccid = ANY($2::text[])`,
        [payload.mvno_id, iccids]
      );
      const availableCount = Number(availability.rows[0]?.available_count || 0);
      if (availableCount !== iccids.length) {
        throw new Error('Some selected eSIM ICCIDs are no longer available.');
      }

      const dist = await client.query(`SELECT * FROM distribute_esims($1::uuid, $2::uuid, $3::text[], $4::text)`, [
        payload.distributor_id,
        payload.mvno_id,
        iccids,
        payload.purpose || 'Manual provisioning',
      ]);
      const row = dist.rows?.[0];
      if (!row?.success) {
        throw new Error(String(row?.message || 'Failed to distribute eSIMs'));
      }

      quantity = iccids.length;
      assignedEsims = iccids;
    });
  } else {
    assignedBoxes = Array.isArray(payload.box_quantities)
      ? payload.box_quantities
          .map((item) => ({
            box_id: String(item?.box_id || '').trim(),
            quantity: Math.floor(Number(item?.quantity || 0)),
          }))
          .filter((item) => item.box_id && item.quantity > 0)
      : [];

    if (!assignedBoxes.length) {
      throw new Error('Please select at least one box with quantity.');
    }

    await transaction(async (client) => {
      const existingForRequest = await client.query(
        `SELECT id
           FROM distribution_history
          WHERE request_id = $1
          LIMIT 1`,
        [provisioningRequestId]
      );
      if (existingForRequest.rowCount) {
        quantity = assignedBoxes.reduce((sum, item) => sum + item.quantity, 0);
        idempotentReplay = true;
        return;
      }

      // Directly update box stock and record ICCID ranges in box_pick_records.
      // Generate a single distribution_id to link all box picks for this request.
      const manualDistId = (await client.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
      (globalThis as any).__lastManualDistId = manualDistId;

      for (const box of assignedBoxes) {
        const stockCheck = await client.query(
          `SELECT b.iccid_start, GREATEST(COALESCE(b.remaining_sims, 0), 0) AS available,
                  COALESCE(b.issued_sims, 0) AS issued_sims, LENGTH(b.iccid_start) AS iccid_len
           FROM boxes b WHERE b.id = $1 FOR UPDATE`,
          [box.box_id]
        );
        const available = Number(stockCheck.rows[0]?.available ?? 0);
        if (available < box.quantity) {
          throw new Error(`Insufficient SIMs in box (need ${box.quantity}, have ${available})`);
        }

        // Calculate the ICCID range for this specific distribution
        const boxIccidStart = stockCheck.rows[0]?.iccid_start || '';
        const alreadyIssued = Number(stockCheck.rows[0]?.issued_sims || 0);
        const iccidLen = Number(stockCheck.rows[0]?.iccid_len || boxIccidStart.length);
        const rangeStart = (BigInt(boxIccidStart) + BigInt(alreadyIssued)).toString().padStart(iccidLen, '0');
        const rangeEnd = (BigInt(boxIccidStart) + BigInt(alreadyIssued) + BigInt(box.quantity) - 1n).toString().padStart(iccidLen, '0');

        await client.query(
          `UPDATE boxes
             SET remaining_sims = remaining_sims - $1,
                 issued_sims    = COALESCE(issued_sims, 0) + $1
           WHERE id = $2`,
          [box.quantity, box.box_id]
        );

        // Insert box_pick_records with correct ICCID range
        await client.query(
          `INSERT INTO box_pick_records (box_id, distributor_id, quantity, sims_picked, iccid_start, iccid_end, distribution_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [box.box_id, payload.distributor_id, box.quantity, box.quantity, rangeStart, rangeEnd, manualDistId]
        );
      }

      // Insert distribution history for audit
      for (const box of assignedBoxes) {
        const boxInfo = await client.query(
          `SELECT b.box_number, c.carton_number
           FROM boxes b
           LEFT JOIN cartons c ON b.carton_id = c.id
           WHERE b.id = $1
           LIMIT 1`,
          [box.box_id]
        );
        await insertDistributionHistoryIdempotent(client, {
          request_id: provisioningRequestId,
          distributor_id: payload.distributor_id,
          mvno_id: payload.mvno_id,
          sim_type: 'PHYSICAL',
          carton_number: boxInfo.rows[0]?.carton_number || null,
          box_number: boxInfo.rows[0]?.box_number || null,
          box_id: box.box_id,
          sim_count: box.quantity,
          purpose: payload.purpose || 'Manual provisioning',
          notes: 'manual provisioning (physical per-box)',
        });
      }
      quantity = assignedBoxes.reduce((sum, item) => sum + item.quantity, 0);
    });
  }

  let cartonNumber: string | null = null;
  let boxNumber: string | number | null = null;
  let assignedBoxDetails: any[] = [];
  if (assignedBoxes.length) {
    const first = assignedBoxes[0];
    const firstResult = await query(
      `SELECT b.box_number, c.carton_number
       FROM boxes b
       LEFT JOIN cartons c ON b.carton_id = c.id
       WHERE b.id = $1
       LIMIT 1`,
      [first.box_id]
    );
    cartonNumber = firstResult.rows[0]?.carton_number || null;
    boxNumber = firstResult.rows[0]?.box_number ?? null;

    const boxIds = assignedBoxes.map((b) => b.box_id);
    const details = await query(
      `SELECT
         b.id::text AS box_id,
         b.box_number,
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
    assignedBoxDetails = details.rows.map((row: any) => ({
      ...row,
      sims_picked: assignedBoxes.find((b) => b.box_id === row.box_id)?.quantity ?? row.total_sims,
    }));
  }

  if (idempotentReplay) {
    const existing = await query(`SELECT id::text AS id, pick_form_url FROM pick_history WHERE manual_request_id = $1 LIMIT 1`, [
      provisioningRequestId,
    ]);
    const historyId = String(existing.rows[0]?.id || '');
    const pdfUrl = (existing.rows[0]?.pick_form_url as string | null) || null;
    return {
      success: true,
      message: 'Manual provisioning already completed (idempotent replay).',
      quantity,
      history_id: historyId,
      pdf_url: pdfUrl,
      approval_emails: approvalEmails,
    };
  }

  // Retrieve distribution_id generated during the transaction (physical only)
  const manualDistributionId = (globalThis as any).__lastManualDistId || null;
  delete (globalThis as any).__lastManualDistId;

  const insertResult = await query(
    `INSERT INTO pick_history (
      manual_request_id,
      request_id,
      distributor_id,
      mvno_id,
      mvno_name,
      sim_type,
      quantity,
      carton_number,
      box_number,
      assigned_boxes,
      assigned_esims,
      approved_by_l1_email,
      approved_by_l2_email,
      approved_by_l3_email,
      distribution_type,
      issued_by,
      issued_at,
      distribution_id,
      contact_person
    ) VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      'MANUAL',
      $15,
      $16::timestamptz,
      $17,
      $18
    ) RETURNING id`,
    [
      provisioningRequestId,
      null,
      payload.distributor_id,
      payload.mvno_id,
      mvnoResult.rows[0].name,
      simType,
      quantity,
      cartonNumber,
      boxNumber,
      JSON.stringify(assignedBoxes),
      JSON.stringify(assignedEsims),
      approvedByL1 || null,
      approvedByL2 || null,
      approvedByL3 || null,
      payload.performed_by_email || payload.performed_by || 'system',
      issuedAt.toISOString(),
      manualDistributionId,
      payload.contact_person || distributorResult.rows[0].contact_person || null,
    ]
  );

  const historyId = String(insertResult.rows[0]?.id || '');

  await addAuditLog(
    null,
    'MANUAL_DISTRIBUTION',
    {
      distributor_id: payload.distributor_id,
      mvno_id: payload.mvno_id,
      sim_type: simType,
      quantity,
      distribution_type: 'MANUAL',
      issued_at: issuedAt.toISOString(),
      purpose: payload.purpose || null,
      history_id: historyId,
    },
    payload.performed_by,
    payload.performed_by_email
  );

  let pdfUrl: string | null = null;
  try {
    const { savePickFormPDF } = await import('./pdf.service.js');
    pdfUrl = await savePickFormPDF({
      request_id: historyId,
      distributor_name: distributorResult.rows[0].name,
      request_date: issuedAt.toISOString(),
      requested_quantity: quantity,
      assigned_boxes: assignedBoxDetails,
      approved_by_l1_email: approvedByL1 || null,
      approved_by_l2_email: approvedByL2 || null,
      approved_by_l3_email: approvedByL3 || null,
      issued_by: payload.performed_by_email || payload.performed_by || 'system',
      picked_by_name: payload.contact_person || distributorResult.rows[0].contact_person || payload.performed_by || payload.performed_by_email || 'N/A',
      contact_person: payload.contact_person || distributorResult.rows[0].contact_person || null,
      form_title: 'Manual Stock Provisioning Form',
      sim_type: simType,
      esim_iccids: assignedEsims,
    });

    if (pdfUrl && historyId) {
      await query(
        `UPDATE pick_history
         SET pick_form_url = $1
         WHERE id = $2`,
        [pdfUrl, historyId]
      );
    }
  } catch {
    pdfUrl = null;
  }

  return {
    success: true,
    message: 'Manual provisioning completed successfully.',
    quantity,
    history_id: historyId,
    pdf_url: pdfUrl,
    approval_emails: approvalEmails,
  };
}

// Distribute eSIMs
export async function distributeESims(
  distributorId: string,
  mvnoId: string,
  iccids: string[],
  purpose?: string
): Promise<{ success: boolean; message: string; distributed_count: number }> {
  const orderedIccids = sortEsimIccids(iccids || []);
  if (!orderedIccids.length) {
    throw new Error('Please select at least one eSIM ICCID.');
  }

  // Check if stock has already been issued for this distributor, mvno, sim_type, and esims combination
  const existingRecord = await query(
    `SELECT id FROM pick_history 
     WHERE distributor_id = $1 
       AND mvno_id = $2 
       AND sim_type = $3 
       AND assigned_esims = $4
       AND distribution_type = 'MANUAL'
     LIMIT 1`,
    [distributorId, mvnoId, 'ESIM', JSON.stringify(orderedIccids)]
  );
  if (existingRecord.rows.length > 0) {
    throw new Error('Stock has already been issued for this distributor, MVNO, SIM type, and eSIM combination.');
  }

  const result = await query(
    'SELECT * FROM distribute_esims($1, $2, $3, $4)',
    [distributorId, mvnoId, orderedIccids, purpose || null]
  );
  return result.rows[0];
}

// Distribute Physical SIMs from single box
export async function distributePhysicalBox(
  distributorId: string,
  boxId: string,
  quantity: number,
  purpose?: string
): Promise<{ success: boolean; message: string }> {
  // Get box details to find mvno_id
  const boxResult = await query(
    `SELECT b.*, c.mvno_id 
     FROM boxes b 
     JOIN cartons c ON b.carton_id = c.id 
     WHERE b.id = $1`,
    [boxId]
  );
  if (boxResult.rows.length === 0) {
    throw new Error('Box not found');
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
    [distributorId, box.mvno_id, 'PHYSICAL', JSON.stringify([{ box_id: boxId, quantity }])]
  );
  if (existingRecord.rows.length > 0) {
    throw new Error('Stock has already been issued for this distributor, MVNO, SIM type, and box combination.');
  }

  const result = await query(
    'SELECT * FROM distribute_physical_box($1, $2, $3, $4)',
    [distributorId, boxId, quantity, purpose || null]
  );
  return result.rows[0];
}

// Distribute Physical SIMs from multiple boxes
export async function distributePhysicalBoxes(
  distributorId: string,
  boxQuantities: { box_id: string; quantity: number }[],
  purpose?: string
): Promise<{ success: boolean; message: string; total_distributed: number }> {
  // Get box details to find mvno_id
  const boxIds = boxQuantities.map(b => b.box_id);
  const boxesResult = await query(
    `SELECT b.id, c.mvno_id 
     FROM boxes b 
     JOIN cartons c ON b.carton_id = c.id 
     WHERE b.id = ANY($1)`,
    [boxIds]
  );
  if (boxesResult.rows.length === 0) {
    throw new Error('Boxes not found');
  }
  const mvnoId = boxesResult.rows[0].mvno_id;

  const result = await query(
    'SELECT * FROM distribute_physical_boxes($1, $2, $3)',
    [distributorId, JSON.stringify(boxQuantities), purpose || null]
  );
  return result.rows[0];
}

// ==================== PICK HISTORY ====================

export interface PickHistoryRecord {
  id: string;
  request_id?: string | null;
  distributor_id: string;
  distributor_name?: string;
  box_id?: string;
  box_number?: string;
  carton_number?: string;
  mvno_id?: string;
  mvno_name?: string;
  sims_picked?: number;
  iccid_start?: string;
  iccid_end?: string;
  picked_at?: string;
  pick_form_url?: string | null;
  sim_type?: string;
  distribution_status?: string;
  approved_by_l1_email?: string | null;
  approved_by_l2_email?: string | null;
  approved_by_l3_email?: string | null;
  distribution_type?: 'APPROVED' | 'MANUAL';
  issued_by?: string | null;
}

// Get pick history - includes both box_pick_records and pick_history (stock issuance)
export async function getPickHistory(distributorId?: string): Promise<PickHistoryRecord[]> {
  // Ensure pick_history table has all required columns + clean stale data
  await ensureManualProvisioningSchema();

  // Common CTEs for cumulative box numbering (e.g., "12/800")
  const cteSql = `
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
    )
  `;

  // Physical SIMs: box_pick_records is the sole source of truth, enriched with pick_history approver data
  const boxPickSelect = `
    SELECT
      bpr.id,
      COALESCE(ph_match.request_id, dh.request_id, bpr.distribution_id)::text as request_id,
      bpr.distributor_id,
      COALESCE(d.name, 'Unknown')::text as distributor_name,
      bpr.box_id,
      (((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(b.box_number, 0))::text
        || '/' || COALESCE(mbt.total_boxes::text, '0')) as box_display,
      b.box_number::text,
      c.carton_number,
      c.mvno_id,
      m.name::text as mvno,
      bpr.sims_picked,
      bpr.iccid_start,
      bpr.iccid_end,
      bpr.picked_at,
      COALESCE(bpr.pick_form_url, ph_match.pick_form_url) as pick_form_url,
      'box_pick' as pick_type,
      'PHYSICAL'::text as sim_type,
      'COMPLETED'::text as distribution_status,
      ph_match.approved_by_l1_email::text as approved_by_l1_email,
      ph_match.approved_by_l2_email::text as approved_by_l2_email,
      NULL::text as approved_by_l3_email,
      CASE WHEN ph_match.id IS NOT NULL THEN 'APPROVED' ELSE 'MANUAL' END::text as distribution_type,
      ph_match.issued_by::text as issued_by,
      d.email::text as distributor_email,
      d.location::text as distributor_location,
      NULL::jsonb as assigned_esims
    FROM box_pick_records bpr
    LEFT JOIN boxes b ON bpr.box_id = b.id
    LEFT JOIN cartons c ON b.carton_id = c.id
    LEFT JOIN carton_order co ON c.id = co.carton_id
    LEFT JOIN mvno_box_totals mbt ON COALESCE(b.mvno_id, c.mvno_id) = mbt.mvno_id
    LEFT JOIN mvnos m ON c.mvno_id = m.id
    LEFT JOIN distributors d ON bpr.distributor_id = d.id
    LEFT JOIN distribution_history dh ON dh.id = bpr.distribution_id
    LEFT JOIN LATERAL (
      SELECT ph2.id, ph2.request_id, ph2.approved_by_l1_email, ph2.approved_by_l2_email,
             ph2.pick_form_url, ph2.issued_by
      FROM pick_history ph2
      WHERE ph2.distribution_id = bpr.distribution_id
         OR (ph2.distribution_id IS NULL AND ph2.distributor_id = bpr.distributor_id)
      ORDER BY
        CASE WHEN ph2.distribution_id = bpr.distribution_id THEN 0 ELSE 1 END,
        ph2.issued_at DESC
      LIMIT 1
    ) ph_match ON true
  `;

  // Manual physical provisioning: pick_history records with distribution_type='MANUAL' + sim_type='PHYSICAL'
  // These intentionally skip box_pick_records to avoid double-counting, so we source them here.
  const manualPhysicalSelect = `
    SELECT
      ph.id,
      COALESCE(ph.manual_request_id, ph.request_id)::text as request_id,
      ph.distributor_id,
      COALESCE(d.name, 'Unknown')::text as distributor_name,
      (ab.item->>'box_id')::uuid as box_id,
      (((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(b.box_number, 0))::text
        || '/' || COALESCE(mbt.total_boxes::text, '0')) as box_display,
      b.box_number::text,
      c.carton_number,
      COALESCE(b.mvno_id, c.mvno_id, ph.mvno_id) as mvno_id,
      COALESCE(m.name::text, ph.mvno_name::text) as mvno,
      COALESCE((ab.item->>'quantity')::int, ph.quantity, 0) as sims_picked,
      b.iccid_start::text as iccid_start,
      b.iccid_end::text as iccid_end,
      ph.issued_at as picked_at,
      ph.pick_form_url::text as pick_form_url,
      'manual_physical' as pick_type,
      'PHYSICAL'::text as sim_type,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM stock_audit_logs sal
          WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
            AND sal.details->>'pick_history_id' = ph.id::text
        ) THEN 'REVERSED'::text
        ELSE 'COMPLETED'::text
      END as distribution_status,
      ph.approved_by_l1_email::text as approved_by_l1_email,
      ph.approved_by_l2_email::text as approved_by_l2_email,
      ph.approved_by_l3_email::text as approved_by_l3_email,
      'MANUAL'::text as distribution_type,
      ph.issued_by::text as issued_by,
      d.email::text as distributor_email,
      d.location::text as distributor_location,
      NULL::jsonb as assigned_esims
    FROM pick_history ph
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ph.assigned_boxes, '[]'::jsonb)) AS ab(item)
    LEFT JOIN boxes b ON b.id = (ab.item->>'box_id')::uuid
    LEFT JOIN cartons c ON b.carton_id = c.id
    LEFT JOIN carton_order co ON c.id = co.carton_id
    LEFT JOIN mvno_box_totals mbt ON COALESCE(b.mvno_id, c.mvno_id) = mbt.mvno_id
    LEFT JOIN mvnos m ON COALESCE(c.mvno_id, ph.mvno_id) = m.id
    LEFT JOIN distributors d ON ph.distributor_id = d.id
    WHERE ph.distribution_type = 'MANUAL'
      AND UPPER(COALESCE(ph.sim_type, 'PHYSICAL')) = 'PHYSICAL'
      AND ph.manual_request_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM box_pick_records bpr2
        WHERE bpr2.distributor_id = ph.distributor_id
          AND bpr2.box_id = (ab.item->>'box_id')::uuid
      )
  `;

  // eSIM: pick_history is the sole source (eSIMs don't create box_pick_records)
  const esimPickSelect = `
    SELECT
      ph.id,
      COALESCE(ph.request_id, ph.manual_request_id)::text as request_id,
      COALESCE(ph.distributor_id, sir.requester_id) as distributor_id,
      COALESCE(d.name, 'Unknown')::text as distributor_name,
      NULL::uuid as box_id,
      NULL::text as box_display,
      NULL::text as box_number,
      NULL::text as carton_number,
      ph.mvno_id,
      ph.mvno_name::text as mvno,
      COALESCE(ph.quantity, 0) as sims_picked,
      esim_range.iccid_start as iccid_start,
      esim_range.iccid_end as iccid_end,
      ph.issued_at as picked_at,
      ph.pick_form_url::text as pick_form_url,
      'issuance' as pick_type,
      'ESIM'::text as sim_type,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM stock_audit_logs sal
          WHERE sal.request_id = ph.request_id AND sal.action = 'DISTRIBUTION_REVERSED'
        ) THEN 'REVERSED'::text
        ELSE COALESCE(sir.status, 'COMPLETED')::text
      END as distribution_status,
      COALESCE(ph.approved_by_l1_email, sir.level_1_approver_email)::text as approved_by_l1_email,
      COALESCE(ph.approved_by_l2_email, sir.level_2_approver_email)::text as approved_by_l2_email,
      ph.approved_by_l3_email::text as approved_by_l3_email,
      COALESCE(ph.distribution_type, 'APPROVED')::text as distribution_type,
      ph.issued_by::text as issued_by,
      d.email::text as distributor_email,
      d.location::text as distributor_location,
      COALESCE(esim_range.assigned_esims_sorted, '[]'::jsonb) as assigned_esims
    FROM pick_history ph
    LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
    LEFT JOIN distributors d ON COALESCE(ph.distributor_id, sir.requester_id) = d.id
    LEFT JOIN LATERAL (
      SELECT
        (SELECT esim_val
         FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)
         ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) ASC, SUBSTRING(esim_val FROM 20) ASC
         LIMIT 1)::text AS iccid_start,
        (SELECT esim_val
         FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)
         ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) DESC, SUBSTRING(esim_val FROM 20) DESC
         LIMIT 1)::text AS iccid_end,
        (SELECT jsonb_agg(esim_val ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) ASC, SUBSTRING(esim_val FROM 20) ASC)
         FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)) AS assigned_esims_sorted
    ) esim_range ON true
    WHERE UPPER(COALESCE(ph.sim_type, sir.sim_type, 'PHYSICAL')) = 'ESIM'
  `;

  try {
    if (distributorId) {
      const sql = `${cteSql}
        ${boxPickSelect} WHERE bpr.box_id IS NOT NULL AND bpr.distributor_id = $1
        UNION ALL
        ${manualPhysicalSelect} AND ph.distributor_id = $1
        UNION ALL
        ${esimPickSelect} AND COALESCE(ph.distributor_id, sir.requester_id) = $1
        ORDER BY picked_at DESC`;
      const result = await query(sql, [distributorId]);
      return result.rows;
    }

    const sql = `${cteSql}
      ${boxPickSelect} WHERE bpr.box_id IS NOT NULL
      UNION ALL
      ${manualPhysicalSelect}
      UNION ALL
      ${esimPickSelect}
      ORDER BY picked_at DESC`;
    const result = await query(sql);
    return result.rows;
  } catch (error: any) {
    // Return empty array if tables don't exist yet
    if (error?.code === '42P01' || error?.code === '42703') {
      console.warn('Pick history tables not available yet:', error.message);
      return [];
    }
    throw error;
  }
}

export interface DistributionHistoryFilters {
  mvno_id?: string;
  sim_type?: 'ALL' | 'PHYSICAL' | 'ESIM';
  distributor_id?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface DistributionHistoryKpis {
  total_distributed: number;
  physical_distributed: number;
  esim_distributed: number;
  active_distributors: number;
  total_records: number;
}

export interface DistributionHistoryRow {
  request_id: string;
  distributor_id: string | null;
  distributor_name: string;
  distributor_email: string | null;
  sim_type: 'PHYSICAL' | 'ESIM';
  mvno_id: string | null;
  mvno_name: string;
  carton_no: string | null;
  box_numbers: string[];
  iccid_start: string | null;
  iccid_end: string | null;
  iccid_count: number | null;
  quantity: number;
  status: string;
  distribution_type: string;
  is_manual_provisioning: boolean;
  contact_person: string | null;
  issued_by: string | null;
  pick_form_url: string | null;
  created_at: string;
  physical_details: Array<{
    carton_no: string | null;
    box_number: string | null;
    box_display: string | null;
    iccid_start: string | null;
    iccid_end: string | null;
    quantity: number;
  }> | null;
  esim_iccids: string[] | null;
}

export async function getDistributionHistory(filters: DistributionHistoryFilters): Promise<{
  rows: DistributionHistoryRow[];
  kpis: DistributionHistoryKpis;
}> {
  await ensureManualProvisioningSchema();

  const values: any[] = [];
  const where: string[] = [];
  const add = (sql: string, value: any) => {
    values.push(value);
    where.push(sql.replace('$?', `$${values.length}`));
  };

  const mvnoId = filters.mvno_id ? String(filters.mvno_id) : undefined;
  const simType = (filters.sim_type ? String(filters.sim_type).toUpperCase() : 'ALL') as 'ALL' | 'PHYSICAL' | 'ESIM';
  const distributorId = filters.distributor_id ? String(filters.distributor_id) : undefined;
  const dateFrom = filters.date_from ? String(filters.date_from) : undefined;
  const dateTo = filters.date_to ? String(filters.date_to) : undefined;
  const search = filters.search ? String(filters.search).trim() : '';

  if (mvnoId) add(`x.mvno_id = $?::uuid`, mvnoId);
  if (simType !== 'ALL') add(`x.sim_type = $?::text`, simType);
  if (distributorId) add(`x.distributor_id = $?::uuid`, distributorId);
  if (dateFrom) add(`x.created_at >= $?::timestamptz`, dateFrom);
  if (dateTo) add(`x.created_at <= $?::timestamptz`, dateTo);
  if (search) {
    const sv = `%${search}%`;
    values.push(sv);
    const p = `$${values.length}`;
    where.push(`(
      x.request_id ILIKE ${p}
      OR x.distributor_name ILIKE ${p}
      OR COALESCE(x.distributor_email, '') ILIKE ${p}
      OR x.mvno_name ILIKE ${p}
      OR COALESCE(x.carton_no, '') ILIKE ${p}
      OR COALESCE(x.box_numbers, '[]'::jsonb)::text ILIKE ${p}
      OR COALESCE(x.iccid_start, '') ILIKE ${p}
      OR COALESCE(x.iccid_end, '') ILIKE ${p}
      OR (x.sim_type = 'ESIM' AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(x.esim_iccids, '[]'::jsonb)) AS es(val)
        WHERE es.val ILIKE ${p}
      ))
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const cteSql = `
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
        ph.pick_form_url::text AS pick_form_url,
        ph.issued_at AS created_at,
        ph.distribution_id AS distribution_id,
        ph.assigned_boxes AS assigned_boxes,
        CASE
          WHEN UPPER(COALESCE(ph.distribution_type, '')) = 'MANUAL' AND ph.manual_request_id IS NOT NULL THEN TRUE
          ELSE FALSE
        END AS is_manual_provisioning,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
              AND sal.details->>'pick_history_id' = ph.id::text
          ) THEN 'REVERSED'::text
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.request_id = ph.request_id AND sal.action = 'DISTRIBUTION_REVERSED'
          ) THEN 'REVERSED'::text
          ELSE COALESCE(sir.status, 'COMPLETED')::text
        END AS status
      FROM pick_history ph
      LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
      LEFT JOIN distributors d ON COALESCE(ph.distributor_id, sir.requester_id) = d.id
      LEFT JOIN mvnos m ON COALESCE(ph.mvno_id, sir.mvno_id) = m.id
      -- Some legacy eSIM distributions missed sim_type/sir rows; infer using assigned_esims.
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
          -- Case 1: both rows have assigned_boxes — use containment check
          EXISTS (
            SELECT 1 FROM pick_history ph2
            WHERE ph2.manual_request_id IS NOT NULL
              AND ph2.distributor_id = ph.distributor_id
              AND ph2.assigned_boxes IS NOT NULL
              AND ph.assigned_boxes IS NOT NULL
              AND ph2.assigned_boxes::jsonb @> ph.assigned_boxes::jsonb
          )
          OR
          -- Case 2: ghost has no assigned_boxes — check via box_pick_records for same
          -- distributor whether those boxes are covered by a manual provision
          (
            ph.assigned_boxes IS NULL
            AND EXISTS (
              SELECT 1
              FROM box_pick_records bpr2
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
        b.request_id,
        b.distributor_id,
        b.distributor_name,
        b.distributor_email,
        b.mvno_id,
        b.mvno_name,
        b.distribution_type,
        b.issued_by,
        b.contact_person,
        b.pick_form_url,
        b.created_at,
        b.status,
        b.is_manual_provisioning,
        b.distribution_id,
        (ab.item->>'box_id')::uuid AS box_id,
        COALESCE((ab.item->>'quantity')::int, 0) AS box_quantity
      FROM ph_physical_base b
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.assigned_boxes, '[]'::jsonb)) AS ab(item)
    ),
    ph_physical_detail AS (
      SELECT
        r.request_id,
        r.distributor_id,
        r.distributor_name,
        r.distributor_email,
        r.mvno_id,
        r.mvno_name,
        'PHYSICAL'::text AS sim_type,
        r.distribution_type,
        r.issued_by,
        r.contact_person,
        r.pick_form_url,
        r.created_at,
        r.status,
        r.is_manual_provisioning,
        c.carton_number::text AS carton_no,
        b.box_number::text AS box_number,
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
    physical_from_ph AS (
      SELECT
        request_id,
        distributor_id,
        distributor_name,
        distributor_email,
        'PHYSICAL'::text AS sim_type,
        mvno_id,
        mvno_name,
        CASE WHEN COUNT(DISTINCT carton_no) = 1 THEN MAX(carton_no) ELSE NULL END::text AS carton_no,
        COALESCE(jsonb_agg(DISTINCT box_display), '[]'::jsonb) AS box_numbers,
        MIN(iccid_start)::text AS iccid_start,
        MAX(iccid_end)::text AS iccid_end,
        NULL::jsonb AS esim_iccids,
        NULL::int AS iccid_count,
        COALESCE(SUM(quantity), 0)::int AS quantity,
        MAX(status)::text AS status,
        MAX(distribution_type)::text AS distribution_type,
        BOOL_OR(is_manual_provisioning) AS is_manual_provisioning,
        MAX(issued_by)::text AS issued_by,
        MAX(contact_person)::text AS contact_person,
        MAX(pick_form_url)::text AS pick_form_url,
        MAX(created_at) AS created_at,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'carton_no', carton_no,
              'box_number', box_number,
              'box_display', box_display,
              'iccid_start', iccid_start,
              'iccid_end', iccid_end,
              'quantity', quantity
            )
            ORDER BY carton_no, box_display
          ),
          '[]'::jsonb
        ) AS physical_details
      FROM ph_physical_detail
      GROUP BY request_id, distributor_id, distributor_name, distributor_email, mvno_id, mvno_name
    ),
    bpr_only_detail AS (
      SELECT
        bpr.distribution_id::text AS request_id,
        bpr.distributor_id AS distributor_id,
        COALESCE(d.name, 'Unknown')::text AS distributor_name,
        d.email::text AS distributor_email,
        'PHYSICAL'::text AS sim_type,
        c.mvno_id AS mvno_id,
        COALESCE(m.name::text, '')::text AS mvno_name,
        c.carton_number::text AS carton_no,
        b.box_number::text AS box_number,
        (((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(b.box_number, 0))::text
          || '/' || COALESCE(mbt.total_boxes::text, '0'))::text AS box_display,
        bpr.iccid_start::text AS iccid_start,
        bpr.iccid_end::text AS iccid_end,
        bpr.sims_picked::int AS quantity,
        bpr.picked_at AS created_at
      FROM box_pick_records bpr
      LEFT JOIN boxes b ON bpr.box_id = b.id
      LEFT JOIN cartons c ON b.carton_id = c.id
      LEFT JOIN carton_order co ON c.id = co.carton_id
      LEFT JOIN mvno_box_totals mbt ON COALESCE(b.mvno_id, c.mvno_id) = mbt.mvno_id
      LEFT JOIN mvnos m ON c.mvno_id = m.id
      LEFT JOIN distributors d ON bpr.distributor_id = d.id
      WHERE bpr.box_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM pick_history ph
          WHERE ph.distribution_id = bpr.distribution_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pick_history ph2
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ph2.assigned_boxes, '[]'::jsonb)) AS ab(item)
          WHERE ph2.manual_request_id IS NOT NULL
            AND ph2.distributor_id = bpr.distributor_id
            AND (ab.item->>'box_id')::uuid = bpr.box_id
        )
    ),
    physical_from_bpr_only AS (
      SELECT
        request_id,
        distributor_id,
        distributor_name,
        distributor_email,
        'PHYSICAL'::text AS sim_type,
        mvno_id,
        mvno_name,
        CASE WHEN COUNT(DISTINCT carton_no) = 1 THEN MAX(carton_no) ELSE NULL END::text AS carton_no,
        COALESCE(jsonb_agg(DISTINCT box_display), '[]'::jsonb) AS box_numbers,
        MIN(iccid_start)::text AS iccid_start,
        MAX(iccid_end)::text AS iccid_end,
        NULL::jsonb AS esim_iccids,
        NULL::int AS iccid_count,
        COALESCE(SUM(quantity), 0)::int AS quantity,
        'COMPLETED'::text AS status,
        'MANUAL'::text AS distribution_type,
        FALSE::boolean AS is_manual_provisioning,
        'System'::text AS issued_by,
        NULL::text AS contact_person,
        NULL::text AS pick_form_url,
        MAX(created_at) AS created_at,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'carton_no', carton_no,
              'box_number', box_number,
              'box_display', box_display,
              'iccid_start', iccid_start,
              'iccid_end', iccid_end,
              'quantity', quantity
            )
            ORDER BY carton_no, box_display
          ),
          '[]'::jsonb
        ) AS physical_details
      FROM bpr_only_detail
      GROUP BY request_id, distributor_id, distributor_name, distributor_email, mvno_id, mvno_name
    ),
    esim_from_ph AS (
      SELECT
        COALESCE(ph.request_id, ph.manual_request_id)::text AS request_id,
        COALESCE(ph.distributor_id, sir.requester_id) AS distributor_id,
        COALESCE(d.name, 'Unknown')::text AS distributor_name,
        d.email::text AS distributor_email,
        'ESIM'::text AS sim_type,
        ph.mvno_id AS mvno_id,
        COALESCE(ph.mvno_name::text, m.name::text, '')::text AS mvno_name,
        NULL::text AS carton_no,
        '[]'::jsonb AS box_numbers,
        esim_range.iccid_start::text AS iccid_start,
        esim_range.iccid_end::text AS iccid_end,
        COALESCE(esim_range.assigned_esims_sorted, '[]'::jsonb) AS esim_iccids,
        COALESCE(jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)), 0)::int AS iccid_count,
        COALESCE(ph.quantity, COALESCE(jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)), 0))::int AS quantity,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
              AND sal.details->>'pick_history_id' = ph.id::text
          ) THEN 'REVERSED'::text
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.request_id = ph.request_id AND sal.action = 'DISTRIBUTION_REVERSED'
          ) THEN 'REVERSED'::text
          ELSE COALESCE(sir.status, 'COMPLETED')::text
        END AS status,
        COALESCE(ph.distribution_type, 'APPROVED')::text AS distribution_type,
        CASE
          WHEN UPPER(COALESCE(ph.distribution_type, '')) = 'MANUAL' AND ph.manual_request_id IS NOT NULL THEN TRUE
          ELSE FALSE
        END AS is_manual_provisioning,
        ph.issued_by::text AS issued_by,
        COALESCE(ph.contact_person, d.contact_person, '')::text AS contact_person,
        ph.pick_form_url::text AS pick_form_url,
        ph.issued_at AS created_at,
        NULL::jsonb AS physical_details
      FROM pick_history ph
      LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
      LEFT JOIN distributors d ON COALESCE(ph.distributor_id, sir.requester_id) = d.id
      LEFT JOIN mvnos m ON ph.mvno_id = m.id
      LEFT JOIN LATERAL (
        SELECT
          (SELECT esim_val
           FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)
           ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) ASC, SUBSTRING(esim_val FROM 20) ASC
           LIMIT 1)::text AS iccid_start,
          (SELECT esim_val
           FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)
           ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) DESC, SUBSTRING(esim_val FROM 20) DESC
           LIMIT 1)::text AS iccid_end,
          (SELECT jsonb_agg(esim_val ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) ASC, SUBSTRING(esim_val FROM 20) ASC)
           FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)) AS assigned_esims_sorted
      ) esim_range ON true
      WHERE UPPER(
        CASE
          WHEN jsonb_typeof(COALESCE(ph.assigned_esims, '[]'::jsonb)) = 'array'
            AND jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)) > 0
            THEN 'ESIM'
          ELSE COALESCE(ph.sim_type::text, sir.sim_type::text, 'PHYSICAL')
        END
      ) = 'ESIM'
    ),
    combined AS (
      SELECT * FROM physical_from_ph
      UNION ALL
      SELECT * FROM physical_from_bpr_only
      UNION ALL
      SELECT * FROM esim_from_ph
    )
  `;

  const baseSelect = `
    SELECT
      x.request_id,
      x.distributor_id::text AS distributor_id,
      x.distributor_name,
      x.distributor_email,
      x.sim_type,
      x.mvno_id::text AS mvno_id,
      x.mvno_name,
      x.carton_no,
      x.box_numbers,
      x.iccid_start,
      x.iccid_end,
      CASE WHEN x.sim_type = 'ESIM' THEN x.iccid_count ELSE NULL END AS iccid_count,
      x.quantity,
      x.status,
      x.distribution_type,
      COALESCE(x.is_manual_provisioning, FALSE) AS is_manual_provisioning,
      x.issued_by,
      x.contact_person,
      x.pick_form_url,
      x.created_at,
      CASE WHEN x.sim_type = 'PHYSICAL' THEN x.physical_details ELSE NULL END AS physical_details
    FROM combined x
    ${whereSql}
  `;

  values.push(limit);
  values.push(offset);
  const rowsSql = `${cteSql}${baseSelect} ORDER BY x.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`;

  const countValues = values.slice(0, values.length - 2);
  const countSql = `${cteSql}
    SELECT
      COUNT(*)::int AS total_records,
      COALESCE(SUM(x.quantity), 0)::int AS total_distributed,
      COALESCE(SUM(CASE WHEN x.sim_type = 'PHYSICAL' THEN x.quantity ELSE 0 END), 0)::int AS physical_distributed,
      COALESCE(SUM(CASE WHEN x.sim_type = 'ESIM' THEN x.quantity ELSE 0 END), 0)::int AS esim_distributed,
      COALESCE(COUNT(DISTINCT x.distributor_id), 0)::int AS active_distributors
    FROM combined x
    ${whereSql}`;

  const [rowsRes, kpiRes] = await Promise.all([query(rowsSql, values), query(countSql, countValues)]);

  const kpiRow = kpiRes.rows[0] || {};
  const rows: DistributionHistoryRow[] = (rowsRes.rows || []).map((r: any) => {
    const boxNumbers = Array.isArray(r.box_numbers) ? r.box_numbers : typeof r.box_numbers === 'string' ? (() => {
      try { return JSON.parse(r.box_numbers); } catch { return []; }
    })() : [];

    const physicalDetails = r.physical_details
      ? (typeof r.physical_details === 'string' ? (() => { try { return JSON.parse(r.physical_details); } catch { return null; } })() : r.physical_details)
      : null;

    return {
      request_id: String(r.request_id || ''),
      distributor_id: r.distributor_id ? String(r.distributor_id) : null,
      distributor_name: String(r.distributor_name || 'Unknown'),
      distributor_email: r.distributor_email ? String(r.distributor_email) : null,
      sim_type: String(r.sim_type || 'PHYSICAL').toUpperCase() === 'ESIM' ? 'ESIM' : 'PHYSICAL',
      mvno_id: r.mvno_id ? String(r.mvno_id) : null,
      mvno_name: String(r.mvno_name || ''),
      carton_no: r.carton_no ? String(r.carton_no) : null,
      box_numbers: (boxNumbers || []).map((v: any) => String(v)).filter(Boolean),
      iccid_start: r.iccid_start ? String(r.iccid_start) : null,
      iccid_end: r.iccid_end ? String(r.iccid_end) : null,
      iccid_count: r.iccid_count === null || r.iccid_count === undefined ? null : Number(r.iccid_count) || 0,
      quantity: Number(r.quantity) || 0,
      status: String(r.status || 'COMPLETED'),
      distribution_type: String(r.distribution_type || ''),
      is_manual_provisioning: Boolean(r.is_manual_provisioning),
      contact_person: r.contact_person ? String(r.contact_person) : null,
      issued_by: r.issued_by ? String(r.issued_by) : null,
      pick_form_url: r.pick_form_url ? String(r.pick_form_url) : null,
      created_at: new Date(r.created_at).toISOString(),
      physical_details: physicalDetails ? (physicalDetails as any[]).map((d: any) => ({
        carton_no: d?.carton_no ? String(d.carton_no) : null,
        box_number: d?.box_number ? String(d.box_number) : null,
        box_display: d?.box_display ? String(d.box_display) : null,
        iccid_start: d?.iccid_start ? String(d.iccid_start) : null,
        iccid_end: d?.iccid_end ? String(d.iccid_end) : null,
        quantity: Number(d?.quantity) || 0,
      })) : null,
      esim_iccids: Array.isArray(r.esim_iccids) ? r.esim_iccids : null,
    };
  });

  const kpis: DistributionHistoryKpis = {
    total_distributed: Number(kpiRow.total_distributed) || 0,
    physical_distributed: Number(kpiRow.physical_distributed) || 0,
    esim_distributed: Number(kpiRow.esim_distributed) || 0,
    active_distributors: Number(kpiRow.active_distributors) || 0,
    total_records: Number(kpiRow.total_records) || 0,
  };

  return { rows, kpis };
}

export async function getDistributionHistoryEsimIccids(requestId: string): Promise<string[]> {
  await ensureManualProvisioningSchema();
  const id = String(requestId || '').trim();
  if (!id) return [];

  const res = await query(
    `SELECT assigned_esims
     FROM pick_history
     WHERE COALESCE(request_id::text, manual_request_id::text) = $1
        OR request_id::text = $1
        OR manual_request_id::text = $1
     ORDER BY issued_at DESC
     LIMIT 1`,
    [id]
  );

  const raw = res.rows[0]?.assigned_esims;
  const list = Array.isArray(raw) ? raw : [];
  return sortEsimIccids(list);
}

export async function getDistributionHistoryById(requestId: string): Promise<DistributionHistoryRow | null> {
  await ensureManualProvisioningSchema();
  const id = String(requestId || '').trim();
  if (!id) return null;

  // Reuse the same CTE logic as getDistributionHistory but filter by single request_id
  const res = await query(
    `
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
        ph.pick_form_url::text AS pick_form_url,
        ph.issued_at AS created_at,
        ph.distribution_id AS distribution_id,
        ph.assigned_boxes AS assigned_boxes,
        CASE
          WHEN UPPER(COALESCE(ph.distribution_type, '')) = 'MANUAL' AND ph.manual_request_id IS NOT NULL THEN TRUE
          ELSE FALSE
        END AS is_manual_provisioning,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
              AND sal.details->>'pick_history_id' = ph.id::text
          ) THEN 'REVERSED'::text
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.request_id = ph.request_id AND sal.action = 'DISTRIBUTION_REVERSED'
          ) THEN 'REVERSED'::text
          ELSE COALESCE(sir.status, 'COMPLETED')::text
        END AS status
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
        AND (COALESCE(ph.request_id::text, ph.manual_request_id::text) = $1 OR ph.request_id::text = $1)
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
            AND ph.iccid_start IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM pick_history ph2
              CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ph2.assigned_boxes, '[]'::jsonb)) AS ab2(item)
              JOIN boxes b2 ON b2.id = (ab2.item->>'box_id')::uuid
              WHERE ph2.manual_request_id IS NOT NULL
                AND ph2.distributor_id = ph.distributor_id
                AND b2.iccid_start::text <= ph.iccid_end::text
                AND b2.iccid_end::text >= ph.iccid_start::text
            )
          )
        )
      )
    ),
    ph_physical_rows AS (
      SELECT
        b.request_id,
        b.distributor_id,
        b.distributor_name,
        b.distributor_email,
        b.mvno_id,
        b.mvno_name,
        b.distribution_type,
        b.issued_by,
        b.pick_form_url,
        b.created_at,
        b.status,
        b.is_manual_provisioning,
        b.distribution_id,
        (ab.item->>'box_id')::uuid AS box_id,
        COALESCE((ab.item->>'quantity')::int, 0) AS box_quantity
      FROM ph_physical_base b
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.assigned_boxes, '[]'::jsonb)) AS ab(item)
    ),
    ph_physical_detail AS (
      SELECT
        r.request_id,
        r.distributor_id,
        r.distributor_name,
        r.distributor_email,
        r.mvno_id,
        r.mvno_name,
        'PHYSICAL'::text AS sim_type,
        r.distribution_type,
        r.issued_by,
        r.pick_form_url,
        r.created_at,
        r.status,
        r.is_manual_provisioning,
        c.carton_number::text AS carton_no,
        b.box_number::text AS box_number,
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
    physical_from_ph AS (
      SELECT
        request_id,
        distributor_id,
        distributor_name,
        distributor_email,
        'PHYSICAL'::text AS sim_type,
        mvno_id,
        mvno_name,
        CASE WHEN COUNT(DISTINCT carton_no) = 1 THEN MAX(carton_no) ELSE NULL END::text AS carton_no,
        COALESCE(jsonb_agg(DISTINCT box_display), '[]'::jsonb) AS box_numbers,
        MIN(iccid_start)::text AS iccid_start,
        MAX(iccid_end)::text AS iccid_end,
        NULL::jsonb AS esim_iccids,
        NULL::int AS iccid_count,
        COALESCE(SUM(quantity), 0)::int AS quantity,
        MAX(status)::text AS status,
        MAX(distribution_type)::text AS distribution_type,
        BOOL_OR(is_manual_provisioning) AS is_manual_provisioning,
        MAX(issued_by)::text AS issued_by,
        MAX(pick_form_url)::text AS pick_form_url,
        MAX(created_at) AS created_at,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'carton_no', carton_no,
              'box_number', box_number,
              'box_display', box_display,
              'iccid_start', iccid_start,
              'iccid_end', iccid_end,
              'quantity', quantity
            )
            ORDER BY carton_no, box_display
          ),
          '[]'::jsonb
        ) AS physical_details
      FROM ph_physical_detail
      GROUP BY request_id, distributor_id, distributor_name, distributor_email, mvno_id, mvno_name
    ),
    esim_from_ph AS (
      SELECT
        COALESCE(ph.request_id, ph.manual_request_id)::text AS request_id,
        COALESCE(ph.distributor_id, sir.requester_id) AS distributor_id,
        COALESCE(d.name, 'Unknown')::text AS distributor_name,
        d.email::text AS distributor_email,
        'ESIM'::text AS sim_type,
        ph.mvno_id AS mvno_id,
        COALESCE(ph.mvno_name::text, m.name::text, '')::text AS mvno_name,
        NULL::text AS carton_no,
        '[]'::jsonb AS box_numbers,
        esim_range.iccid_start::text AS iccid_start,
        esim_range.iccid_end::text AS iccid_end,
        COALESCE(esim_range.assigned_esims_sorted, '[]'::jsonb) AS esim_iccids,
        COALESCE(jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)), 0)::int AS iccid_count,
        COALESCE(ph.quantity, COALESCE(jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)), 0))::int AS quantity,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
              AND sal.details->>'pick_history_id' = ph.id::text
          ) THEN 'REVERSED'::text
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.request_id = ph.request_id AND sal.action = 'DISTRIBUTION_REVERSED'
          ) THEN 'REVERSED'::text
          ELSE COALESCE(sir.status, 'COMPLETED')::text
        END AS status,
        COALESCE(ph.distribution_type, 'APPROVED')::text AS distribution_type,
        CASE
          WHEN UPPER(COALESCE(ph.distribution_type, '')) = 'MANUAL' AND ph.manual_request_id IS NOT NULL THEN TRUE
          ELSE FALSE
        END AS is_manual_provisioning,
        ph.issued_by::text AS issued_by,
        ph.pick_form_url::text AS pick_form_url,
        ph.issued_at AS created_at,
        NULL::jsonb AS physical_details
      FROM pick_history ph
      LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
      LEFT JOIN distributors d ON COALESCE(ph.distributor_id, sir.requester_id) = d.id
      LEFT JOIN mvnos m ON ph.mvno_id = m.id
      LEFT JOIN LATERAL (
        SELECT
          (SELECT esim_val
           FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)
           ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) ASC, SUBSTRING(esim_val FROM 20) ASC
           LIMIT 1)::text AS iccid_start,
          (SELECT esim_val
           FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)
           ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) DESC, SUBSTRING(esim_val FROM 20) DESC
           LIMIT 1)::text AS iccid_end,
          (SELECT jsonb_agg(esim_val ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) ASC, SUBSTRING(esim_val FROM 20) ASC)
           FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)) AS assigned_esims_sorted
      ) esim_range ON true
      WHERE UPPER(
        CASE
          WHEN jsonb_typeof(COALESCE(ph.assigned_esims, '[]'::jsonb)) = 'array'
            AND jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)) > 0
            THEN 'ESIM'
          ELSE COALESCE(ph.sim_type::text, sir.sim_type::text, 'PHYSICAL')
        END
      ) = 'ESIM'
        AND (COALESCE(ph.request_id::text, ph.manual_request_id::text) = $1 OR ph.request_id::text = $1)
    ),
    combined AS (
      SELECT * FROM physical_from_ph
      UNION ALL
      SELECT * FROM esim_from_ph
    )
    SELECT
      x.request_id,
      x.distributor_id::text AS distributor_id,
      x.distributor_name,
      x.distributor_email,
      x.sim_type,
      x.mvno_id::text AS mvno_id,
      x.mvno_name,
      x.carton_no,
      x.box_numbers,
      x.iccid_start,
      x.iccid_end,
      CASE WHEN x.sim_type = 'ESIM' THEN x.iccid_count ELSE NULL END AS iccid_count,
      x.quantity,
      x.status,
      x.distribution_type,
      COALESCE(x.is_manual_provisioning, FALSE) AS is_manual_provisioning,
      x.issued_by,
      x.contact_person,
      x.pick_form_url,
      x.created_at,
      CASE WHEN x.sim_type = 'PHYSICAL' THEN x.physical_details ELSE NULL END AS physical_details
    FROM combined x
    ORDER BY x.created_at DESC
    LIMIT 1
    `,
    [id]
  );

  const row = res.rows[0];
  if (!row) return null;

  const boxNumbers = Array.isArray(row.box_numbers) ? row.box_numbers : typeof row.box_numbers === 'string' ? (() => {
    try { return JSON.parse(row.box_numbers); } catch { return []; }
  })() : [];

  const physicalDetails = row.physical_details
    ? (typeof row.physical_details === 'string' ? (() => { try { return JSON.parse(row.physical_details); } catch { return null; } })() : row.physical_details)
    : null;

  return {
    request_id: String(row.request_id || ''),
    distributor_id: row.distributor_id ? String(row.distributor_id) : null,
    distributor_name: String(row.distributor_name || 'Unknown'),
    distributor_email: row.distributor_email ? String(row.distributor_email) : null,
    sim_type: String(row.sim_type || 'PHYSICAL').toUpperCase() === 'ESIM' ? 'ESIM' : 'PHYSICAL',
    mvno_id: row.mvno_id ? String(row.mvno_id) : null,
    mvno_name: String(row.mvno_name || ''),
    carton_no: row.carton_no ? String(row.carton_no) : null,
    box_numbers: (boxNumbers || []).map((v: any) => String(v)).filter(Boolean),
    iccid_start: row.iccid_start ? String(row.iccid_start) : null,
    iccid_end: row.iccid_end ? String(row.iccid_end) : null,
    iccid_count: row.iccid_count === null || row.iccid_count === undefined ? null : Number(row.iccid_count) || 0,
    quantity: Number(row.quantity) || 0,
    status: String(row.status || 'COMPLETED'),
    distribution_type: String(row.distribution_type || ''),
    is_manual_provisioning: Boolean(row.is_manual_provisioning),
    contact_person: row.contact_person ? String(row.contact_person) : null,
    issued_by: row.issued_by ? String(row.issued_by) : null,
    pick_form_url: row.pick_form_url ? String(row.pick_form_url) : null,
    created_at: new Date(row.created_at).toISOString(),
    physical_details: physicalDetails ? (physicalDetails as any[]).map((d: any) => ({
      carton_no: d?.carton_no ? String(d.carton_no) : null,
      box_number: d?.box_number ? String(d.box_number) : null,
      box_display: d?.box_display ? String(d.box_display) : null,
      iccid_start: d?.iccid_start ? String(d.iccid_start) : null,
      iccid_end: d?.iccid_end ? String(d.iccid_end) : null,
      quantity: Number(d?.quantity) || 0,
    })) : null,
    esim_iccids: Array.isArray(row.esim_iccids) ? row.esim_iccids : null,
  };
}

function csvEscape(value: any): string {
  const s = value === null || value === undefined ? '' : String(value);
  // Force Excel to treat long numeric strings (ICCIDs) strictly as text: ="value"
  if (/^[0-9]{10,}$/.test(s)) {
    return `="${s}"`;
  }
  // Keep dates as quoted strings to prevent reformatting
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function exportDistributionHistoryCsv(args: {
  type: 'physical' | 'esim';
  filters: Omit<DistributionHistoryFilters, 'limit' | 'offset'>;
  request_id?: string;
}): Promise<{ filename: string; csv: string; record_count: number }> {
  await ensureManualProvisioningSchema();

  const type = String(args.type || '').toLowerCase() as 'physical' | 'esim';
  if (type !== 'physical' && type !== 'esim') {
    throw new Error('export type must be physical or esim');
  }

  const values: any[] = [];
  const where: string[] = [];
  const add = (sql: string, value: any) => {
    values.push(value);
    where.push(sql.replace('$?', `$${values.length}`));
  };

  const mvnoId = args.filters?.mvno_id ? String(args.filters.mvno_id) : undefined;
  const distributorId = args.filters?.distributor_id ? String(args.filters.distributor_id) : undefined;
  const dateFrom = args.filters?.date_from ? String(args.filters.date_from) : undefined;
  const dateTo = args.filters?.date_to ? String(args.filters.date_to) : undefined;
  const search = args.filters?.search ? String(args.filters.search).trim() : '';
  const requestId = args.request_id ? String(args.request_id).trim() : '';

  if (mvnoId) add(`x.mvno_id = $?::uuid`, mvnoId);
  if (distributorId) add(`x.distributor_id = $?::uuid`, distributorId);
  if (dateFrom) add(`x.created_at >= $?::timestamptz`, dateFrom);
  if (dateTo) add(`x.created_at <= $?::timestamptz`, dateTo);
  if (requestId) add(`x.request_id = $?::text`, requestId);
  if (search) {
    const sv = `%${search}%`;
    values.push(sv);
    const p = `$${values.length}`;
    where.push(`(
      x.request_id ILIKE ${p}
      OR x.distributor_name ILIKE ${p}
      OR COALESCE(x.distributor_email, '') ILIKE ${p}
      OR x.mvno_name ILIKE ${p}
      OR COALESCE(x.carton_no, '') ILIKE ${p}
      OR COALESCE(x.box_numbers, '[]'::jsonb)::text ILIKE ${p}
      OR COALESCE(x.iccid_start, '') ILIKE ${p}
      OR COALESCE(x.iccid_end, '') ILIKE ${p}
      OR (x.sim_type = 'ESIM' AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(x.esim_iccids, '[]'::jsonb)) AS es(val)
        WHERE es.val ILIKE ${p}
      ))
    )`);
  }

  const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';

  // Keep export CTE in sync with getDistributionHistory().
  const cteSql = `
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
        ph.pick_form_url::text AS pick_form_url,
        ph.issued_at AS created_at,
        ph.distribution_id AS distribution_id,
        ph.assigned_boxes AS assigned_boxes,
        CASE
          WHEN UPPER(COALESCE(ph.distribution_type, '')) = 'MANUAL' AND ph.manual_request_id IS NOT NULL THEN TRUE
          ELSE FALSE
        END AS is_manual_provisioning,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
              AND sal.details->>'pick_history_id' = ph.id::text
          ) THEN 'REVERSED'::text
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.request_id = ph.request_id AND sal.action = 'DISTRIBUTION_REVERSED'
          ) THEN 'REVERSED'::text
          ELSE COALESCE(sir.status, 'COMPLETED')::text
        END AS status
      FROM pick_history ph
      LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
      LEFT JOIN distributors d ON COALESCE(ph.distributor_id, sir.requester_id) = d.id
      LEFT JOIN mvnos m ON COALESCE(ph.mvno_id, sir.mvno_id) = m.id
      -- Some legacy eSIM distributions missed sim_type/sir rows; infer using assigned_esims.
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
          -- Case 1: both rows have assigned_boxes — use containment check
          EXISTS (
            SELECT 1 FROM pick_history ph2
            WHERE ph2.manual_request_id IS NOT NULL
              AND ph2.distributor_id = ph.distributor_id
              AND ph2.assigned_boxes IS NOT NULL
              AND ph.assigned_boxes IS NOT NULL
              AND ph2.assigned_boxes::jsonb @> ph.assigned_boxes::jsonb
          )
          OR
          -- Case 2: ghost has no assigned_boxes — check via box_pick_records for same
          -- distributor whether those boxes are covered by a manual provision
          (
            ph.assigned_boxes IS NULL
            AND EXISTS (
              SELECT 1
              FROM box_pick_records bpr2
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
        b.request_id,
        b.distributor_id,
        b.distributor_name,
        b.distributor_email,
        b.mvno_id,
        b.mvno_name,
        b.distribution_type,
        b.issued_by,
        b.contact_person,
        b.pick_form_url,
        b.created_at,
        b.status,
        b.is_manual_provisioning,
        b.distribution_id,
        (ab.item->>'box_id')::uuid AS box_id,
        COALESCE((ab.item->>'quantity')::int, 0) AS box_quantity
      FROM ph_physical_base b
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.assigned_boxes, '[]'::jsonb)) AS ab(item)
    ),
    ph_physical_detail AS (
      SELECT
        r.request_id,
        r.distributor_id,
        r.distributor_name,
        r.distributor_email,
        r.mvno_id,
        r.mvno_name,
        'PHYSICAL'::text AS sim_type,
        r.distribution_type,
        r.issued_by,
        r.contact_person,
        r.pick_form_url,
        r.created_at,
        r.status,
        r.is_manual_provisioning,
        c.carton_number::text AS carton_no,
        b.box_number::text AS box_number,
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
    physical_from_ph AS (
      SELECT
        request_id,
        distributor_id,
        distributor_name,
        distributor_email,
        'PHYSICAL'::text AS sim_type,
        mvno_id,
        mvno_name,
        CASE WHEN COUNT(DISTINCT carton_no) = 1 THEN MAX(carton_no) ELSE NULL END::text AS carton_no,
        COALESCE(jsonb_agg(DISTINCT box_display), '[]'::jsonb) AS box_numbers,
        MIN(iccid_start)::text AS iccid_start,
        MAX(iccid_end)::text AS iccid_end,
        NULL::jsonb AS esim_iccids,
        NULL::int AS iccid_count,
        COALESCE(SUM(quantity), 0)::int AS quantity,
        MAX(status)::text AS status,
        MAX(distribution_type)::text AS distribution_type,
        BOOL_OR(is_manual_provisioning) AS is_manual_provisioning,
        MAX(issued_by)::text AS issued_by,
        MAX(contact_person)::text AS contact_person,
        MAX(pick_form_url)::text AS pick_form_url,
        MAX(created_at) AS created_at
      FROM ph_physical_detail
      GROUP BY request_id, distributor_id, distributor_name, distributor_email, mvno_id, mvno_name
    ),
    bpr_only_detail AS (
      SELECT
        bpr.distribution_id::text AS request_id,
        bpr.distributor_id AS distributor_id,
        COALESCE(d.name, 'Unknown')::text AS distributor_name,
        d.email::text AS distributor_email,
        'PHYSICAL'::text AS sim_type,
        c.mvno_id AS mvno_id,
        COALESCE(m.name::text, '')::text AS mvno_name,
        c.carton_number::text AS carton_no,
        b.box_number::text AS box_number,
        (((COALESCE(co.carton_seq, 1) - 1) * 20 + COALESCE(b.box_number, 0))::text
          || '/' || COALESCE(mbt.total_boxes::text, '0'))::text AS box_display,
        bpr.iccid_start::text AS iccid_start,
        bpr.iccid_end::text AS iccid_end,
        bpr.sims_picked::int AS quantity,
        bpr.picked_at AS created_at
      FROM box_pick_records bpr
      LEFT JOIN boxes b ON bpr.box_id = b.id
      LEFT JOIN cartons c ON b.carton_id = c.id
      LEFT JOIN carton_order co ON c.id = co.carton_id
      LEFT JOIN mvno_box_totals mbt ON COALESCE(b.mvno_id, c.mvno_id) = mbt.mvno_id
      LEFT JOIN mvnos m ON c.mvno_id = m.id
      LEFT JOIN distributors d ON bpr.distributor_id = d.id
      WHERE bpr.box_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM pick_history ph
          WHERE ph.distribution_id = bpr.distribution_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pick_history ph2
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ph2.assigned_boxes, '[]'::jsonb)) AS ab(item)
          WHERE ph2.manual_request_id IS NOT NULL
            AND ph2.distributor_id = bpr.distributor_id
            AND (ab.item->>'box_id')::uuid = bpr.box_id
        )
    ),
    physical_from_bpr_only AS (
      SELECT
        request_id,
        distributor_id,
        distributor_name,
        distributor_email,
        'PHYSICAL'::text AS sim_type,
        mvno_id,
        mvno_name,
        CASE WHEN COUNT(DISTINCT carton_no) = 1 THEN MAX(carton_no) ELSE NULL END::text AS carton_no,
        COALESCE(jsonb_agg(DISTINCT box_display), '[]'::jsonb) AS box_numbers,
        MIN(iccid_start)::text AS iccid_start,
        MAX(iccid_end)::text AS iccid_end,
        NULL::jsonb AS esim_iccids,
        NULL::int AS iccid_count,
        COALESCE(SUM(quantity), 0)::int AS quantity,
        'COMPLETED'::text AS status,
        'MANUAL'::text AS distribution_type,
        FALSE::boolean AS is_manual_provisioning,
        'System'::text AS issued_by,
        NULL::text AS contact_person,
        NULL::text AS pick_form_url,
        MAX(created_at) AS created_at
      FROM bpr_only_detail
      GROUP BY request_id, distributor_id, distributor_name, distributor_email, mvno_id, mvno_name
    ),
    esim_from_ph AS (
      SELECT
        COALESCE(ph.request_id, ph.manual_request_id)::text AS request_id,
        COALESCE(ph.distributor_id, sir.requester_id) AS distributor_id,
        COALESCE(d.name, 'Unknown')::text AS distributor_name,
        d.email::text AS distributor_email,
        'ESIM'::text AS sim_type,
        ph.mvno_id AS mvno_id,
        COALESCE(ph.mvno_name::text, m.name::text, '')::text AS mvno_name,
        NULL::text AS carton_no,
        '[]'::jsonb AS box_numbers,
        esim_range.iccid_start::text AS iccid_start,
        esim_range.iccid_end::text AS iccid_end,
        COALESCE(esim_range.assigned_esims_sorted, '[]'::jsonb) AS esim_iccids,
        COALESCE(jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)), 0)::int AS iccid_count,
        COALESCE(ph.quantity, COALESCE(jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)), 0))::int AS quantity,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.action = 'MANUAL_DISTRIBUTION_REVERSED'
              AND sal.details->>'pick_history_id' = ph.id::text
          ) THEN 'REVERSED'::text
          WHEN EXISTS (
            SELECT 1 FROM stock_audit_logs sal
            WHERE sal.request_id = ph.request_id AND sal.action = 'DISTRIBUTION_REVERSED'
          ) THEN 'REVERSED'::text
          ELSE COALESCE(sir.status, 'COMPLETED')::text
        END AS status,
        COALESCE(ph.distribution_type, 'APPROVED')::text AS distribution_type,
        CASE
          WHEN UPPER(COALESCE(ph.distribution_type, '')) = 'MANUAL' AND ph.manual_request_id IS NOT NULL THEN TRUE
          ELSE FALSE
        END AS is_manual_provisioning,
        ph.issued_by::text AS issued_by,
        COALESCE(ph.contact_person, d.contact_person, '')::text AS contact_person,
        ph.pick_form_url::text AS pick_form_url,
        ph.issued_at AS created_at
      FROM pick_history ph
      LEFT JOIN stock_issuance_requests sir ON ph.request_id = sir.id
      LEFT JOIN distributors d ON COALESCE(ph.distributor_id, sir.requester_id) = d.id
      LEFT JOIN mvnos m ON ph.mvno_id = m.id
      LEFT JOIN LATERAL (
        SELECT
          (SELECT esim_val
           FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)
           ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) ASC, SUBSTRING(esim_val FROM 20) ASC
           LIMIT 1)::text AS iccid_start,
          (SELECT esim_val
           FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)
           ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) DESC, SUBSTRING(esim_val FROM 20) DESC
           LIMIT 1)::text AS iccid_end,
          (SELECT jsonb_agg(esim_val ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) ASC, SUBSTRING(esim_val FROM 20) ASC)
           FROM jsonb_array_elements_text(COALESCE(ph.assigned_esims, '[]'::jsonb)) AS es(esim_val)) AS assigned_esims_sorted
      ) esim_range ON true
      WHERE UPPER(
        CASE
          WHEN jsonb_typeof(COALESCE(ph.assigned_esims, '[]'::jsonb)) = 'array'
            AND jsonb_array_length(COALESCE(ph.assigned_esims, '[]'::jsonb)) > 0
            THEN 'ESIM'
          ELSE COALESCE(ph.sim_type::text, sir.sim_type::text, 'PHYSICAL')
        END
      ) = 'ESIM'
    ),
    combined AS (
      SELECT * FROM physical_from_ph
      UNION ALL
      SELECT * FROM physical_from_bpr_only
      UNION ALL
      SELECT * FROM esim_from_ph
    )
  `;

  const sql = `${cteSql}
    SELECT
      x.request_id,
      COALESCE(x.distributor_name, 'Unknown')::text AS distributor_name,
      x.distributor_email::text AS distributor_email,
      x.sim_type::text AS sim_type,
      x.mvno_name::text AS mvno_name,
      x.carton_no::text AS carton_no,
      x.box_numbers AS box_numbers,
      x.iccid_start::text AS iccid_start,
      x.iccid_end::text AS iccid_end,
      x.quantity::int AS quantity,
      x.distribution_type::text AS distribution_type,
      CASE
        WHEN COALESCE(x.is_manual_provisioning, FALSE) THEN to_char(x.created_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD')
        ELSE to_char(x.created_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD HH24:MI')
      END AS distribution_date,
      CASE
        WHEN x.sim_type = 'ESIM' THEN (
          SELECT string_agg(esim_val, E'\\n' ORDER BY SUBSTRING(esim_val FROM 1 FOR 19) ASC, SUBSTRING(esim_val FROM 20) ASC)
          FROM jsonb_array_elements_text(COALESCE(x.esim_iccids, '[]'::jsonb)) AS es(esim_val)
        )
        ELSE NULL
      END AS iccid_list
    FROM combined x
    WHERE x.sim_type = $${values.length + 1}::text
    ${whereSql}
    ORDER BY x.created_at DESC
    LIMIT 50000`;

  values.push(type === 'physical' ? 'PHYSICAL' : 'ESIM');
  const res = await query(sql, values);

  const nowStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = type === 'physical' ? `physical_distribution_report_${nowStamp}.csv` : `esim_distribution_report_${nowStamp}.csv`;

  let headers: string[] = [];
  if (type === 'physical') {
    headers = [
      'Request ID',
      'Distributor Name',
      'Distributor Email',
      'SIM Type',
      'MVNO Name',
      'Carton Number',
      'Box Number(s)',
      'ICCID Start',
      'ICCID End',
      'Quantity',
      'Distribution Date',
    ];
  } else {
    headers = [
      'Request ID',
      'Distributor Name',
      'Distributor Email',
      'SIM Type',
      'MVNO Name',
      'ICCID LIST',
      'Quantity',
      'Distribution Date',
    ];
  }

  const rows = (res.rows || []).map((r: any) => {
    const boxNumbers = Array.isArray(r.box_numbers) ? r.box_numbers : typeof r.box_numbers === 'string' ? (() => {
      try { return JSON.parse(r.box_numbers); } catch { return []; }
    })() : [];
    const boxNumbersText = (boxNumbers || []).map((v: any) => String(v)).filter(Boolean).join(', ');

    if (type === 'physical') {
      return [
        r.request_id || '',
        r.distributor_name || '',
        r.distributor_email || '',
        r.sim_type || 'PHYSICAL',
        r.mvno_name || '',
        r.carton_no || '',
        boxNumbersText,
        r.iccid_start || '',
        r.iccid_end || '',
        r.quantity || 0,
        r.distribution_date || '',
      ];
    }

    return [
      r.request_id || '',
      r.distributor_name || '',
      r.distributor_email || '',
      r.sim_type || 'ESIM',
      r.mvno_name || '',
      r.iccid_list || '',
      r.quantity || 0,
      r.distribution_date || '',
    ];
  });

  const csv = [headers.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n');
  return { filename, csv, record_count: rows.length };
}

// ==================== STOCK ASSIGNMENT & APPROVAL WORKFLOW ====================

// Assign stock to a request (changes status to READY_FOR_APPROVAL)
export async function assignStockToRequest(
  requestId: string,
  cartonNumber: string,
  boxNumber: string,
  quantityAssigned: number
): Promise<StockIssuanceRequest> {
  console.log("Assigning stock:", { requestId, cartonNumber, boxNumber, quantityAssigned });
  
  // Get the request
  const request = await getStockIssuanceRequestById(requestId);
  if (!request) {
    throw new Error('Request not found');
  }
  
  // Check if stock has already been issued for this request
  if (request.status === 'STOCK_ISSUED' || request.status === 'COMPLETED') {
    throw new Error('Stock has already been issued for this request. Cannot re-assign stock.');
  }
  
  // Update the request with assigned stock and change status to WAITING_FOR_APPROVAL
  const result = await query(
    `UPDATE stock_issuance_requests 
     SET assigned_box_quantities = $1,
         status = 'WAITING_FOR_APPROVAL',
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [
      JSON.stringify([{
        carton_number: cartonNumber,
        box_number: boxNumber,
        quantity_assigned: quantityAssigned
      }]),
      requestId
    ]
  );
  
  return result.rows[0];
}

export interface IssueStockResult {
  request: StockIssuanceRequest;
  pdf_url: string | null;
}

export async function issueApprovedStockRequest(requestId: string): Promise<IssueStockResult> {
  const request = await getStockIssuanceRequestById(requestId);
  if (!request) {
    throw new Error('Request not found');
  }
  // Check for either old status (LEVEL_2_APPROVED) or new status (WAITING_FOR_APPROVAL with consensus)
  // The background checker will set to STOCK_ISSUED when consensus is reached
  // COMPLETED status allows regenerating PDF after final report is generated
  // READY_FOR_APPROVAL is the consensus-approved status after both emails approved
  // AWAITING_EMAIL_APPROVAL is the status when waiting for email approvals
  const validStatuses = ['READY_FOR_APPROVAL', 'LEVEL_2_APPROVED', 'STOCK_ISSUED', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'AWAITING_EMAIL_APPROVAL'];
  if (!validStatuses.includes(request.status)) {
    throw new Error(`Request is not in a valid state for issuance. Current status: ${request.status}`);
  }
  const isAlreadyIssued = request.status === 'COMPLETED';
  if (!request.requester_id) {
    throw new Error('Request has no requester/distributor');
  }

  const assignedBoxes = Array.isArray(request.assigned_box_quantities) ? request.assigned_box_quantities : [];
  const assignedEsims = Array.isArray(request.assigned_esim_iccids) ? request.assigned_esim_iccids : [];

  let issuedRequest = request;

  if (!isAlreadyIssued) {
    if (request.sim_type === 'ESIM') {
      if (!assignedEsims.length) {
        throw new Error('No assigned eSIM ICCIDs found for this request');
      }
      await distributeESims(
        request.requester_id,
        request.mvno_id,
        assignedEsims,
        'Stock issuance fulfillment'
      );
    } else {
      const boxQuantities = assignedBoxes
        .map((item: any) => ({
          box_id: item?.box_id,
          quantity: Number(item?.quantity || 0),
        }))
        .filter((item: any) => item.box_id && item.quantity > 0);

      if (!boxQuantities.length) {
        throw new Error('No assigned physical boxes found for this request');
      }

      await distributePhysicalBoxes(
        request.requester_id,
        boxQuantities,
        'Stock issuance fulfillment'
      );
    }

    try {
      await generatePickHistory(requestId);
      logLine('INF', 'ISSUANCE', `Pick history created for request: ${requestId}`);
    } catch (pickError) {
      logLine('WRN', 'ISSUANCE', `Failed to create pick history for ${requestId}: ${(pickError as Error)?.message || pickError}`);
    }

    const updateResult = await query(
      `UPDATE stock_issuance_requests
       SET status = 'COMPLETED',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [requestId]
    );

    const updatedRequest = updateResult.rows[0];
    if (!updatedRequest) {
      throw new Error('Failed to update request to COMPLETED');
    }
    issuedRequest = updatedRequest;
  }

  let pdfUrl: string | null = null;
  try {
    const distributorResult = await query(
      `SELECT name, contact_person, email AS contact_email FROM distributors WHERE id = $1 LIMIT 1`,
      [request.requester_id]
    );
    const distributorName = distributorResult.rows[0]?.name || 'Unknown Distributor';

    let assignedBoxDetails: any[] = [];
    if (request.sim_type !== 'ESIM' && assignedBoxes.length) {
      const boxIds = assignedBoxes.map((b: any) => b?.box_id).filter(Boolean);
      if (boxIds.length) {
        const detailsResult = await query(
          `
          SELECT
            b.id::text AS box_id,
            b.box_number,
            c.carton_number,
            COALESCE(b.total_sims, 0) AS total_sims,
            latest_pick.iccid_start AS msisdn_start,
            latest_pick.iccid_end AS msisdn_end
          FROM boxes b
          LEFT JOIN cartons c ON b.carton_id = c.id
          LEFT JOIN LATERAL (
            SELECT bpr.iccid_start, bpr.iccid_end
            FROM box_pick_records bpr
            WHERE bpr.box_id = b.id
              AND bpr.distributor_id = $2::uuid
            ORDER BY bpr.picked_at DESC
            LIMIT 1
          ) latest_pick ON true
          WHERE b.id = ANY($1::uuid[])
          ORDER BY c.carton_number, b.box_number
          `,
          [boxIds, request.requester_id]
        );
        assignedBoxDetails = detailsResult.rows.map((row: any) => ({
          ...row,
          sims_picked: assignedBoxes.find((b: any) => b?.box_id === row.box_id)?.quantity ?? row.total_sims,
        }));
      }
    }

    let level1ApproverEmail: string | null = request.level_1_approver_email || null;
    let level2ApproverEmail: string | null = request.level_2_approver_email || null;

    if (!level1ApproverEmail || !level2ApproverEmail) {
      try {
        const approverConfigResult = await query(
          `SELECT approver_level, approver_email
           FROM stock_approver_config
           WHERE is_active = true
             AND approver_level IN ('LEVEL_1', 'LEVEL_2')`
        );

        for (const row of approverConfigResult.rows) {
          const level = String(row.approver_level || '').toUpperCase();
          if (level === 'LEVEL_1' && !level1ApproverEmail) {
            level1ApproverEmail = row.approver_email || null;
          }
          if (level === 'LEVEL_2' && !level2ApproverEmail) {
            level2ApproverEmail = row.approver_email || null;
          }
        }
      } catch {
      }
    }

    const { savePickFormPDF } = await import('./pdf.service.js');
    pdfUrl = await savePickFormPDF({
      request_id: request.id,
      distributor_name: distributorName,
      request_date: request.created_at,
      requested_quantity: request.quantity,
      assigned_boxes: assignedBoxDetails,
      approved_by_l1_email: level1ApproverEmail,
      approved_by_l2_email: level2ApproverEmail,
      picked_by_name: distributorResult.rows[0]?.contact_person || distributorResult.rows[0]?.contact_email || request.requester_id,
    });

    if (pdfUrl && request.sim_type !== 'ESIM' && assignedBoxes.length) {
      const boxIds = assignedBoxes.map((b: any) => b?.box_id).filter(Boolean);
      if (boxIds.length) {
        try {
          await query(
            `
            UPDATE box_pick_records
            SET pick_form_url = $1
            WHERE distributor_id = $2
              AND box_id = ANY($3::uuid[])
            `,
            [pdfUrl, request.requester_id, boxIds]
          );
        } catch (pickUpdateError: any) {
          if (pickUpdateError?.code !== '42703' && pickUpdateError?.code !== '42P01') {
            throw pickUpdateError;
          }
        }
      }
    }
  } catch (error) {
    pdfUrl = null;
  }

  return {
    request: issuedRequest,
    pdf_url: pdfUrl,
  };
}

// Get requests ready for approval
export async function getRequestsForApproval(): Promise<StockIssuanceRequest[]> {
  const result = await query(
    `SELECT 
      sir.*,
      d.name as distributor_name
    FROM stock_issuance_requests sir
    LEFT JOIN distributors d ON sir.requester_id = d.id
    WHERE (
        COALESCE(jsonb_array_length(sir.assigned_box_quantities), 0) > 0
        OR COALESCE(array_length(sir.assigned_esim_iccids, 1), 0) > 0
      )
      AND (
        sir.status IN ('PENDING', 'READY_FOR_APPROVAL', 'AWAITING_EMAIL_APPROVAL', 'LEVEL_1_APPROVED', 'STOCK_ISSUED')
        OR (sir.status = 'COMPLETED' AND sir.updated_at >= NOW() - INTERVAL '2 days')
      )
    ORDER BY
      CASE WHEN sir.status = 'COMPLETED' THEN 1 ELSE 0 END,
      sir.created_at DESC`
  );
  return result.rows;
}

// Audit log types
export interface AuditLog {
  id: string;
  request_id: string | null;
  action: string;
  details: Record<string, any>;
  performed_by: string | null;
  performed_by_email: string | null;
  created_at: Date;
}

// Get audit logs
export async function getAuditLogs(requestId?: string): Promise<AuditLog[]> {
  let sql = `
    SELECT 
      sal.id,
      sal.request_id,
      sal.action,
      sal.details,
      sal.performed_by,
      sal.performed_by_email,
      sal.created_at
    FROM stock_audit_logs sal
  `;
  
  if (requestId) {
    sql += ' WHERE sal.request_id = $1';
    sql += ' ORDER BY sal.created_at DESC';
    const result = await query(sql, [requestId]);
    return result.rows;
  }
  
  sql += ' ORDER BY sal.created_at DESC LIMIT 100';
  const result = await query(sql);
  return result.rows;
}

// ==================== STRAY STOCK ====================

export type StrayStatus = 'STRAY' | 'RETURNED_TO_POOL' | 'WRITTEN_OFF';
export type StrayReason = 'LAB_TESTING' | 'VENDOR_INTEROP' | 'DEMO' | 'QA' | 'OTHER';

export interface StrayStockRow {
  id: string;
  iccid: string;
  msisdn: string | null;
  mvno_id: string;
  mvno_name: string;
  reason: StrayReason;
  marked_by: string | null;
  marked_by_email: string | null;
  status: StrayStatus;
  date_marked: string;
  date_resolved: string | null;
  notes: string | null;
}

let strayStockSchemaReady = false;
let strayStockSchemaPromise: Promise<void> | null = null;

async function ensureStrayStockSchema(): Promise<void> {
  if (strayStockSchemaReady) return;
  if (strayStockSchemaPromise) {
    await strayStockSchemaPromise;
    return;
  }

  strayStockSchemaPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS stray_stock (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        iccid VARCHAR(25) NOT NULL UNIQUE,
        msisdn VARCHAR(25),
        mvno_id UUID REFERENCES mvnos(id) ON DELETE SET NULL,
        reason VARCHAR(40) NOT NULL CHECK (reason IN ('LAB_TESTING','VENDOR_INTEROP','DEMO','QA','OTHER')),
        marked_by VARCHAR(255),
        marked_by_email VARCHAR(255),
        status VARCHAR(40) NOT NULL DEFAULT 'STRAY' CHECK (status IN ('STRAY','RETURNED_TO_POOL','WRITTEN_OFF')),
        notes TEXT,
        date_marked TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        date_resolved TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_stray_stock_status ON stray_stock(status)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_stray_stock_mvno_id ON stray_stock(mvno_id)
    `);
  })();

  await strayStockSchemaPromise;
  strayStockSchemaReady = true;
}

export async function getStrayStock(): Promise<StrayStockRow[]> {
  await ensureStrayStockSchema();
  const result = await query(
    `SELECT
       ss.id,
       ss.iccid,
       ss.msisdn,
       ss.mvno_id,
       COALESCE(m.name, 'Unknown') AS mvno_name,
       ss.reason,
       ss.marked_by,
       ss.marked_by_email,
       ss.status,
       ss.date_marked,
       ss.date_resolved,
       ss.notes
     FROM stray_stock ss
     LEFT JOIN mvnos m ON ss.mvno_id = m.id
     ORDER BY ss.date_marked DESC`
  );
  return result.rows;
}

export async function markAsStray(payload: {
  iccid: string;
  msisdn?: string | null;
  mvno_id?: string;
  reason: StrayReason;
  marked_by?: string;
  marked_by_email?: string;
  notes?: string;
}): Promise<{ success: boolean; id?: string; error?: string }> {
  await ensureStrayStockSchema();

  const iccid = normalizeIccid(payload.iccid);
  if (!iccid) return { success: false, error: 'ICCID is required' };

  const reason: StrayReason = payload.reason || 'OTHER';

  try {
    const result = await transaction(async (client) => {
      // For eSIM stock, mark status as stray if it exists
      const esimCheck = await client.query(
        `SELECT id, status, mvno_id, msisdn FROM esim_stock WHERE iccid = $1 FOR UPDATE`,
        [iccid]
      );

      let resolvedMvnoId = payload.mvno_id || null;
      let resolvedMsisdn = payload.msisdn || null;

      if (esimCheck.rows[0]) {
        const esim = esimCheck.rows[0];
        if (esim.status === 'stray') {
          throw new Error('ICCID is already marked as stray');
        }
        resolvedMvnoId = resolvedMvnoId || esim.mvno_id;
        resolvedMsisdn = resolvedMsisdn || esim.msisdn;
        await client.query(
          `UPDATE esim_stock SET status = 'stray', updated_at = NOW() WHERE iccid = $1`,
          [iccid]
        );
      }

      const insertResult = await client.query(
        `INSERT INTO stray_stock (iccid, msisdn, mvno_id, reason, marked_by, marked_by_email, status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, 'STRAY', $7)
         ON CONFLICT (iccid) DO UPDATE SET
           status = 'STRAY',
           reason = EXCLUDED.reason,
           msisdn = EXCLUDED.msisdn,
           mvno_id = EXCLUDED.mvno_id,
           notes = EXCLUDED.notes,
           date_marked = NOW(),
           date_resolved = NULL,
           updated_at = NOW()
         RETURNING id`,
        [
          iccid,
          resolvedMsisdn,
          resolvedMvnoId,
          reason,
          payload.marked_by || null,
          payload.marked_by_email || null,
          payload.notes || null,
        ]
      );

      return { id: insertResult.rows[0].id as string };
    });

    return { success: true, id: result.id };
  } catch (e: any) {
    logLine('ERR', 'STRAY_STOCK', `markAsStray failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

export async function returnStrayToPool(id: string): Promise<{ success: boolean; error?: string }> {
  await ensureStrayStockSchema();

  if (!id) return { success: false, error: 'ID is required' };

  try {
    await transaction(async (client) => {
      const existing = await client.query(
        `SELECT iccid, status FROM stray_stock WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (!existing.rows[0]) throw new Error('Stray record not found');
      const row = existing.rows[0];
      if (row.status !== 'STRAY') throw new Error(`Cannot return record with status ${row.status}`);

      await client.query(
        `UPDATE esim_stock SET status = 'available', updated_at = NOW() WHERE iccid = $1 AND status = 'stray'`,
        [row.iccid]
      );

      await client.query(
        `UPDATE stray_stock SET status = 'RETURNED_TO_POOL', date_resolved = NOW(), updated_at = NOW() WHERE id = $1`,
        [id]
      );
    });

    return { success: true };
  } catch (e: any) {
    logLine('ERR', 'STRAY_STOCK', `returnStrayToPool failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

export async function writeOffStray(id: string): Promise<{ success: boolean; error?: string }> {
  await ensureStrayStockSchema();

  if (!id) return { success: false, error: 'ID is required' };

  try {
    await transaction(async (client) => {
      const existing = await client.query(
        `SELECT status FROM stray_stock WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (!existing.rows[0]) throw new Error('Stray record not found');
      if (existing.rows[0].status === 'WRITTEN_OFF') throw new Error('Record is already written off');

      await client.query(
        `UPDATE stray_stock SET status = 'WRITTEN_OFF', date_resolved = NOW(), updated_at = NOW() WHERE id = $1`,
        [id]
      );
    });

    return { success: true };
  } catch (e: any) {
    logLine('ERR', 'STRAY_STOCK', `writeOffStray failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

