-- ============================================
-- MVNE Platform - Phase 1: Base Schema (Simplified)
-- ============================================
-- Run this in your Supabase SQL Editor in small parts if needed
-- ============================================

-- PART 1: Create platform_users table
CREATE TABLE IF NOT EXISTS platform_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  mvno_id UUID,
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE platform_users ENABLE ROW LEVEL SECURITY;

-- PART 2: Create boss_api_configs table
CREATE TABLE IF NOT EXISTS boss_api_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mvno_id UUID,
  api_name VARCHAR(100) NOT NULL,
  api_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  api_secret TEXT,
  is_active BOOLEAN DEFAULT true,
  last_sync TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE boss_api_configs ENABLE ROW LEVEL SECURITY;

-- PART 3: Create boss_sync_logs table
CREATE TABLE IF NOT EXISTS boss_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mvno_id UUID,
  sync_type VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  records_processed INTEGER DEFAULT 0,
  records_activated INTEGER DEFAULT 0,
  records_deactivated INTEGER DEFAULT 0,
  records_failed INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_seconds INTEGER
);

ALTER TABLE boss_sync_logs ENABLE ROW LEVEL SECURITY;

-- PART 4: Create activation_records table
CREATE TABLE IF NOT EXISTS activation_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mvno_id UUID,
  iccid TEXT NOT NULL,
  imsi BIGINT,
  distributor_id UUID,
  distribution_id UUID,
  activation_status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  activation_date TIMESTAMPTZ,
  deactivation_date TIMESTAMPTZ,
  boss_iccid VARCHAR(22),
  boss_status VARCHAR(50),
  boss_last_check TIMESTAMPTZ,
  failure_reason TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE activation_records ENABLE ROW LEVEL SECURITY;

-- PART 5: Add columns to box_pick_records (run individually if needed)
ALTER TABLE box_pick_records ADD COLUMN IF NOT EXISTS transaction_type VARCHAR(50);
ALTER TABLE box_pick_records ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(10,2);
ALTER TABLE box_pick_records ADD COLUMN IF NOT EXISTS total_cost NUMERIC(12,2);
ALTER TABLE box_pick_records ADD COLUMN IF NOT EXISTS currency VARCHAR(3);
ALTER TABLE box_pick_records ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50);
ALTER TABLE box_pick_records ADD COLUMN IF NOT EXISTS payment_date TIMESTAMPTZ;
ALTER TABLE box_pick_records ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(50);

-- PART 6: Add columns to boxes
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS owner_type VARCHAR(50);
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS reserved_sims INTEGER;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS reservation_id UUID;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;

-- PART 7: Add columns to esim_stock
ALTER TABLE esim_stock ADD COLUMN IF NOT EXISTS owner_type VARCHAR(50);
ALTER TABLE esim_stock ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE esim_stock ADD COLUMN IF NOT EXISTS is_reserved BOOLEAN;
ALTER TABLE esim_stock ADD COLUMN IF NOT EXISTS reservation_id UUID;
ALTER TABLE esim_stock ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;

-- PART 8: Add columns to cartons
ALTER TABLE cartons ADD COLUMN IF NOT EXISTS owner_type VARCHAR(50);
ALTER TABLE cartons ADD COLUMN IF NOT EXISTS owner_id UUID;

-- PART 9: Add columns to distributors
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS mvno_id UUID;

-- PART 10: Grant permissions
GRANT SELECT ON platform_users TO anon;
GRANT SELECT ON boss_api_configs TO anon;
GRANT SELECT ON boss_sync_logs TO anon;
GRANT SELECT ON activation_records TO anon;
GRANT SELECT ON box_pick_records TO anon;
GRANT SELECT ON boxes TO anon;
GRANT SELECT ON esim_stock TO anon;
GRANT SELECT ON cartons TO anon;
GRANT SELECT ON distributors TO anon;
