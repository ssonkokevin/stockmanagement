-- ============================================
-- FIX FOR INVALID CREDENTIALS ERROR
-- ============================================
-- Run these SQL commands in your Supabase SQL Editor
-- ============================================

-- PART 1: Create platform_users table (only if not exists)
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

-- PART 2: Enable RLS and grant permissions
ALTER TABLE platform_users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON platform_users TO anon;

-- PART 3: Create RLS policy to allow reading platform_users
DROP POLICY IF EXISTS "Allow anon read platform_users" ON platform_users;
CREATE POLICY "Allow anon read platform_users" ON platform_users
  FOR SELECT TO anon
  USING (true);

-- PART 4: Insert demo users (run each INSERT separately)
INSERT INTO platform_users (email, password_hash, full_name, role, mvno_id, is_active)
VALUES ('admin@hamilton.com', 'demo123', 'System Administrator', 'SUPER_ADMIN', NULL, true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO platform_users (email, password_hash, full_name, role, mvno_id, is_active)
VALUES ('manager@hamilton.com', 'demo123', 'Operations Manager', 'MANAGEMENT', NULL, true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO platform_users (email, password_hash, full_name, role, mvno_id, is_active)
VALUES ('paxtel@paxtel.com', 'demo123', 'Paxtel Admin', 'MVNO_ADMIN', (SELECT id FROM mvnos WHERE name = 'PAXTEL' LIMIT 1), true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO platform_users (email, password_hash, full_name, role, mvno_id, is_active)
VALUES ('salamtel@salamtel.com', 'demo123', 'Salamtel Admin', 'MVNO_ADMIN', (SELECT id FROM mvnos WHERE name = 'SALAMTEL' LIMIT 1), true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO platform_users (email, password_hash, full_name, role, mvno_id, is_active)
VALUES ('agrotel@agrotel.com', 'demo123', 'Agrotel Admin', 'MVNO_ADMIN', (SELECT id FROM mvnos WHERE name = 'AGROTEL' LIMIT 1), true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO platform_users (email, password_hash, full_name, role, mvno_id, is_active)
VALUES ('distributor1@channel.com', 'demo123', 'Channel Partner 1', 'DISTRIBUTOR', (SELECT id FROM mvnos WHERE name = 'PAXTEL' LIMIT 1), true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO platform_users (email, password_hash, full_name, role, mvno_id, is_active)
VALUES ('distributor2@channel.com', 'demo123', 'Channel Partner 2', 'DISTRIBUTOR', (SELECT id FROM mvnos WHERE name = 'SALAMTEL' LIMIT 1), true)
ON CONFLICT (email) DO NOTHING;

-- PART 5: Verify the users were created
SELECT email, full_name, role, is_active FROM platform_users;
