import { query, transaction } from '../config/database.js';
import type { PoolClient } from 'pg';
import * as emailService from './email.service.js';

// Onboarding document uploads (KYC / MM agent / Company docs) are stored on local
// disk under `uploads/<ONBOARDING_DOCUMENTS_DIR>/` and served via the existing
// `/uploads` static route (see index.ts) — mirrors the pattern already used by
// pdf.service.ts#savePickFormPDF. Previously backed by Supabase Storage; dropped
// in favor of local storage (see backend/docs/boss-api-integration.md for context
// on other external integrations still pending).
export const ONBOARDING_DOCUMENTS_DIR = 'onboarding';
export const ONBOARDING_DOCUMENTS_MIME_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
export const ONBOARDING_DOCUMENTS_MAX_SIZE_BYTES = 10 * 1024 * 1024;

// ==================== PHASE 2: COMPANY / DISTRIBUTOR ONBOARDING ====================
// Additive schema for the Company & Agent Onboarding module. Follows the same
// idempotent "ensure*" boot-time convention already used by
// stock.service.ts#ensureDistributionCompatibility — no manual migration
// runner exists in this codebase, so schema changes are applied via
// CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS at server startup.
//
// Existing `distributors` table is extended (nullable company_id +
// distributor_code) rather than replaced — every pre-existing stock
// request/approval/distribution query against `distributors` is untouched.

export async function ensureOnboardingSchema(): Promise<void> {
  await ensureCompaniesTable();
  await ensureCompanyDocumentsTable();
  await ensureCompanyApprovalsTable();
  await ensureDocumentChecklistRulesTable();
  await ensureSearchFeeSettingsTable();
  await ensureOnboardingAuditLogsTable();
  await ensureDistributorsExtensionColumns();
  await ensureSuppliedDistributors();
  await ensureKycAgentsTable();
  await ensureKycAgentDocumentsTable();
  await ensureKycAgentChecklistRules();
  await ensureMmAgentsTable();
  await ensureMmAgentDocumentsTable();
  await ensureMmAgentChecklistRules();
  await ensureMmDistributorsTable();
  await ensureMerchantsTable();
  await ensureMerchantDocumentsTable();
  await ensureMerchantChecklistRules();
  await ensureDistributorSimRequestsTicketColumn();
}

async function ensureDistributorSimRequestsTicketColumn(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS distributor_sim_requests (
      id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      reference_no      VARCHAR(25)  UNIQUE,
      distributor_id    UUID         REFERENCES distributors(id) ON DELETE SET NULL,
      distributor_email VARCHAR(255),
      mvno_id           UUID,
      mvno_name         VARCHAR(100),
      sim_type          VARCHAR(10)  NOT NULL CHECK (sim_type IN ('PHYSICAL','ESIM')),
      quantity          INT          NOT NULL CHECK (quantity > 0),
      notes             TEXT,
      status            VARCHAR(30)  NOT NULL DEFAULT 'PENDING'
                                   CHECK (status IN ('PENDING','UNDER_REVIEW','APPROVED','REJECTED','ESCALATED','FULFILLED')),
      rejection_reason  TEXT,
      reviewed_by       VARCHAR(255),
      reviewed_at       TIMESTAMPTZ,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE SEQUENCE IF NOT EXISTS dsr_daily_seq`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dsr_distributor_id  ON distributor_sim_requests(distributor_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dsr_status          ON distributor_sim_requests(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dsr_created_at      ON distributor_sim_requests(created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dsr_distributor_email ON distributor_sim_requests(distributor_email)`);
  await query(`ALTER TABLE distributor_sim_requests ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(100)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_dsr_ticket_number ON distributor_sim_requests(ticket_number)`);
}

async function ensureCompaniesTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS companies (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_code         VARCHAR(20) UNIQUE,
      entity_type          VARCHAR(40) NOT NULL CHECK (entity_type IN (
                             'COMPANY','NGO','TRUST','COOPERATIVE','MDA_GOVERNMENT',
                             'POLITICAL_PARTY','FOREIGN_MISSION','REGIONAL_INTERNATIONAL_ORG'
                           )),
      partnership_types    TEXT[] NOT NULL DEFAULT '{}',
      name                 VARCHAR(255) NOT NULL,
      tin                  VARCHAR(50),
      registration_date    DATE,
      website              VARCHAR(255),
      physical_address     TEXT NOT NULL,
      business_reg_number  VARCHAR(100),
      contact_name         VARCHAR(255) NOT NULL,
      contact_designation  VARCHAR(100),
      contact_phone        VARCHAR(50) NOT NULL,
      contact_email        VARCHAR(255) NOT NULL,
      contact_nin_passport VARCHAR(100) NOT NULL,
      status               VARCHAR(30) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN (
                             'SUBMITTED','UNDER_VERIFICATION','SITE_VISIT_PENDING',
                             'PENDING_APPROVAL','APPROVED','REJECTED'
                           )),
      search_fee_amount    INTEGER,
      search_fee_status    VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (search_fee_status IN ('PENDING','PAID','WAIVED')),
      created_by           VARCHAR(255),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_name VARCHAR(255)`);
  await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(100)`);
  await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_email VARCHAR(255)`);
  await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_phone VARCHAR(50)`);
  // SIM-distributor-only fields — only collected/required when partnership_types includes SIM_DISTRIBUTOR.
  await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS distributor_name VARCHAR(255)`);
  await query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS distributor_contact VARCHAR(50)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_companies_ticket_number ON companies(ticket_number)`);
}

async function ensureCompanyDocumentsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS company_documents (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      document_key   VARCHAR(80) NOT NULL,
      document_label VARCHAR(255) NOT NULL,
      required       BOOLEAN NOT NULL DEFAULT true,
      ticked         BOOLEAN NOT NULL DEFAULT false,
      ticked_by      VARCHAR(255),
      ticked_at      TIMESTAMPTZ,
      file_url       TEXT,
      file_name      VARCHAR(255),
      uploaded_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, document_key)
    )
  `);
}

async function ensureCompanyApprovalsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS company_approvals (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      seat_order     INTEGER NOT NULL,
      seat_role      VARCHAR(50) NOT NULL,
      approver_email VARCHAR(255),
      status         VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SKIPPED')),
      decided_by     VARCHAR(255),
      decided_at     TIMESTAMPTZ,
      reason         TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, seat_order)
    )
  `);
}

/** Config/DB-driven document checklist rules, editable by compliance without a deploy. */
async function ensureDocumentChecklistRulesTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS document_checklist_rules (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_type           VARCHAR(40) NOT NULL,
      document_key          VARCHAR(80) NOT NULL,
      document_label        VARCHAR(255) NOT NULL,
      description           TEXT,
      sort_order             INTEGER NOT NULL DEFAULT 0,
      applies_to_partnership VARCHAR(40) NOT NULL DEFAULT '',
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entity_type, document_key, applies_to_partnership)
    )
  `);

  // Heal legacy rows: NULL is never "equal" to NULL under a UNIQUE constraint, so any
  // row inserted with applies_to_partnership = NULL bypassed ON CONFLICT DO NOTHING on
  // every server restart, silently duplicating the whole checklist each time.
  // Dedupe FIRST (treating NULL applies_to_partnership as equivalent via COALESCE) —
  // doing this before normalizing NULL -> '' avoids a unique-constraint violation on
  // the UPDATE below, since multiple NULL-duplicate rows would otherwise collide the
  // instant they're all rewritten to the same non-null '' value.
  await query(`
    DELETE FROM document_checklist_rules
     WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY entity_type, document_key, COALESCE(applies_to_partnership, '')
           ORDER BY created_at, id
         ) AS rn
         FROM document_checklist_rules
       ) ranked WHERE ranked.rn > 1
     )
  `);
  await query(`ALTER TABLE document_checklist_rules ALTER COLUMN applies_to_partnership SET DEFAULT ''`);
  await query(`UPDATE document_checklist_rules SET applies_to_partnership = '' WHERE applies_to_partnership IS NULL`);
  await query(`ALTER TABLE document_checklist_rules ALTER COLUMN applies_to_partnership SET NOT NULL`);

  const seed: Array<[string, string, string, string | null, number, string]> = [
    // entity_type, document_key, document_label, applies_to_partnership, sort_order, description
    ['COMPANY', 'certificate_of_incorporation', 'Certificate of Incorporation', null, 1, 'A certified copy of the Certificate of Incorporation issued by URSB.'],
    ['COMPANY', 'form_7_20', 'Form 7/20', null, 2, 'Latest annual return (Form 7/20) confirming the company is in good standing.'],
    ['COMPANY', 'form_18', 'Form 18', null, 3, 'Particulars of directors and secretary (Form 18).'],
    ['COMPANY', 'tin_certificate', 'TIN Certificate', null, 4, 'Uganda Revenue Authority TIN certificate for the company.'],
    ['COMPANY', 'director_id_passport_visa', "Director ID/Passport + Visa", null, 5, 'National ID, passport or visa copy for each director listed in Form 18.'],
    ['COMPANY', 'authorization_letter', 'Authorization Letter', null, 6, 'A signed letter authorizing the contact person to act on behalf of the company.'],
    ['COMPANY', 'legal_undertaking', 'Legal Undertaking', null, 7, 'Signed undertaking to comply with applicable laws and Hamilton Telecom policies.'],

    ['NGO', 'ngo_permit', 'NGO Permit', null, 1, 'Valid operating permit issued by the NGO Bureau.'],
    ['NGO', 'ngo_bureau_good_standing', 'NGO Bureau Letter of Good Standing', null, 2, 'Official confirmation from the NGO Bureau that the organization is in good standing.'],
    ['NGO', 'tin_certificate', 'TIN Certificate', null, 3, 'Uganda Revenue Authority TIN certificate for the NGO.'],
    ['NGO', 'exec_head_id_passport_visa', "Executive Head ID/Passport + Visa", null, 4, 'National ID or passport copy of the Executive Head / Country Director.'],
    ['NGO', 'authorization_letter', 'Authorization Letter', null, 5, 'Signed authorization letter from the Executive Head for the contact person.'],
    ['NGO', 'legal_undertaking', 'Legal Undertaking', null, 6, 'Signed undertaking to comply with applicable laws and Hamilton Telecom policies.'],

    ['TRUST', 'certificate_of_incorporation_lands', 'Certificate of Incorporation (Ministry of Lands)', null, 1, 'Certificate of Incorporation issued by the Ministry of Lands, Housing and Urban Development.'],
    ['TRUST', 'trust_deed', 'Trust Deed', null, 2, 'Certified copy of the registered Trust Deed.'],
    ['TRUST', 'tin_certificate', 'TIN Certificate', null, 3, 'Uganda Revenue Authority TIN certificate for the trust.'],
    ['TRUST', 'administrator_id', 'Administrator ID', null, 4, 'National ID or passport copy of the trust administrator.'],
    ['TRUST', 'authorization_letter', 'Authorization Letter', null, 5, 'Signed authorization letter from the trustees for the contact person.'],
    ['TRUST', 'legal_undertaking', 'Legal Undertaking', null, 6, 'Signed undertaking to comply with applicable laws and Hamilton Telecom policies.'],

    ['COOPERATIVE', 'certificate_of_registration', 'Certificate of Registration', null, 1, 'Certificate of Registration issued by the Registrar of Cooperative Societies.'],
    ['COOPERATIVE', 'directors_particulars', "Directors' Particulars", null, 2, 'A certified list of all directors/members of the cooperative society, including full names, national IDs, designations, and contact details.'],
    ['COOPERATIVE', 'proof_of_address', 'Proof of Address', null, 3, 'A recent utility bill, bank statement, or LC1 letter confirming the registered business address of the cooperative society.'],
    ['COOPERATIVE', 'tin_certificate', 'TIN Certificate', null, 4, 'Uganda Revenue Authority TIN certificate for the cooperative.'],
    ['COOPERATIVE', 'md_ceo_id', 'MD/CEO ID', null, 5, 'National ID or passport copy of the Managing Director / CEO.'],
    ['COOPERATIVE', 'authorization_letter', 'Authorization Letter', null, 6, 'Signed authorization letter from the cooperative board for the contact person.'],
    ['COOPERATIVE', 'legal_undertaking', 'Legal Undertaking', null, 7, 'Signed undertaking to comply with applicable laws and Hamilton Telecom policies.'],

    ['MDA_GOVERNMENT', 'authorization_letter_accounting_officer', 'Authorization Letter (signed by Accounting Officer)', null, 1, 'Official authorization letter signed by the Accounting Officer and stamped by the MDA.'],
    ['MDA_GOVERNMENT', 'accounting_officer_national_id', 'Accounting Officer National ID', null, 2, 'National ID copy of the Accounting Officer.'],

    ['POLITICAL_PARTY', 'certificate_of_registration', 'Certificate of Registration', null, 1, 'Certificate of Registration from the Electoral Commission.'],
    ['POLITICAL_PARTY', 'executive_council_particulars', 'Executive Council Particulars', null, 2, 'Certified particulars of the Executive Council members.'],
    ['POLITICAL_PARTY', 'president_chair_id', 'President/Chair ID', null, 3, 'National ID or passport copy of the President/Chairperson.'],
    ['POLITICAL_PARTY', 'proof_of_address', 'Proof of Address', null, 4, 'Official address confirmation such as utility bill, bank statement, or LC1 letter.'],
    ['POLITICAL_PARTY', 'authorization_letter', 'Authorization Letter', null, 5, 'Signed authorization letter from the party leadership for the contact person.'],
    ['POLITICAL_PARTY', 'legal_undertaking', 'Legal Undertaking', null, 6, 'Signed undertaking to comply with applicable laws and Hamilton Telecom policies.'],

    ['FOREIGN_MISSION', 'mofa_recommendation_letter', 'Ministry of Foreign Affairs Recommendation Letter', null, 1, 'Recommendation letter from the Ministry of Foreign Affairs confirming diplomatic status.'],

    ['REGIONAL_INTERNATIONAL_ORG', 'letterhead_authorization_letter', 'Official Letterhead Authorization Letter', null, 1, 'Authorization letter on official letterhead signed by an authorized representative.'],

    // Appended regardless of entity type — only required when the entity opts in as a
    // SIM card distributor (partnership_types includes SIM_DISTRIBUTOR).
    ['ANY', 'lc1_letter', 'LC1 Letter', 'SIM_DISTRIBUTOR', 90, 'Introduction/recommendation letter from the local LC1 authority confirming the business location.'],
    ['ANY', 'site_visit_report', 'Site Visit Report', 'SIM_DISTRIBUTOR', 91, 'Completed site visit report confirming physical verification of the business premises.'],
    ['ANY', 'trading_license', 'Trading License', 'SIM_DISTRIBUTOR', 92, 'Valid trading license for the business premises.'],
    ['ANY', 'tax_registration_certificate', 'Tax Registration Certificate', 'SIM_DISTRIBUTOR', 93, 'Local government tax registration certificate or equivalent.'],
  ];

  for (const [entityType, key, label, appliesTo, sort, description] of seed) {
    await query(
      `INSERT INTO document_checklist_rules (entity_type, document_key, document_label, description, applies_to_partnership, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (entity_type, document_key, applies_to_partnership) DO UPDATE SET
         description = EXCLUDED.description,
         document_label = EXCLUDED.document_label`,
      [entityType, key, label, description || null, appliesTo || '', sort]
    );
  }
}

async function ensureSearchFeeSettingsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS search_fee_settings (
      entity_type  VARCHAR(40) PRIMARY KEY,
      fee_amount   INTEGER,
      is_confirmed BOOLEAN NOT NULL DEFAULT true,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await query(`SELECT COUNT(*)::int AS c FROM search_fee_settings`);
  if (rows[0]?.c > 0) return;

  const seed: Array<[string, number | null, boolean]> = [
    ['NGO', 25000, true],
    ['COOPERATIVE', 65000, true],
    ['COMPANY', 27000, true],
    ['TRUST', null, false],
    ['MDA_GOVERNMENT', null, false],
    ['POLITICAL_PARTY', null, false],
    ['FOREIGN_MISSION', null, false],
    ['REGIONAL_INTERNATIONAL_ORG', null, false],
  ];
  for (const [entityType, fee, confirmed] of seed) {
    await query(
      `INSERT INTO search_fee_settings (entity_type, fee_amount, is_confirmed) VALUES ($1,$2,$3)
       ON CONFLICT (entity_type) DO NOTHING`,
      [entityType, fee, confirmed]
    );
  }
}

/** Platform-wide immutable audit trail for Company/Distributor/Agent status transitions (§5.5). */
async function ensureOnboardingAuditLogsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS onboarding_audit_logs (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_type VARCHAR(30) NOT NULL CHECK (entity_type IN ('COMPANY','DISTRIBUTOR','KYC_AGENT','MM_AGENT','MM_DISTRIBUTOR','MERCHANT')),
      entity_id   UUID NOT NULL,
      actor       VARCHAR(255),
      from_status VARCHAR(40),
      to_status   VARCHAR(40),
      reason      TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_onboarding_audit_entity ON onboarding_audit_logs(entity_type, entity_id)`);
  await query(`
    ALTER TABLE onboarding_audit_logs
    DROP CONSTRAINT IF EXISTS onboarding_audit_logs_entity_type_check;
    ALTER TABLE onboarding_audit_logs
    ADD CONSTRAINT onboarding_audit_logs_entity_type_check
    CHECK (entity_type IN ('COMPANY','DISTRIBUTOR','KYC_AGENT','MM_AGENT','MM_DISTRIBUTOR','MERCHANT'))
  `).catch(() => {});
}

type AuditEntityType = 'COMPANY' | 'DISTRIBUTOR' | 'KYC_AGENT' | 'MM_AGENT' | 'MM_DISTRIBUTOR' | 'MERCHANT';

export async function writeAuditLog(
  entityType: AuditEntityType,
  entityId: string,
  actor: string | null,
  fromStatus: string | null,
  toStatus: string | null,
  reason?: string | null
): Promise<void> {
  await query(
    `INSERT INTO onboarding_audit_logs (entity_type, entity_id, actor, from_status, to_status, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [entityType, entityId, actor, fromStatus, toStatus, reason || null]
  );
}

/**
 * Extend the existing `distributors` table with nullable company linkage columns.
 * Every pre-existing row keeps company_id = NULL; existing stock request/approval/
 * distribution code paths are completely unaffected (they never read these columns).
 */
async function ensureDistributorsExtensionColumns(): Promise<void> {
  await query(`
    ALTER TABLE IF EXISTS distributors
      ADD COLUMN IF NOT EXISTS company_id       UUID REFERENCES companies(id),
      ADD COLUMN IF NOT EXISTS distributor_code  VARCHAR(20)
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_distributors_distributor_code ON distributors(distributor_code) WHERE distributor_code IS NOT NULL`);

  // Cosmetic backfill only — generate DIST-XXXX for legacy rows that don't have one yet.
  // No company_id is fabricated; legacy rows keep company_id = NULL indefinitely.
  const { rows: missing } = await query(
    `SELECT id FROM distributors WHERE distributor_code IS NULL ORDER BY created_at ASC`
  );
  if (missing.length === 0) return;

  const { rows: maxRows } = await query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(distributor_code FROM 'DIST-(\\d+)') AS INTEGER)), 0) AS max_seq
       FROM distributors WHERE distributor_code ~ '^DIST-\\d+$'`
  );
  let seq = (maxRows[0]?.max_seq || 0) as number;

  for (const row of missing) {
    seq += 1;
    const code = `DIST-${String(seq).padStart(4, '0')}`;
    await query(`UPDATE distributors SET distributor_code = $1 WHERE id = $2`, [code, row.id]);
  }
}

async function ensureSuppliedDistributors(): Promise<void> {
  const organizations = [
    'LETICE INVESTMENTS LIMITED',
    'PLATINUM C.C&W LINKD LTD',
    'MAKERERE 1 PARISH BODA BODA RIDERS SACCO',
    'BODA BODA INDUSTRY (BBI) RETIREMENT',
    'KIREKA BODA BODA POLICE STAGE SACCO',
    'KAMPALA CENTRAL BUKESA BODA BODA SACCO',
    'KAMPALA TWEZIMBE WOMEN BODABODA SACCO',
    'KAJJANSI TOWN COUNCIL MULTI PURPOSE COOPERATIVE SOCIETY LTD',
    'CHAZAK INVESTMENTS LTD',
    'FIT-INSIGHTS LIMITED',
    'CREDIT TIMES FINANCIAL SERVICES LIMITED',
    'THIRDSPACE SOLUTIONS',
    'PAXTEL MOBILE (U) LIMITED',
    'BWAMBA COCOA CO-OPERATIVES SOCIETY LIMITED',
    'KINGDOM WISDOM CONSULTANCY CO LIMITED',
    'KUMALO TECHNOLOGIES COMPANY LIMITED',
    'NATIONAL UNION OF COFFEE AGRIBUSINESS AND FARM ENTERPRISE LIMITED (NUCAFE)',
    'MAZZI SYSTEMS LTD',
    'B2B GROWTH LTD',
    'CHRIST LIKE FAMILY COMPANY LIMITED',
    'CHANNEL PARTNERS LIMITED',
    'SEAMLESS EVENTS AND PR LIMITED',
  ];

  for (const name of organizations) {
    await transaction(async (client) => {
      const existing = await client.query(`SELECT id FROM distributors WHERE name = $1 LIMIT 1`, [name]);
      if (existing.rows[0]) return;

      const entityType = /SACCO|CO-OPERATIVE|COOPERATIVE/.test(name) ? 'COOPERATIVE' : 'COMPANY';
      const companyCode = await generateCompanyCode();
      const companyRes = await client.query(
        `INSERT INTO companies (
           company_code, entity_type, partnership_types, name, physical_address,
           contact_name, contact_phone, contact_email, contact_nin_passport, status, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'APPROVED',$10)
         RETURNING id`,
        [companyCode, entityType, ['SIM_DISTRIBUTOR'], name, 'NOT PROVIDED', 'NOT PROVIDED', 'NOT PROVIDED', 'not-provided@system.local', 'NOT PROVIDED', 'SYSTEM IMPORT']
      );
      const distributorCode = await generateDistributorCode();
      await client.query(
        `INSERT INTO distributors (name, region, type, email, phone, is_active, company_id, distributor_code, address)
         VALUES ($1,NULL,'DISTRIBUTOR',$2,$3,true,$4,$5,$6)`,
        [name, 'not-provided@system.local', 'NOT PROVIDED', companyRes.rows[0].id, distributorCode, 'NOT PROVIDED']
      );
    });
  }
}

/**
 * KYC SIM registration agents. Each agent MUST link to an existing distributor.
 * Additive table — does not affect any existing distributor/stock code paths.
 */
async function ensureKycAgentsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS kyc_agents (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_number      VARCHAR(100),
      agent_code         VARCHAR(20) UNIQUE,
      distributor_id     UUID NOT NULL REFERENCES distributors(id),
      name               VARCHAR(255) NOT NULL,
      surname            VARCHAR(255),
      given_names        VARCHAR(255),
      phone              VARCHAR(50) NOT NULL,
      email              VARCHAR(255),
      gender             VARCHAR(20),
      date_of_birth      DATE,
      district           VARCHAR(120),
      region             VARCHAR(120),
      gps_lat            NUMERIC(10,6),
      gps_lng            NUMERIC(10,6),
      reg_point_name     VARCHAR(255),
      reg_point_district VARCHAR(120),
      reg_point_lat      NUMERIC(10,6),
      reg_point_lng      NUMERIC(10,6),
      reg_point_notes    TEXT,
      declaration_agent_ack       BOOLEAN NOT NULL DEFAULT false,
      declaration_distributor_ack BOOLEAN NOT NULL DEFAULT false,
      status             VARCHAR(30) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN (
                           'SUBMITTED','UNDER_VERIFICATION','APPROVED','REJECTED'
                         )),
      reject_reason      TEXT,
      decided_by         VARCHAR(255),
      decided_at         TIMESTAMPTZ,
      created_by         VARCHAR(255),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Comprehensive ADD COLUMN IF NOT EXISTS — heals any pre-existing kyc_agents
  // table created before these columns were part of the schema.
  await query(`
    ALTER TABLE kyc_agents
      ADD COLUMN IF NOT EXISTS ticket_number      VARCHAR(100),
      ADD COLUMN IF NOT EXISTS surname             VARCHAR(255),
      ADD COLUMN IF NOT EXISTS given_names         VARCHAR(255),
      ADD COLUMN IF NOT EXISTS county              VARCHAR(120),
      ADD COLUMN IF NOT EXISTS subcounty           VARCHAR(120),
      ADD COLUMN IF NOT EXISTS parish              VARCHAR(120),
      ADD COLUMN IF NOT EXISTS village             VARCHAR(120),
      ADD COLUMN IF NOT EXISTS region              VARCHAR(120),
      ADD COLUMN IF NOT EXISTS gender              VARCHAR(20),
      ADD COLUMN IF NOT EXISTS date_of_birth       DATE,
      ADD COLUMN IF NOT EXISTS reg_point_name      VARCHAR(255),
      ADD COLUMN IF NOT EXISTS reg_point_district  VARCHAR(120),
      ADD COLUMN IF NOT EXISTS reg_point_notes     TEXT
  `);
  // Legacy tables created before the surname/given_names split still carry a NOT NULL
  // nin_passport column that current inserts never populate — heal it here.
  await query(`ALTER TABLE kyc_agents ALTER COLUMN nin_passport DROP NOT NULL`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_kyc_agents_status ON kyc_agents(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_kyc_agents_distributor ON kyc_agents(distributor_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_kyc_agents_ticket_number ON kyc_agents(ticket_number)`);
}

async function ensureKycAgentDocumentsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS kyc_agent_documents (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id       UUID NOT NULL REFERENCES kyc_agents(id) ON DELETE CASCADE,
      document_key   VARCHAR(80) NOT NULL,
      document_label VARCHAR(255) NOT NULL,
      required       BOOLEAN NOT NULL DEFAULT true,
      ticked         BOOLEAN NOT NULL DEFAULT false,
      ticked_by      VARCHAR(255),
      ticked_at      TIMESTAMPTZ,
      file_url       TEXT,
      file_name      VARCHAR(255),
      uploaded_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_id, document_key)
    )
  `);
}

/**
 * Seed the KYC_AGENT document checklist rules (idempotent, safe for existing DBs
 * where ensureDocumentChecklistRulesTable already returned early). Inserted only
 * when a given (entity_type, document_key) is absent.
 */
async function ensureKycAgentChecklistRules(): Promise<void> {
  const seed: Array<[string, string, number, string]> = [
    [
      'national_id_front',
      'National ID (Front)',
      1,
      'Clear photo/scan of the front side of the agent\'s national identity card.',
    ],
    [
      'national_id_back',
      'National ID (Back)',
      2,
      'Clear photo/scan of the back side of the agent\'s national identity card.',
    ],
  ];

  for (const [key, label, sort, description] of seed) {
    const { rows } = await query(
      `SELECT 1 FROM document_checklist_rules WHERE entity_type = 'KYC_AGENT' AND document_key = $1 LIMIT 1`,
      [key]
    );
    if (rows.length > 0) continue;
    await query(
      `INSERT INTO document_checklist_rules (entity_type, document_key, document_label, description, sort_order)
       VALUES ('KYC_AGENT', $1, $2, $3, $4)`,
      [key, label, description, sort]
    );
  }
}

/**
 * Mobile Money agents. Each agent MUST link to an existing distributor.
 * Distinct from KYC SIM agents (kyc_agents) — separate table so a distributor's
 * SIM registration agents and Mobile Money agents are tracked independently.
 */
async function ensureMmAgentsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS mm_agents (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_code           VARCHAR(20) UNIQUE,
      distributor_id       UUID NOT NULL REFERENCES distributors(id),
      name                 VARCHAR(255) NOT NULL,
      nin_passport         VARCHAR(100) NOT NULL,
      phone                VARCHAR(50) NOT NULL,
      email                VARCHAR(255),
      gender               VARCHAR(20),
      date_of_birth        DATE,
      physical_address     TEXT,
      district             VARCHAR(120),
      region               VARCHAR(120),
      gps_lat              NUMERIC(10,6),
      gps_lng              NUMERIC(10,6),
      mobile_money_provider VARCHAR(60),
      wallet_till_number   VARCHAR(60),
      reg_point_name       VARCHAR(255),
      reg_point_district   VARCHAR(120),
      reg_point_lat        NUMERIC(10,6),
      reg_point_lng        NUMERIC(10,6),
      reg_point_notes      TEXT,
      declaration_agent_ack       BOOLEAN NOT NULL DEFAULT false,
      declaration_distributor_ack BOOLEAN NOT NULL DEFAULT false,
      status               VARCHAR(30) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN (
                             'SUBMITTED','UNDER_VERIFICATION','APPROVED','REJECTED'
                           )),
      reject_reason        TEXT,
      decided_by           VARCHAR(255),
      decided_at           TIMESTAMPTZ,
      created_by           VARCHAR(255),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE mm_agents ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(100), ADD COLUMN IF NOT EXISTS first_name VARCHAR(255), ADD COLUMN IF NOT EXISTS last_name VARCHAR(255), ADD COLUMN IF NOT EXISTS tin VARCHAR(100), ADD COLUMN IF NOT EXISTS subcounty VARCHAR(120), ADD COLUMN IF NOT EXISTS parish VARCHAR(120), ADD COLUMN IF NOT EXISTS village VARCHAR(120), ADD COLUMN IF NOT EXISTS outlet_name VARCHAR(255), ADD COLUMN IF NOT EXISTS lc1 VARCHAR(120), ADD COLUMN IF NOT EXISTS place_of_business VARCHAR(255), ADD COLUMN IF NOT EXISTS agent_services TEXT[]`);
  await query(`ALTER TABLE mm_agents ALTER COLUMN tin DROP NOT NULL`);
  await query(`ALTER TABLE mm_agents ALTER COLUMN nin_passport DROP NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_mm_agents_status ON mm_agents(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_mm_agents_distributor ON mm_agents(distributor_id)`);
}

async function ensureMmAgentDocumentsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS mm_agent_documents (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id       UUID NOT NULL REFERENCES mm_agents(id) ON DELETE CASCADE,
      document_key   VARCHAR(80) NOT NULL,
      document_label VARCHAR(255) NOT NULL,
      required       BOOLEAN NOT NULL DEFAULT true,
      ticked         BOOLEAN NOT NULL DEFAULT false,
      ticked_by      VARCHAR(255),
      ticked_at      TIMESTAMPTZ,
      file_url       TEXT,
      file_name      VARCHAR(255),
      uploaded_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_id, document_key)
    )
  `);
}

/**
 * Seed the MM_AGENT document checklist rules (idempotent, safe for existing DBs
 * where ensureDocumentChecklistRulesTable already returned early). Inserted only
 * when a given (entity_type, document_key) is absent.
 */
async function ensureMmAgentChecklistRules(): Promise<void> {
  const seed: Array<[string, string, number, string]> = [
    [
      'national_id',
      'National ID',
      1,
      'Clear photo/scan of the agent\'s valid national identity card (front and back).',
    ],
    [
      'business_premises',
      'Business Premises Document',
      2,
      'Document confirming the agent\'s business premises, e.g. trading license, lease agreement, or LC1 letter.',
    ],
  ];

  for (const [key, label, sort, description] of seed) {
    const { rows } = await query(
      `SELECT 1 FROM document_checklist_rules WHERE entity_type = 'MM_AGENT' AND document_key = $1 LIMIT 1`,
      [key]
    );
    if (rows.length > 0) continue;
    await query(
      `INSERT INTO document_checklist_rules (entity_type, document_key, document_label, description, sort_order)
       VALUES ('MM_AGENT', $1, $2, $3, $4)`,
      [key, label, description, sort]
    );
  }
}

/** Generate the next sequential company_code, e.g. CMP-0001. */
export async function generateCompanyCode(): Promise<string> {
  const { rows } = await query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(company_code FROM 'CMP-(\\d+)') AS INTEGER)), 0) AS max_seq
       FROM companies WHERE company_code ~ '^CMP-\\d+$'`
  );
  const next = ((rows[0]?.max_seq || 0) as number) + 1;
  return `CMP-${String(next).padStart(4, '0')}`;
}

/** Generate the next sequential distributor_code, e.g. DIST-0001. */
export async function generateDistributorCode(): Promise<string> {
  const { rows } = await query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(distributor_code FROM 'DIST-(\\d+)') AS INTEGER)), 0) AS max_seq
       FROM distributors WHERE distributor_code ~ '^DIST-\\d+$'`
  );
  const next = ((rows[0]?.max_seq || 0) as number) + 1;
  return `DIST-${String(next).padStart(4, '0')}`;
}

/** Generate the next sequential agent_code, e.g. AGT-0001. */
export async function generateAgentCode(): Promise<string> {
  const { rows } = await query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(agent_code FROM 'AGT-(\\d+)') AS INTEGER)), 0) AS max_seq
       FROM kyc_agents WHERE agent_code ~ '^AGT-\\d+$'`
  );
  const next = ((rows[0]?.max_seq || 0) as number) + 1;
  return `AGT-${String(next).padStart(4, '0')}`;
}

/** Generate the next sequential Mobile Money agent code, e.g. MMA-0001. */
export async function generateMmAgentCode(): Promise<string> {
  const { rows } = await query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(agent_code FROM 'MMA-(\\d+)') AS INTEGER)), 0) AS max_seq
       FROM mm_agents WHERE agent_code ~ '^MMA-\\d+$'`
  );
  const next = ((rows[0]?.max_seq || 0) as number) + 1;
  return `MMA-${String(next).padStart(4, '0')}`;
}

// ==================== PHASE 2.2: SERVICE OPERATIONS ====================

export type EntityType =
  | 'COMPANY' | 'NGO' | 'TRUST' | 'COOPERATIVE' | 'MDA_GOVERNMENT'
  | 'POLITICAL_PARTY' | 'FOREIGN_MISSION' | 'REGIONAL_INTERNATIONAL_ORG';

export type PartnershipType = 'SIM_DISTRIBUTOR' | 'MOBILE_MONEY_DISTRIBUTOR' | 'ORDINARY';

export type OnboardingStatus =
  | 'SUBMITTED' | 'UNDER_VERIFICATION' | 'SITE_VISIT_PENDING'
  | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

export interface CompanyDocumentInput {
  document_key: string;
  ticked?: boolean;
  file_url?: string;
  file_name?: string;
}

export interface CompanySubmissionInput {
  ticket_number: string;
  entity_type: EntityType;
  partnership_types: PartnershipType[];
  name: string;
  business_name?: string;
  tin?: string;
  registration_date?: string;
  website?: string;
  physical_address: string;
  business_reg_number?: string;
  contact_name: string;
  contact_designation?: string;
  contact_phone: string;
  contact_email: string;
  contact_nin_passport: string;
  company_email?: string;
  company_phone?: string;
  /** Only relevant/required when partnership_types includes 'SIM_DISTRIBUTOR'. */
  distributor_name?: string;
  distributor_contact?: string;
  search_fee_amount?: number | null;
  search_fee_status?: 'PENDING' | 'PAID' | 'WAIVED';
  documents?: CompanyDocumentInput[];
  created_by?: string;
}

/** Retrieve the checklist for a given entity type and requested partnership types. */
export async function getDocumentChecklistForCompany(
  entityType: EntityType,
  partnershipTypes: PartnershipType[] = []
): Promise<Array<{ document_key: string; document_label: string; description: string | null; required: boolean }>> {
  const rules = await query(
    `SELECT document_key, document_label, description, sort_order, applies_to_partnership
       FROM document_checklist_rules
       WHERE entity_type = $1 OR entity_type = 'ANY'
       ORDER BY sort_order ASC`,
    [entityType]
  );

  const result = [];
  for (const r of rules.rows) {
    const appliesPartnership = !r.applies_to_partnership || partnershipTypes.includes(r.applies_to_partnership);
    if (!appliesPartnership) continue;
    result.push({
      document_key: r.document_key,
      document_label: r.document_label,
      description: r.description,
      required: true,
    });
  }
  return result;
}

/** Get search fee config for an entity type. */
export async function getSearchFeeSetting(entityType: EntityType): Promise<{ fee_amount: number | null; is_confirmed: boolean }> {
  const { rows } = await query(
    `SELECT fee_amount, is_confirmed FROM search_fee_settings WHERE entity_type = $1`,
    [entityType]
  );
  return rows[0] || { fee_amount: null, is_confirmed: false };
}

/** Submit a new company onboarding request. Creates company, documents, and approval seats. */
export async function submitCompany(input: CompanySubmissionInput): Promise<any> {
  return transaction(async (client) => {
    await assertTicketNumberAvailable(client, input.ticket_number);
    const companyCode = await generateCompanyCode();
    const feeSetting = await getSearchFeeSetting(input.entity_type);
    const feeAmount = feeSetting.is_confirmed ? feeSetting.fee_amount : (input.search_fee_amount ?? null);

    const companyRes = await client.query(
      `INSERT INTO companies (
         ticket_number, company_code, entity_type, partnership_types, name, business_name, tin, registration_date,
         website, physical_address, business_reg_number, contact_name, contact_designation,
         contact_phone, contact_email, contact_nin_passport, company_email, company_phone,
         distributor_name, distributor_contact, status,
         search_fee_amount, search_fee_status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'SUBMITTED',$21,$22,$23)
       RETURNING *`,
      [
        input.ticket_number.trim(),
        companyCode,
        input.entity_type,
        input.partnership_types,
        input.name,
        input.business_name || null,
        input.tin || null,
        input.registration_date || null,
        input.website || null,
        input.physical_address,
        input.business_reg_number || null,
        input.contact_name,
        input.contact_designation || null,
        input.contact_phone,
        input.contact_email,
        input.contact_nin_passport,
        input.company_email || null,
        input.company_phone || null,
        input.partnership_types?.includes('SIM_DISTRIBUTOR') ? (input.distributor_name || null) : null,
        input.partnership_types?.includes('SIM_DISTRIBUTOR') ? (input.distributor_contact || null) : null,
        feeAmount,
        input.search_fee_status || 'PENDING',
        input.created_by || null,
      ]
    );
    const company = companyRes.rows[0];

    // Generate document checklist rows
    const checklist = await getDocumentChecklistForCompany(input.entity_type, input.partnership_types);
    const provided = new Map<string, CompanyDocumentInput>((input.documents || []).map(d => [d.document_key, d]));

    for (const item of checklist) {
      const doc = provided.get(item.document_key);
      await client.query(
        `INSERT INTO company_documents (company_id, document_key, document_label, required, ticked, file_url, file_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [company.id, item.document_key, item.document_label, true, doc?.ticked || false, doc?.file_url || null, doc?.file_name || null]
      );
    }

    // Create 4-seat approval chain
    const seats = [
      { role: 'HEAD_OF_COMMERCIAL', order: 1 },
      { role: 'MOBILE_MONEY_ACCOUNTANT', order: 2 },
      { role: 'HEAD_OF_TECHNICAL', order: 3 },
      { role: 'CEO', order: 4 },
    ];

    const isMMDistributor = input.partnership_types.includes('MOBILE_MONEY_DISTRIBUTOR');
    for (const seat of seats) {
      const status = (seat.role === 'MOBILE_MONEY_ACCOUNTANT' && !isMMDistributor) ? 'SKIPPED' : 'PENDING';
      await client.query(
        `INSERT INTO company_approvals (company_id, seat_order, seat_role, status)
         VALUES ($1,$2,$3,$4)`,
        [company.id, seat.order, seat.role, status]
      );
    }

    await writeAuditLog('COMPANY', company.id, input.created_by || null, null, 'SUBMITTED');

    return company;
  });
}

/** List company requests with optional filters and pagination. */
export async function getCompanies(options: {
  status?: string;
  entityType?: string;
  partnershipType?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: any[]; total: number }> {
  const { status, entityType, partnershipType, search, limit = 50, offset = 0 } = options;
  const conds: string[] = [];
  const params: any[] = [];
  let p = 1;

  if (status) {
    conds.push(`c.status = $${p++}`);
    params.push(status);
  }
  if (entityType) {
    conds.push(`c.entity_type = $${p++}`);
    params.push(entityType);
  }
  if (partnershipType) {
    conds.push(`$${p++} = ANY(c.partnership_types)`);
    params.push(partnershipType);
  }
  if (search) {
    conds.push(`(
      c.name ILIKE $${p}
      OR c.company_code ILIKE $${p}
      OR c.contact_name ILIKE $${p}
      OR c.contact_email ILIKE $${p}
    )`);
    params.push(`%${search}%`);
    p++;
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const totalRes = await query(`SELECT COUNT(*)::int AS total FROM companies c ${where}`, [...params]);
  const total = totalRes.rows[0].total;

  const dataRes = await query(
    `SELECT c.*,
            (SELECT COUNT(*)::int FROM company_documents cd WHERE cd.company_id = c.id AND cd.required = true AND cd.ticked = false) AS outstanding_documents
       FROM companies c
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
    [...params, limit, offset]
  );
  return { rows: dataRes.rows, total };
}

/** Get full company detail including documents, approvals, and audit trail. */
export async function getCompanyById(companyId: string): Promise<any> {
  const companyRes = await query(`SELECT * FROM companies WHERE id = $1`, [companyId]);
  if (!companyRes.rows[0]) return null;

  const [documents, approvals, audit] = await Promise.all([
    query(`SELECT * FROM company_documents WHERE company_id = $1 ORDER BY created_at`, [companyId]),
    query(`SELECT * FROM company_approvals WHERE company_id = $1 ORDER BY seat_order`, [companyId]),
    query(`SELECT * FROM onboarding_audit_logs WHERE entity_type = 'COMPANY' AND entity_id = $1 ORDER BY created_at DESC`, [companyId]),
  ]);

  return {
    ...companyRes.rows[0],
    documents: documents.rows,
    approvals: approvals.rows,
    audit: audit.rows,
  };
}

/** Update a document tick/file for a company. */
export async function updateCompanyDocument(
  companyId: string,
  documentKey: string,
  updates: { ticked?: boolean; file_url?: string; file_name?: string; ticked_by?: string },
  actor?: string
): Promise<any> {
  const { ticked, file_url, file_name, ticked_by } = updates;
  const setClauses: string[] = [];
  const params: any[] = [];
  let p = 1;

  if (ticked !== undefined) {
    setClauses.push(`ticked = $${p++}`);
    params.push(ticked);
  }
  if (file_url !== undefined) {
    setClauses.push(`file_url = $${p++}`);
    params.push(file_url);
  }
  if (file_name !== undefined) {
    setClauses.push(`file_name = $${p++}`);
    params.push(file_name);
  }
  if (ticked_by !== undefined) {
    setClauses.push(`ticked_by = $${p++}, ticked_at = NOW()`);
    params.push(ticked_by);
  }

  if (setClauses.length === 0) return null;

  params.push(companyId, documentKey);
  const res = await query(
    `UPDATE company_documents SET ${setClauses.join(', ')}
     WHERE company_id = $${p++} AND document_key = $${p++}
     RETURNING *`,
    params
  );

  if (res.rows[0] && actor) {
    await writeAuditLog('COMPANY', companyId, actor, null, null, `Updated document ${documentKey}`);
  }
  return res.rows[0];
}

/** Approve a single approval seat for a company. If all seats are approved, finalize. */
export async function approveCompanySeat(
  companyId: string,
  seatOrder: number,
  approverEmail: string,
  actorIdentifier: string
): Promise<any> {
  return transaction(async (client) => {
    const companyRes = await client.query(`SELECT * FROM companies WHERE id = $1 FOR UPDATE`, [companyId]);
    const company = companyRes.rows[0];
    if (!company) throw new Error('Company not found');
    if (company.status !== 'SUBMITTED' && company.status !== 'PENDING_APPROVAL') {
      throw new Error(`Company is in ${company.status} status and cannot be approved`);
    }

    // Mark seat as approved
    const seatRes = await client.query(
      `UPDATE company_approvals
       SET status = 'APPROVED', decided_by = $3, decided_at = NOW()
       WHERE company_id = $1 AND seat_order = $2 AND status = 'PENDING'
       RETURNING *`,
      [companyId, seatOrder, approverEmail]
    );
    if (!seatRes.rows[0]) throw new Error('Approval seat not found or already decided');

    await writeAuditLog('COMPANY', companyId, actorIdentifier, company.status, 'PENDING_APPROVAL', `Seat ${seatOrder} approved by ${approverEmail}`);

    // Advance company status to PENDING_APPROVAL after first approval if still SUBMITTED
    if (company.status === 'SUBMITTED') {
      await client.query(
        `UPDATE companies SET status = 'PENDING_APPROVAL', updated_at = NOW() WHERE id = $1`,
        [companyId]
      );
    }

    // Check if all non-skipped seats are approved
    const pendingOrSkipped = await client.query(
      `SELECT status FROM company_approvals WHERE company_id = $1`,
      [companyId]
    );
    const allApproved = pendingOrSkipped.rows.every((r: any) => r.status === 'APPROVED' || r.status === 'SKIPPED');

    if (allApproved) {
      return finalizeCompanyApproval(client, company, actorIdentifier);
    }

    return getCompanyById(companyId);
  });
}

/** Reject a company at any approval seat, with a required reason. */
export async function rejectCompany(
  companyId: string,
  seatOrder: number,
  approverEmail: string,
  reason: string,
  actorIdentifier: string
): Promise<any> {
  return transaction(async (client) => {
    const companyRes = await client.query(`SELECT * FROM companies WHERE id = $1 FOR UPDATE`, [companyId]);
    const company = companyRes.rows[0];
    if (!company) throw new Error('Company not found');
    if (!reason?.trim()) throw new Error('Rejection reason is required');

    await client.query(
      `UPDATE company_approvals
       SET status = 'REJECTED', decided_by = $3, decided_at = NOW(), reason = $4
       WHERE company_id = $1 AND seat_order = $2`,
      [companyId, seatOrder, approverEmail, reason.trim()]
    );

    await client.query(
      `UPDATE companies SET status = 'REJECTED', updated_at = NOW() WHERE id = $1`,
      [companyId]
    );

    await writeAuditLog('COMPANY', companyId, actorIdentifier, company.status, 'REJECTED', reason.trim());

    return getCompanyById(companyId);
  });
}

/** Finalize an approved company: create distributor if SIM_DISTRIBUTOR, set status to APPROVED. */
async function finalizeCompanyApproval(client: PoolClient, company: any, actorIdentifier: string): Promise<any> {
  const companyId = company.id;
  const partnershipTypes: PartnershipType[] = company.partnership_types || [];

  await client.query(
    `UPDATE companies SET status = 'APPROVED', updated_at = NOW() WHERE id = $1`,
    [companyId]
  );

  let distributor: any = null;
  if (partnershipTypes.includes('SIM_DISTRIBUTOR')) {
    const distributorCode = await generateDistributorCode();
    const distRes = await client.query(
      `INSERT INTO distributors (
         name, region, type, email, phone, is_active, company_id, distributor_code, address
       ) VALUES ($1,$2,'DISTRIBUTOR',$3,$4,true,$5,$6,$7)
       RETURNING id, distributor_code`,
      [
        company.name,
        company.physical_address || null,
        company.contact_email,
        company.contact_phone,
        companyId,
        distributorCode,
        company.physical_address,
      ]
    );
    distributor = distRes.rows[0];

    await writeAuditLog('DISTRIBUTOR', distributor.id, actorIdentifier, null, 'APPROVED', `Created from company ${company.company_code}`);
  }

  await writeAuditLog('COMPANY', companyId, actorIdentifier, 'PENDING_APPROVAL', 'APPROVED', distributor ? `Distributor ${distributor.distributor_code} created` : undefined);

  return getCompanyById(companyId);
}

async function assertTicketNumberAvailable(client: PoolClient, ticketNumber: string): Promise<void> {
  const normalized = ticketNumber.trim();
  if (!normalized) throw new Error('Ticket number is required');
  const existing = await client.query(
    `SELECT 1 FROM kyc_agents WHERE LOWER(ticket_number) = LOWER($1)
     UNION ALL
     SELECT 1 FROM mm_agents WHERE LOWER(ticket_number) = LOWER($1)
     UNION ALL
     SELECT 1 FROM companies WHERE LOWER(ticket_number) = LOWER($1)
     UNION ALL
     SELECT 1 FROM mm_distributors WHERE LOWER(ticket_number) = LOWER($1)
     UNION ALL
     SELECT 1 FROM merchants WHERE LOWER(ticket_number) = LOWER($1)
     UNION ALL
     SELECT 1 FROM distributor_sim_requests WHERE LOWER(ticket_number) = LOWER($1)
     LIMIT 1`,
    [normalized]
  );
  if (existing.rows.length) throw new Error('This ticket number has already been used for an onboarding request');
}

/** Public helper — validates a ticket number is non-empty and not already used by
 *  any onboarding/request type (KYC agent, MM agent, Company, or Distributor SIM request). */
export async function assertTicketNumberIsUnused(ticketNumber: string): Promise<void> {
  return transaction(async (client) => assertTicketNumberAvailable(client, ticketNumber));
}

// ==================== PHASE 3: KYC SIM AGENT ONBOARDING ====================

export interface KycAgentDocumentInput {
  document_key: string;
  ticked?: boolean;
  file_url?: string;
  file_name?: string;
}

export interface KycAgentSubmissionInput {
  ticket_number: string;
  distributor_id: string;
  surname: string;
  given_names: string;
  phone: string;
  email?: string;
  gender?: string;
  date_of_birth?: string;
  district?: string;
  county?: string;
  subcounty?: string;
  parish?: string;
  village?: string;
  region?: string;
  gps_lat?: number | null;
  gps_lng?: number | null;
  reg_point_name?: string;
  reg_point_district?: string;
  reg_point_lat?: number | null;
  reg_point_lng?: number | null;
  reg_point_notes?: string;
  declaration_agent_ack?: boolean;
  declaration_distributor_ack?: boolean;
  documents?: KycAgentDocumentInput[];
  created_by?: string;
}

/** Retrieve the KYC_AGENT document checklist (DB-driven, editable without deploy). */
export async function getKycAgentChecklist(): Promise<
  Array<{ document_key: string; document_label: string; description: string | null; required: boolean }>
> {
  const { rows } = await query(
    `SELECT document_key, document_label, description
       FROM document_checklist_rules
       WHERE entity_type = 'KYC_AGENT'
       ORDER BY sort_order ASC`
  );
  return rows.map((r: any) => ({
    document_key: r.document_key,
    document_label: r.document_label,
    description: r.description,
    required: true,
  }));
}

/** Submit a new KYC SIM agent. Creates the agent record + document checklist rows. */
export async function submitKycAgent(input: KycAgentSubmissionInput): Promise<any> {
  return transaction(async (client) => {
    if (!input.distributor_id) throw new Error('distributor_id is required');
    const distRes = await client.query(`SELECT id FROM distributors WHERE id = $1`, [input.distributor_id]);
    if (!distRes.rows[0]) throw new Error('Selected distributor not found');

    await assertTicketNumberAvailable(client, input.ticket_number);
    const agentCode = await generateAgentCode();

    const agentRes = await client.query(
      `INSERT INTO kyc_agents (
         ticket_number, agent_code, distributor_id, name, surname, given_names, phone, email, gender, date_of_birth,
         district, county, subcounty, parish, village, gps_lat, gps_lng,
         reg_point_name, reg_point_district, reg_point_lat, reg_point_lng, reg_point_notes,
         declaration_agent_ack, declaration_distributor_ack, status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'SUBMITTED',$25)
       RETURNING *`,
      [
        input.ticket_number,
        agentCode,
        input.distributor_id,
        `${input.surname} ${input.given_names}`.trim(),
        input.surname,
        input.given_names,
        input.phone,
        input.email || null,
        input.gender || null,
        input.date_of_birth || null,
        input.district || null,
        input.county || null,
        input.subcounty || null,
        input.parish || null,
        input.village || null,
        input.gps_lat ?? null,
        input.gps_lng ?? null,
        input.reg_point_name || null,
        input.reg_point_district || null,
        input.reg_point_lat ?? null,
        input.reg_point_lng ?? null,
        input.reg_point_notes || null,
        input.declaration_agent_ack || false,
        input.declaration_distributor_ack || false,
        input.created_by || null,
      ]
    );
    const agent = agentRes.rows[0];

    // KYC agent onboarding no longer collects documents via the frontend wizard;
    // checklist rows are retained for historical/reporting purposes but marked as
    // not required and pre-completed so outstanding_documents is always 0.
    const checklist = await getKycAgentChecklist();
    const provided = new Map<string, KycAgentDocumentInput>((input.documents || []).map((d) => [d.document_key, d]));

    for (const item of checklist) {
      const doc = provided.get(item.document_key);
      await client.query(
        `INSERT INTO kyc_agent_documents (agent_id, document_key, document_label, required, ticked, file_url, file_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [agent.id, item.document_key, item.document_label, false, doc?.ticked ?? true, doc?.file_url || null, doc?.file_name || null]
      );
    }

    await writeAuditLog('KYC_AGENT', agent.id, input.created_by || null, null, 'SUBMITTED');

    return agent;
  });
}

/** List KYC agents with optional filters and pagination. */
export async function getKycAgents(options: {
  status?: string;
  distributorId?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: any[]; total: number }> {
  const { status, distributorId, search, limit = 50, offset = 0 } = options;
  const conds: string[] = [];
  const params: any[] = [];
  let p = 1;

  if (status) {
    conds.push(`a.status = $${p++}`);
    params.push(status);
  }
  if (distributorId) {
    conds.push(`a.distributor_id = $${p++}`);
    params.push(distributorId);
  }
  if (search) {
    conds.push(`(
      a.name ILIKE $${p}
      OR a.agent_code ILIKE $${p}
      OR a.phone ILIKE $${p}
      OR a.nin_passport ILIKE $${p}
    )`);
    params.push(`%${search}%`);
    p++;
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const totalRes = await query(`SELECT COUNT(*)::int AS total FROM kyc_agents a ${where}`, [...params]);
  const total = totalRes.rows[0].total;

  const dataRes = await query(
    `SELECT a.*,
            d.name AS distributor_name,
            d.distributor_code AS distributor_code,
            (SELECT COUNT(*)::int FROM kyc_agent_documents ad WHERE ad.agent_id = a.id AND ad.required = true AND ad.ticked = false) AS outstanding_documents
       FROM kyc_agents a
       LEFT JOIN distributors d ON d.id = a.distributor_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
    [...params, limit, offset]
  );
  return { rows: dataRes.rows, total };
}

/** Get full KYC agent detail including documents and audit trail. */
export async function getKycAgentById(agentId: string): Promise<any> {
  const agentRes = await query(
    `SELECT a.*, d.name AS distributor_name, d.distributor_code AS distributor_code
       FROM kyc_agents a
       LEFT JOIN distributors d ON d.id = a.distributor_id
      WHERE a.id = $1`,
    [agentId]
  );
  if (!agentRes.rows[0]) return null;

  const [documents, audit] = await Promise.all([
    query(`SELECT * FROM kyc_agent_documents WHERE agent_id = $1 ORDER BY created_at`, [agentId]),
    query(`SELECT * FROM onboarding_audit_logs WHERE entity_type = 'KYC_AGENT' AND entity_id = $1 ORDER BY created_at DESC`, [agentId]),
  ]);

  return {
    ...agentRes.rows[0],
    documents: documents.rows,
    audit: audit.rows,
  };
}

/** Update a document tick/file for a KYC agent. */
export async function updateKycAgentDocument(
  agentId: string,
  documentKey: string,
  updates: { ticked?: boolean; file_url?: string; file_name?: string; ticked_by?: string },
  actor?: string
): Promise<any> {
  const { ticked, file_url, file_name, ticked_by } = updates;
  const setClauses: string[] = [];
  const params: any[] = [];
  let p = 1;

  if (ticked !== undefined) {
    setClauses.push(`ticked = $${p++}`);
    params.push(ticked);
  }
  if (file_url !== undefined) {
    setClauses.push(`file_url = $${p++}`);
    params.push(file_url);
  }
  if (file_name !== undefined) {
    setClauses.push(`file_name = $${p++}`);
    params.push(file_name);
  }
  if (ticked_by !== undefined) {
    setClauses.push(`ticked_by = $${p++}, ticked_at = NOW()`);
    params.push(ticked_by);
  }

  if (setClauses.length === 0) return null;

  params.push(agentId, documentKey);
  const res = await query(
    `UPDATE kyc_agent_documents SET ${setClauses.join(', ')}
     WHERE agent_id = $${p++} AND document_key = $${p++}
     RETURNING *`,
    params
  );

  if (res.rows[0] && actor) {
    await writeAuditLog('KYC_AGENT', agentId, actor, null, null, `Updated document ${documentKey}`);
  }
  return res.rows[0];
}

/** Approve a KYC agent (single Super Admin sign-off). */
export async function approveKycAgent(agentId: string, actorIdentifier: string): Promise<any> {
  await transaction(async (client) => {
    const agentRes = await client.query(`SELECT * FROM kyc_agents WHERE id = $1 FOR UPDATE`, [agentId]);
    const agent = agentRes.rows[0];
    if (!agent) throw new Error('KYC agent not found');
    if (agent.status === 'APPROVED') throw new Error('KYC agent is already approved');
    if (agent.status === 'REJECTED') throw new Error('KYC agent has been rejected and cannot be approved');

    await client.query(
      `UPDATE kyc_agents SET status = 'APPROVED', decided_by = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [agentId, actorIdentifier]
    );

    await writeAuditLog('KYC_AGENT', agentId, actorIdentifier, agent.status, 'APPROVED');
  });
  // Re-fetch after commit — reading via the shared pool inside the transaction
  // callback would see stale pre-commit data since it uses a different connection.
  return getKycAgentById(agentId);
}

/** Reject a KYC agent with a required reason. */
export async function rejectKycAgent(agentId: string, reason: string, actorIdentifier: string): Promise<any> {
  await transaction(async (client) => {
    const agentRes = await client.query(`SELECT * FROM kyc_agents WHERE id = $1 FOR UPDATE`, [agentId]);
    const agent = agentRes.rows[0];
    if (!agent) throw new Error('KYC agent not found');
    if (!reason?.trim()) throw new Error('Rejection reason is required');

    await client.query(
      `UPDATE kyc_agents SET status = 'REJECTED', reject_reason = $2, decided_by = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [agentId, reason.trim(), actorIdentifier]
    );

    await writeAuditLog('KYC_AGENT', agentId, actorIdentifier, agent.status, 'REJECTED', reason.trim());
  });
  const rejected = await getKycAgentById(agentId);
  const recipient = rejected?.email || rejected?.created_by;
  if (recipient) {
    void emailService.sendRawEmail([recipient], 'KYC agent request rejected', `<p>Your KYC agent request has been rejected.</p><p><strong>Reason:</strong> ${reason.trim()}</p>`, `Your KYC agent request has been rejected. Reason: ${reason.trim()}`);
  }
  return rejected;
}

// ==================== PHASE 3B: MOBILE MONEY AGENT ONBOARDING ====================
// Distinct from KYC SIM agents above — Mobile Money agents represent a
// separate agent category (mobile_money_provider + wallet_till_number) even
// though the intake shape closely mirrors the KYC agent flow.

export interface MmAgentDocumentInput {
  document_key: string;
  ticked?: boolean;
  file_url?: string;
  file_name?: string;
}

export interface MmAgentSubmissionInput {
  ticket_number: string;
  distributor_id: string;
  outlet_name: string;
  first_name: string;
  last_name: string;
  name?: string;
  phone: string;
  tin?: string;
  district: string;
  village: string;
  lc1?: string;
  place_of_business?: string;
  agent_services?: string[];
  reg_point_lat?: number | null;
  reg_point_lng?: number | null;
  declaration_agent_ack?: boolean;
  declaration_distributor_ack?: boolean;
  documents?: MmAgentDocumentInput[];
  created_by?: string;
}

/** Retrieve the MM_AGENT document checklist (DB-driven, editable without deploy). */
export async function getMmAgentChecklist(): Promise<
  Array<{ document_key: string; document_label: string; description: string | null; required: boolean }>
> {
  const { rows } = await query(
    `SELECT document_key, document_label, description
       FROM document_checklist_rules
       WHERE entity_type = 'MM_AGENT'
       ORDER BY sort_order ASC`
  );
  return rows.map((r: any) => ({
    document_key: r.document_key,
    document_label: r.document_label,
    description: r.description,
    required: true,
  }));
}

/** Submit a new Mobile Money agent. Creates the agent record + document checklist rows. */
export async function submitMmAgent(input: MmAgentSubmissionInput): Promise<any> {
  return transaction(async (client) => {
    if (!input.distributor_id) throw new Error('distributor_id is required');
    const distRes = await client.query(`SELECT id FROM distributors WHERE id = $1`, [input.distributor_id]);
    if (!distRes.rows[0]) throw new Error('Selected distributor not found');
    await assertTicketNumberAvailable(client, input.ticket_number);
    const agentCode = await generateMmAgentCode();

    const agentRes = await client.query(
      `INSERT INTO mm_agents (
         ticket_number, agent_code, distributor_id, outlet_name, first_name, last_name, name, phone, tin,
         district, village, lc1, place_of_business, agent_services, reg_point_lat, reg_point_lng, declaration_agent_ack,
         declaration_distributor_ack, status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'SUBMITTED',$19)
       RETURNING *`,
      [
        input.ticket_number,
        agentCode,
        input.distributor_id,
        input.outlet_name || null,
        input.first_name,
        input.last_name,
        input.name || `${input.first_name} ${input.last_name}`.trim(),
        input.phone,
        input.tin || null,
        input.district,
        input.village,
        input.lc1 || null,
        input.place_of_business || null,
        input.agent_services || [],
        input.reg_point_lat ?? null,
        input.reg_point_lng ?? null,
        input.declaration_agent_ack || false,
        input.declaration_distributor_ack || false,
        input.created_by || null,
      ]
    );
    const agent = agentRes.rows[0];

    const checklist = await getMmAgentChecklist();
    const provided = new Map<string, MmAgentDocumentInput>((input.documents || []).map((d) => [d.document_key, d]));

    for (const item of checklist) {
      const doc = provided.get(item.document_key);
      await client.query(
        `INSERT INTO mm_agent_documents (agent_id, document_key, document_label, required, ticked, file_url, file_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [agent.id, item.document_key, item.document_label, true, doc?.ticked || false, doc?.file_url || null, doc?.file_name || null]
      );
    }

    await writeAuditLog('MM_AGENT', agent.id, input.created_by || null, null, 'SUBMITTED');

    return agent;
  });
}

/** List Mobile Money agents with optional filters and pagination. */
export async function getMmAgents(options: {
  status?: string;
  distributorId?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: any[]; total: number }> {
  const { status, distributorId, search, limit = 50, offset = 0 } = options;
  const conds: string[] = [];
  const params: any[] = [];
  let p = 1;

  if (status) {
    conds.push(`a.status = $${p++}`);
    params.push(status);
  }
  if (distributorId) {
    conds.push(`a.distributor_id = $${p++}`);
    params.push(distributorId);
  }
  if (search) {
    conds.push(`(
      a.name ILIKE $${p}
      OR a.agent_code ILIKE $${p}
      OR a.phone ILIKE $${p}
      OR a.nin_passport ILIKE $${p}
      OR a.wallet_till_number ILIKE $${p}
    )`);
    params.push(`%${search}%`);
    p++;
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const totalRes = await query(`SELECT COUNT(*)::int AS total FROM mm_agents a ${where}`, [...params]);
  const total = totalRes.rows[0].total;

  const dataRes = await query(
    `SELECT a.*,
            d.name AS distributor_name,
            d.distributor_code AS distributor_code,
            (SELECT COUNT(*)::int FROM mm_agent_documents ad WHERE ad.agent_id = a.id AND ad.required = true AND ad.ticked = false) AS outstanding_documents
       FROM mm_agents a
       LEFT JOIN distributors d ON d.id = a.distributor_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
    [...params, limit, offset]
  );
  return { rows: dataRes.rows, total };
}

/** Get full Mobile Money agent detail including documents and audit trail. */
export async function getMmAgentById(agentId: string): Promise<any> {
  const agentRes = await query(
    `SELECT a.*, d.name AS distributor_name, d.distributor_code AS distributor_code
       FROM mm_agents a
       LEFT JOIN distributors d ON d.id = a.distributor_id
      WHERE a.id = $1`,
    [agentId]
  );
  if (!agentRes.rows[0]) return null;

  const [documents, audit] = await Promise.all([
    query(`SELECT * FROM mm_agent_documents WHERE agent_id = $1 ORDER BY created_at`, [agentId]),
    query(`SELECT * FROM onboarding_audit_logs WHERE entity_type = 'MM_AGENT' AND entity_id = $1 ORDER BY created_at DESC`, [agentId]),
  ]);

  return {
    ...agentRes.rows[0],
    documents: documents.rows,
    audit: audit.rows,
  };
}

/** Update a document tick/file for a Mobile Money agent. */
export async function updateMmAgentDocument(
  agentId: string,
  documentKey: string,
  updates: { ticked?: boolean; file_url?: string; file_name?: string; ticked_by?: string },
  actor?: string
): Promise<any> {
  const { ticked, file_url, file_name, ticked_by } = updates;
  const setClauses: string[] = [];
  const params: any[] = [];
  let p = 1;

  if (ticked !== undefined) {
    setClauses.push(`ticked = $${p++}`);
    params.push(ticked);
  }
  if (file_url !== undefined) {
    setClauses.push(`file_url = $${p++}`);
    params.push(file_url);
  }
  if (file_name !== undefined) {
    setClauses.push(`file_name = $${p++}`);
    params.push(file_name);
  }
  if (ticked_by !== undefined) {
    setClauses.push(`ticked_by = $${p++}, ticked_at = NOW()`);
    params.push(ticked_by);
  }

  if (setClauses.length === 0) return null;

  params.push(agentId, documentKey);
  const res = await query(
    `UPDATE mm_agent_documents SET ${setClauses.join(', ')}
     WHERE agent_id = $${p++} AND document_key = $${p++}
     RETURNING *`,
    params
  );

  if (res.rows[0] && actor) {
    await writeAuditLog('MM_AGENT', agentId, actor, null, null, `Updated document ${documentKey}`);
  }
  return res.rows[0];
}

/** Approve a Mobile Money agent (single Super Admin sign-off). */
export async function approveMmAgent(agentId: string, actorIdentifier: string): Promise<any> {
  await transaction(async (client) => {
    const agentRes = await client.query(`SELECT * FROM mm_agents WHERE id = $1 FOR UPDATE`, [agentId]);
    const agent = agentRes.rows[0];
    if (!agent) throw new Error('Mobile Money agent not found');
    if (agent.status === 'APPROVED') throw new Error('Mobile Money agent is already approved');
    if (agent.status === 'REJECTED') throw new Error('Mobile Money agent has been rejected and cannot be approved');

    await client.query(
      `UPDATE mm_agents SET status = 'APPROVED', decided_by = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [agentId, actorIdentifier]
    );

    await writeAuditLog('MM_AGENT', agentId, actorIdentifier, agent.status, 'APPROVED');
  });
  return getMmAgentById(agentId);
}

/** Reject a Mobile Money agent with a required reason. */
export async function rejectMmAgent(agentId: string, reason: string, actorIdentifier: string): Promise<any> {
  await transaction(async (client) => {
    const agentRes = await client.query(`SELECT * FROM mm_agents WHERE id = $1 FOR UPDATE`, [agentId]);
    const agent = agentRes.rows[0];
    if (!agent) throw new Error('Mobile Money agent not found');
    if (!reason?.trim()) throw new Error('Rejection reason is required');

    await client.query(
      `UPDATE mm_agents SET status = 'REJECTED', reject_reason = $2, decided_by = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [agentId, reason.trim(), actorIdentifier]
    );

    await writeAuditLog('MM_AGENT', agentId, actorIdentifier, agent.status, 'REJECTED', reason.trim());
  });
  const rejected = await getMmAgentById(agentId);
  if (rejected?.created_by) {
    void emailService.sendRawEmail([rejected.created_by], 'Mobile Money agent request rejected', `<p>Your Mobile Money agent request has been rejected.</p><p><strong>Reason:</strong> ${reason.trim()}</p>`, `Your Mobile Money agent request has been rejected. Reason: ${reason.trim()}`);
  }
  return rejected;
}

// ==================== PHASE 3C: MOBILE MONEY DISTRIBUTOR ONBOARDING ====================

export interface MmDistributorSubmissionInput {
  ticket_number: string;
  company_name: string;
  place_of_business: string;
  msisdn: string;
  village_location: string;
  lc1: string;
  district: string;
  gps_lat?: number | null;
  gps_lng?: number | null;
  services?: string[];
  terms_ack?: boolean;
  created_by?: string;
}

async function ensureMmDistributorsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS mm_distributors (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_number     VARCHAR(100),
      distributor_code  VARCHAR(20) UNIQUE,
      company_name      VARCHAR(255) NOT NULL,
      place_of_business VARCHAR(255) NOT NULL,
      village_location  VARCHAR(255),
      lc1               VARCHAR(120),
      district          VARCHAR(120),
      gps_lat           NUMERIC(10,6),
      gps_lng           NUMERIC(10,6),
      msisdn            VARCHAR(50) NOT NULL,
      services          TEXT[] NOT NULL DEFAULT '{}',
      terms_ack         BOOLEAN NOT NULL DEFAULT false,
      status            VARCHAR(30) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN (
                          'SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED'
                        )),
      reject_reason     TEXT,
      decided_by        VARCHAR(255),
      decided_at        TIMESTAMPTZ,
      created_by        VARCHAR(255),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_mm_distributors_status ON mm_distributors(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_mm_distributors_ticket_number ON mm_distributors(ticket_number)`);
}

export async function generateMmDistributorCode(): Promise<string> {
  const { rows } = await query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(distributor_code FROM 'MMD-(\\d+)') AS INTEGER)), 0) AS max_seq
       FROM mm_distributors WHERE distributor_code ~ '^MMD-\\d+$'`
  );
  const seq = (rows[0]?.max_seq || 0) + 1;
  return `MMD-${String(seq).padStart(4, '0')}`;
}

export async function submitMmDistributor(input: MmDistributorSubmissionInput): Promise<any> {
  return transaction(async (client) => {
    await assertTicketNumberAvailable(client, input.ticket_number);
    if (!input.company_name?.trim()) throw new Error('Company name is required');
    if (!input.place_of_business?.trim()) throw new Error('Place of business is required');
    if (!input.msisdn?.trim()) throw new Error('MSISDN is required');
    if (!input.terms_ack) throw new Error('You must agree to the terms and conditions');
    const distributorCode = await generateMmDistributorCode();
    const res = await client.query(
      `INSERT INTO mm_distributors (
         ticket_number, distributor_code, company_name, place_of_business, village_location, lc1, district,
         gps_lat, gps_lng, msisdn, services, terms_ack, status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'SUBMITTED',$13)
       RETURNING *`,
      [
        input.ticket_number,
        distributorCode,
        input.company_name.trim(),
        input.place_of_business.trim(),
        input.village_location || null,
        input.lc1 || null,
        input.district || null,
        input.gps_lat ?? null,
        input.gps_lng ?? null,
        input.msisdn,
        input.services || ['CICO'],
        input.terms_ack || false,
        input.created_by || null,
      ]
    );
    const distributor = res.rows[0];
    await writeAuditLog('MM_DISTRIBUTOR', distributor.id, input.created_by || null, null, 'SUBMITTED');
    return distributor;
  });
}

export async function getMmDistributors(options: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: any[]; total: number }> {
  const { status, search, limit = 50, offset = 0 } = options;
  const conds: string[] = [];
  const params: any[] = [];
  let p = 1;
  if (status) { conds.push(`status = $${p++}`); params.push(status); }
  if (search) {
    conds.push(`(company_name ILIKE $${p} OR place_of_business ILIKE $${p} OR distributor_code ILIKE $${p} OR msisdn ILIKE $${p})`);
    params.push(`%${search}%`);
    p++;
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const totalRes = await query(`SELECT COUNT(*)::int AS total FROM mm_distributors ${where}`, [...params]);
  const total = totalRes.rows[0].total;
  const dataRes = await query(
    `SELECT * FROM mm_distributors ${where} ORDER BY created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
    [...params, limit, offset]
  );
  return { rows: dataRes.rows, total };
}

export async function getMmDistributorById(id: string): Promise<any> {
  const res = await query(`SELECT * FROM mm_distributors WHERE id = $1`, [id]);
  if (!res.rows[0]) return null;
  const [audit] = await Promise.all([
    query(`SELECT * FROM onboarding_audit_logs WHERE entity_type = 'MM_DISTRIBUTOR' AND entity_id = $1 ORDER BY created_at DESC`, [id]),
  ]);
  return { ...res.rows[0], audit: audit.rows };
}

export async function approveMmDistributor(id: string, actorIdentifier: string): Promise<any> {
  await transaction(async (client) => {
    const res = await client.query(`SELECT * FROM mm_distributors WHERE id = $1 FOR UPDATE`, [id]);
    const row = res.rows[0];
    if (!row) throw new Error('Mobile Money distributor not found');
    if (row.status === 'APPROVED') throw new Error('Mobile Money distributor is already approved');
    if (row.status === 'REJECTED') throw new Error('Mobile Money distributor has been rejected and cannot be approved');
    await client.query(
      `UPDATE mm_distributors SET status = 'APPROVED', decided_by = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id, actorIdentifier]
    );
    await writeAuditLog('MM_DISTRIBUTOR', id, actorIdentifier, row.status, 'APPROVED');
  });
  return getMmDistributorById(id);
}

export async function rejectMmDistributor(id: string, reason: string, actorIdentifier: string): Promise<any> {
  await transaction(async (client) => {
    const res = await client.query(`SELECT * FROM mm_distributors WHERE id = $1 FOR UPDATE`, [id]);
    const row = res.rows[0];
    if (!row) throw new Error('Mobile Money distributor not found');
    if (!reason?.trim()) throw new Error('Rejection reason is required');
    await client.query(
      `UPDATE mm_distributors SET status = 'REJECTED', reject_reason = $2, decided_by = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id, reason.trim(), actorIdentifier]
    );
    await writeAuditLog('MM_DISTRIBUTOR', id, actorIdentifier, row.status, 'REJECTED', reason.trim());
  });
  return getMmDistributorById(id);
}

// ==================== PHASE 3D: MERCHANT ONBOARDING ====================

export interface MerchantDocumentInput {
  document_key: string;
  ticked?: boolean;
  file_url?: string;
  file_name?: string;
}

export interface MerchantSubmissionInput {
  ticket_number: string;
  merchant_type: 'INDIVIDUAL' | 'COMPANY';
  company_name?: string;
  outlet_name?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  msisdn: string;
  tin?: string;
  national_id?: string;
  district?: string;
  village?: string;
  lc1?: string;
  place_of_business?: string;
  agent_services?: string[];
  gps_lat?: number | null;
  gps_lng?: number | null;
  terms_ack?: boolean;
  documents?: MerchantDocumentInput[];
  created_by?: string;
}

async function ensureMerchantsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS merchants (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_number     VARCHAR(100),
      merchant_code     VARCHAR(20) UNIQUE,
      merchant_type     VARCHAR(20) NOT NULL CHECK (merchant_type IN ('INDIVIDUAL','COMPANY')),
      company_name      VARCHAR(255),
      outlet_name       VARCHAR(255),
      name              VARCHAR(255),
      first_name        VARCHAR(255),
      last_name         VARCHAR(255),
      msisdn            VARCHAR(50) NOT NULL,
      tin               VARCHAR(100),
      national_id       VARCHAR(100),
      district          VARCHAR(120),
      village           VARCHAR(120),
      lc1               VARCHAR(120),
      place_of_business VARCHAR(255),
      agent_services    TEXT[] NOT NULL DEFAULT '{}',
      gps_lat           NUMERIC(10,6),
      gps_lng           NUMERIC(10,6),
      terms_ack         BOOLEAN NOT NULL DEFAULT false,
      status            VARCHAR(30) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN (
                          'SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED'
                        )),
      reject_reason     TEXT,
      decided_by        VARCHAR(255),
      decided_at        TIMESTAMPTZ,
      created_by        VARCHAR(255),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_merchants_status ON merchants(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_merchants_ticket_number ON merchants(ticket_number)`);
}

async function ensureMerchantDocumentsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS merchant_documents (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      merchant_id    UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      document_key   VARCHAR(80) NOT NULL,
      document_label VARCHAR(255) NOT NULL,
      required       BOOLEAN NOT NULL DEFAULT true,
      ticked         BOOLEAN NOT NULL DEFAULT false,
      ticked_by      VARCHAR(255),
      ticked_at      TIMESTAMPTZ,
      file_url       TEXT,
      file_name      VARCHAR(255),
      uploaded_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (merchant_id, document_key)
    )
  `);
}

async function ensureMerchantChecklistRules(): Promise<void> {
  const seed: Array<[string, string, number, string]> = [
    ['national_id', 'National ID', 1, 'Clear photo/scan of the merchant\'s valid national identity card (front and back).'],
    ['business_premises', 'Business Premises Document', 2, 'Document confirming the merchant\'s business premises, e.g. trading license, lease agreement, or LC1 letter.'],
  ];
  for (const [key, label, sort, description] of seed) {
    const { rows } = await query(
      `SELECT 1 FROM document_checklist_rules WHERE entity_type = 'MERCHANT' AND document_key = $1 LIMIT 1`,
      [key]
    );
    if (rows.length > 0) continue;
    await query(
      `INSERT INTO document_checklist_rules (entity_type, document_key, document_label, description, sort_order)
       VALUES ('MERCHANT', $1, $2, $3, $4)`,
      [key, label, description, sort]
    );
  }
}

export async function getMerchantChecklist(): Promise<
  Array<{ document_key: string; document_label: string; description: string | null; required: boolean }>
> {
  const { rows } = await query(
    `SELECT document_key, document_label, description
       FROM document_checklist_rules
       WHERE entity_type = 'MERCHANT'
       ORDER BY sort_order ASC`
  );
  return rows.map((r: any) => ({ document_key: r.document_key, document_label: r.document_label, description: r.description, required: true }));
}

export async function generateMerchantCode(): Promise<string> {
  const { rows } = await query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(merchant_code FROM 'MCH-(\\d+)') AS INTEGER)), 0) AS max_seq
       FROM merchants WHERE merchant_code ~ '^MCH-\\d+$'`
  );
  const seq = (rows[0]?.max_seq || 0) + 1;
  return `MCH-${String(seq).padStart(4, '0')}`;
}

export async function submitMerchant(input: MerchantSubmissionInput): Promise<any> {
  return transaction(async (client) => {
    await assertTicketNumberAvailable(client, input.ticket_number);
    if (!input.msisdn?.trim()) throw new Error('MSISDN is required');
    if (!input.merchant_type) throw new Error('Merchant type is required');
    if (input.merchant_type === 'COMPANY') {
      if (!input.company_name?.trim()) throw new Error('Company name is required');
      if (!input.terms_ack) throw new Error('You must agree to the terms and conditions');
    } else {
      if (!input.first_name?.trim() || !input.last_name?.trim()) throw new Error('First and last names are required');
      if (!input.place_of_business?.trim()) throw new Error('Place of business is required');
    }
    const merchantCode = await generateMerchantCode();
    const name = input.merchant_type === 'COMPANY'
      ? input.company_name!.trim()
      : `${input.first_name!.trim()} ${input.last_name!.trim()}`;
    const merchantRes = await client.query(
      `INSERT INTO merchants (
         ticket_number, merchant_code, merchant_type, company_name, outlet_name, name, first_name, last_name,
         msisdn, tin, national_id, district, village, lc1, place_of_business, agent_services,
         gps_lat, gps_lng, terms_ack, status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'SUBMITTED',$20)
       RETURNING *`,
      [
        input.ticket_number,
        merchantCode,
        input.merchant_type,
        input.company_name || null,
        input.outlet_name || null,
        name,
        input.first_name || null,
        input.last_name || null,
        input.msisdn,
        input.tin || null,
        input.national_id || null,
        input.district || null,
        input.village || null,
        input.lc1 || null,
        input.place_of_business || null,
        input.agent_services || [],
        input.gps_lat ?? null,
        input.gps_lng ?? null,
        input.terms_ack || false,
        input.created_by || null,
      ]
    );
    const merchant = merchantRes.rows[0];

    if (input.merchant_type === 'INDIVIDUAL') {
      const checklist = await getMerchantChecklist();
      const provided = new Map<string, MerchantDocumentInput>((input.documents || []).map((d) => [d.document_key, d]));
      for (const item of checklist) {
        const doc = provided.get(item.document_key);
        await client.query(
          `INSERT INTO merchant_documents (merchant_id, document_key, document_label, required, ticked, file_url, file_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [merchant.id, item.document_key, item.document_label, true, doc?.ticked || false, doc?.file_url || null, doc?.file_name || null]
        );
      }
    }

    await writeAuditLog('MERCHANT', merchant.id, input.created_by || null, null, 'SUBMITTED');
    return merchant;
  });
}

export async function getMerchants(options: {
  status?: string;
  merchantType?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: any[]; total: number }> {
  const { status, merchantType, search, limit = 50, offset = 0 } = options;
  const conds: string[] = [];
  const params: any[] = [];
  let p = 1;
  if (status) { conds.push(`status = $${p++}`); params.push(status); }
  if (merchantType) { conds.push(`merchant_type = $${p++}`); params.push(merchantType); }
  if (search) {
    conds.push(`(name ILIKE $${p} OR company_name ILIKE $${p} OR merchant_code ILIKE $${p} OR msisdn ILIKE $${p})`);
    params.push(`%${search}%`);
    p++;
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const totalRes = await query(`SELECT COUNT(*)::int AS total FROM merchants ${where}`, [...params]);
  const total = totalRes.rows[0].total;
  const dataRes = await query(
    `SELECT m.*,
            (SELECT COUNT(*)::int FROM merchant_documents md WHERE md.merchant_id = m.id AND md.required = true AND md.ticked = false) AS outstanding_documents
       FROM merchants m ${where} ORDER BY m.created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
    [...params, limit, offset]
  );
  return { rows: dataRes.rows, total };
}

export async function getMerchantById(id: string): Promise<any> {
  const merchantRes = await query(`SELECT * FROM merchants WHERE id = $1`, [id]);
  if (!merchantRes.rows[0]) return null;
  const [documents, audit] = await Promise.all([
    query(`SELECT * FROM merchant_documents WHERE merchant_id = $1 ORDER BY created_at`, [id]),
    query(`SELECT * FROM onboarding_audit_logs WHERE entity_type = 'MERCHANT' AND entity_id = $1 ORDER BY created_at DESC`, [id]),
  ]);
  return { ...merchantRes.rows[0], documents: documents.rows, audit: audit.rows };
}

export async function updateMerchantDocument(
  merchantId: string,
  documentKey: string,
  updates: { ticked?: boolean; file_url?: string; file_name?: string; ticked_by?: string },
  actor?: string
): Promise<any> {
  const { ticked, file_url, file_name, ticked_by } = updates;
  const setClauses: string[] = [];
  const params: any[] = [];
  let p = 1;
  if (ticked !== undefined) { setClauses.push(`ticked = $${p++}`); params.push(ticked); }
  if (file_url !== undefined) { setClauses.push(`file_url = $${p++}`); params.push(file_url); }
  if (file_name !== undefined) { setClauses.push(`file_name = $${p++}`); params.push(file_name); }
  if (ticked_by !== undefined) { setClauses.push(`ticked_by = $${p++}, ticked_at = NOW()`); params.push(ticked_by); }
  if (setClauses.length === 0) return null;
  params.push(merchantId, documentKey);
  const res = await query(
    `UPDATE merchant_documents SET ${setClauses.join(', ')} WHERE merchant_id = $${p++} AND document_key = $${p++} RETURNING *`,
    params
  );
  if (res.rows[0] && actor) {
    await writeAuditLog('MERCHANT', merchantId, actor, null, null, `Updated document ${documentKey}`);
  }
  return res.rows[0];
}

export async function approveMerchant(id: string, actorIdentifier: string): Promise<any> {
  await transaction(async (client) => {
    const res = await client.query(`SELECT * FROM merchants WHERE id = $1 FOR UPDATE`, [id]);
    const row = res.rows[0];
    if (!row) throw new Error('Merchant not found');
    if (row.status === 'APPROVED') throw new Error('Merchant is already approved');
    if (row.status === 'REJECTED') throw new Error('Merchant has been rejected and cannot be approved');
    await client.query(
      `UPDATE merchants SET status = 'APPROVED', decided_by = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id, actorIdentifier]
    );
    await writeAuditLog('MERCHANT', id, actorIdentifier, row.status, 'APPROVED');
  });
  return getMerchantById(id);
}

export async function rejectMerchant(id: string, reason: string, actorIdentifier: string): Promise<any> {
  await transaction(async (client) => {
    const res = await client.query(`SELECT * FROM merchants WHERE id = $1 FOR UPDATE`, [id]);
    const row = res.rows[0];
    if (!row) throw new Error('Merchant not found');
    if (!reason?.trim()) throw new Error('Rejection reason is required');
    await client.query(
      `UPDATE merchants SET status = 'REJECTED', reject_reason = $2, decided_by = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id, reason.trim(), actorIdentifier]
    );
    await writeAuditLog('MERCHANT', id, actorIdentifier, row.status, 'REJECTED', reason.trim());
  });
  return getMerchantById(id);
}
