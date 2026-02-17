-- ============================================
-- HAMILTON TELECOM MVNE - SIM CARD INVENTORY
-- Physical SIMs, eSIMs, Distributors, Stock Tracking
-- ============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- ENUM TYPES
-- ============================================
DO $$ BEGIN
  CREATE TYPE sim_type AS ENUM ('PHYSICAL', 'ESIM');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE sim_status AS ENUM ('IN_STORE', 'ISSUED', 'ACTIVATED', 'FAILED', 'SOLD', 'RETURNED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE mvno_name AS ENUM ('PAXTEL', 'SALAMTEL', 'AGROTEL', 'BCC');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE distributor_type AS ENUM (
    'SERVICE_CENTER', 'CHANNEL_PARTNER', 'INDIVIDUAL', 'MANAGEMENT',
    'DISTRIBUTOR', 'AGENT', 'RETAILER', 'WHOLESALER', 'EMPLOYEE', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ============================================
-- MVNOS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS mvnos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name mvno_name NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO mvnos (name) VALUES ('PAXTEL'), ('SALAMTEL'), ('AGROTEL'), ('BCC')
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- CARTONS (Physical SIMs - 40 cartons, 20 boxes, 250/box = 5000/carton)
-- ============================================
CREATE TABLE IF NOT EXISTS cartons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  carton_number VARCHAR(10) NOT NULL,
  mvno_id UUID REFERENCES mvnos(id) NOT NULL,
  imsi_start BIGINT NOT NULL,
  imsi_end BIGINT NOT NULL,
  iccid_start VARCHAR(22) NOT NULL,
  iccid_end VARCHAR(22) NOT NULL,
  total_boxes INTEGER NOT NULL DEFAULT 20,
  sims_per_box INTEGER NOT NULL DEFAULT 250,
  total_sims INTEGER GENERATED ALWAYS AS (total_boxes * sims_per_box) STORED,
  status sim_status DEFAULT 'IN_STORE',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(carton_number, mvno_id)
);

-- ============================================
-- BOXES (within cartons)
-- ============================================
CREATE TABLE IF NOT EXISTS boxes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  carton_id UUID REFERENCES cartons(id) ON DELETE CASCADE NOT NULL,
  box_number INTEGER NOT NULL,
  iccid_start VARCHAR(22) NOT NULL,
  iccid_end VARCHAR(22) NOT NULL,
  imsi_start BIGINT NOT NULL,
  imsi_end BIGINT NOT NULL,
  total_sims INTEGER NOT NULL DEFAULT 250,
  status sim_status DEFAULT 'IN_STORE',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(carton_id, box_number)
);

-- ============================================
-- DISTRIBUTORS (create before physical_sims / esim_stock)
-- ============================================
CREATE TABLE IF NOT EXISTS distributors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  type distributor_type NOT NULL,
  location VARCHAR(255),
  mvno_id UUID REFERENCES mvnos(id),
  contact_person VARCHAR(255),
  phone VARCHAR(50),
  email VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- PHYSICAL SIMS (individual SIMs - optional, for granular tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS physical_sims (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  iccid VARCHAR(22) UNIQUE NOT NULL,
  imsi BIGINT UNIQUE NOT NULL,
  mvno_id UUID REFERENCES mvnos(id) NOT NULL,
  carton_id UUID REFERENCES cartons(id),
  box_id UUID REFERENCES boxes(id),
  status sim_status DEFAULT 'IN_STORE',
  issued_to_distributor_id UUID REFERENCES distributors(id),
  issued_date TIMESTAMPTZ,
  activation_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- eSIM STOCK
-- ============================================
CREATE TABLE IF NOT EXISTS esim_stock (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  iccid VARCHAR(22) UNIQUE NOT NULL,
  imsi BIGINT UNIQUE NOT NULL,
  mvno_id UUID REFERENCES mvnos(id) NOT NULL,
  status sim_status DEFAULT 'IN_STORE',
  issued_to_distributor_id UUID REFERENCES distributors(id),
  issued_date TIMESTAMPTZ,
  activation_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS esim_ranges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mvno_id UUID REFERENCES mvnos(id) NOT NULL,
  iccid_start VARCHAR(22) NOT NULL,
  iccid_end VARCHAR(22) NOT NULL,
  imsi_start BIGINT NOT NULL,
  imsi_end BIGINT NOT NULL,
  total_sims INTEGER NOT NULL,
  available_sims INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- DISTRIBUTOR CONTACTS & BALANCES
-- ============================================
CREATE TABLE IF NOT EXISTS distributor_contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  distributor_id UUID REFERENCES distributors(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  email VARCHAR(255),
  position VARCHAR(100),
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS distributor_balances (
  distributor_id UUID PRIMARY KEY REFERENCES distributors(id) ON DELETE CASCADE,
  total_sims_received INTEGER DEFAULT 0,
  total_sims_activated INTEGER DEFAULT 0,
  total_sims_returned INTEGER DEFAULT 0,
  total_sims_failed INTEGER DEFAULT 0,
  pending_activation INTEGER DEFAULT 0,
  last_transaction_date TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- STOCK DISTRIBUTIONS
-- ============================================
CREATE TABLE IF NOT EXISTS stock_distributions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  distribution_date DATE NOT NULL,
  distributor_id UUID REFERENCES distributors(id) NOT NULL,
  mvno_id UUID REFERENCES mvnos(id) NOT NULL,
  purpose TEXT,
  sim_type sim_type NOT NULL,
  quantity INTEGER NOT NULL,
  status VARCHAR(50) DEFAULT 'ISSUED',
  notes TEXT,
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS distribution_details (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  distribution_id UUID REFERENCES stock_distributions(id) ON DELETE CASCADE,
  sim_type sim_type NOT NULL,
  iccid VARCHAR(22) NOT NULL,
  imsi BIGINT,
  status sim_status DEFAULT 'ISSUED',
  activation_date TIMESTAMPTZ,
  boss_verified BOOLEAN DEFAULT FALSE,
  boss_verification_date TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(distribution_id, iccid)
);

-- ============================================
-- BOSS VERIFICATION QUEUE
-- ============================================
CREATE TABLE IF NOT EXISTS boss_verification_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  iccid VARCHAR(22) NOT NULL,
  imsi BIGINT,
  distribution_detail_id UUID REFERENCES distribution_details(id),
  status VARCHAR(50) DEFAULT 'PENDING',
  attempt_count INTEGER DEFAULT 0,
  last_attempt TIMESTAMPTZ,
  response_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_physical_sims_iccid ON physical_sims(iccid);
CREATE INDEX IF NOT EXISTS idx_physical_sims_imsi ON physical_sims(imsi);
CREATE INDEX IF NOT EXISTS idx_physical_sims_status ON physical_sims(status);
CREATE INDEX IF NOT EXISTS idx_esim_stock_iccid ON esim_stock(iccid);
CREATE INDEX IF NOT EXISTS idx_esim_stock_imsi ON esim_stock(imsi);
CREATE INDEX IF NOT EXISTS idx_esim_stock_status ON esim_stock(status);
CREATE INDEX IF NOT EXISTS idx_distributors_type ON distributors(type);
CREATE INDEX IF NOT EXISTS idx_distribution_details_iccid ON distribution_details(iccid);
CREATE INDEX IF NOT EXISTS idx_distribution_details_status ON distribution_details(status);

-- ============================================
-- RLS (Row Level Security)
-- ============================================
ALTER TABLE mvnos ENABLE ROW LEVEL SECURITY;
ALTER TABLE cartons ENABLE ROW LEVEL SECURITY;
ALTER TABLE boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE physical_sims ENABLE ROW LEVEL SECURITY;
ALTER TABLE esim_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE distributors ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE distribution_details ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for anon" ON mvnos FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON cartons FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON boxes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON physical_sims FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON esim_stock FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON distributors FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON stock_distributions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON distribution_details FOR ALL USING (true) WITH CHECK (true);
