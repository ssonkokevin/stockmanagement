-- ============================================
-- Fix esim_stock table: Change ICCID and IMSI to TEXT
-- ICCID (20 digits) exceeds BIGINT max (19 digits)
-- Telecom best practice: store IMSI/ICCID as TEXT
-- ============================================

-- Option A: If table is empty, drop and recreate
DROP TABLE IF EXISTS esim_stock CASCADE;

CREATE TABLE esim_stock (
  id BIGSERIAL PRIMARY KEY,
  operator TEXT NOT NULL,
  imsi TEXT UNIQUE NOT NULL,
  iccid TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'available',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Recreate views
CREATE OR REPLACE VIEW total_esim_stock AS
SELECT 
  COUNT(*) AS total_esims,
  COUNT(*) FILTER (WHERE status = 'available') AS total_available,
  COUNT(*) FILTER (WHERE status = 'assigned') AS total_assigned,
  COUNT(*) FILTER (WHERE status = 'activated') AS total_activated
FROM esim_stock;

CREATE OR REPLACE VIEW esim_stock_by_operator AS
SELECT 
  operator,
  COUNT(*) AS total_esims,
  COUNT(*) FILTER (WHERE status = 'available') AS available,
  COUNT(*) FILTER (WHERE status = 'assigned') AS assigned,
  COUNT(*) FILTER (WHERE status = 'activated') AS activated
FROM esim_stock
GROUP BY operator
ORDER BY operator;

-- Enable RLS
ALTER TABLE esim_stock ENABLE ROW LEVEL SECURITY;

-- Allow all operations (adjust as needed for your auth setup)
CREATE POLICY "Allow all access to esim_stock" ON esim_stock
  FOR ALL USING (true) WITH CHECK (true);
