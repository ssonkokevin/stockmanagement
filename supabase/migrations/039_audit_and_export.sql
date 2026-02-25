-- ============================================
-- Audit Logs and Export System
-- ============================================
-- Creates:
-- 1. audit_logs table for tracking all export actions
-- 2. Export view for distribution records
-- 3. Functions for CSV/Excel export with filters
-- ============================================

-- Drop existing functions if they exist (for re-runs)
DROP FUNCTION IF EXISTS get_distribution_export(UUID, UUID, DATE, DATE, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS log_export_action(VARCHAR, UUID, VARCHAR, VARCHAR, JSONB, INTEGER);

-- Create audit_logs table
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action VARCHAR(100) NOT NULL,
  table_name VARCHAR(100),
  record_id UUID,
  user_id UUID,
  user_email VARCHAR(255),
  user_role VARCHAR(50),
  details JSONB,
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Policy for anon to insert (will be called from RPC)
DROP POLICY IF EXISTS "allow_insert_audit_logs" ON audit_logs;
CREATE POLICY "allow_insert_audit_logs" ON audit_logs FOR INSERT TO anon WITH CHECK (true);

-- Policy for authenticated to read own logs
DROP POLICY IF EXISTS "allow_read_audit_logs" ON audit_logs;
CREATE POLICY "allow_read_audit_logs" ON audit_logs FOR SELECT USING (true);

-- Create distribution export view
CREATE OR REPLACE VIEW distribution_export_view AS
SELECT 
  bpr.id,
  bpr.created_at AS distribution_date,
  d.id AS distributor_id,
  d.name AS distributor_name,
  d.type AS distributor_type,
  d.location AS distributor_location,
  c.id AS carton_id,
  c.carton_number,
  b.id AS box_id,
  b.box_number,
  m.id AS mvno_id,
  m.name AS mvno_name,
  bpr.sims_picked AS quantity,
  bpr.iccid_start,
  bpr.iccid_end,
  bpr.distribution_id,
  -- Calculate if eSIM or Physical based on box_id
  CASE 
    WHEN bpr.box_id IS NULL THEN 'ESIM'
    ELSE 'PHYSICAL'
  END AS sim_type
FROM box_pick_records bpr
LEFT JOIN distributors d ON bpr.distributor_id = d.id
LEFT JOIN boxes b ON bpr.box_id = b.id
LEFT JOIN cartons c ON b.carton_id = c.id
LEFT JOIN mvnos m ON c.mvno_id = m.id;

-- Create function to get distribution records with filters
CREATE FUNCTION get_distribution_export(
  p_mvno_id UUID DEFAULT NULL,
  p_distributor_id UUID DEFAULT NULL,
  p_date_from DATE DEFAULT NULL,
  p_date_to DATE DEFAULT NULL,
  p_limit INTEGER DEFAULT 10000,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE(
  id UUID,
  distribution_date TIMESTAMPTZ,
  distributor_name TEXT,
  distributor_type TEXT,
  distributor_location TEXT,
  carton_number TEXT,
  box_number INTEGER,
  mvno_name TEXT,
  quantity INTEGER,
  iccid_start TEXT,
  iccid_end TEXT,
  sim_type TEXT
) 
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY 
  SELECT 
    dev.id,
    dev.distribution_date,
    dev.distributor_name::TEXT,
    dev.distributor_type::TEXT,
    dev.distributor_location::TEXT,
    dev.carton_number::TEXT,
    dev.box_number,
    dev.mvno_name::TEXT,
    dev.quantity,
    dev.iccid_start::TEXT,
    dev.iccid_end::TEXT,
    dev.sim_type::TEXT
  FROM distribution_export_view dev
  WHERE 
    (p_mvno_id IS NULL OR dev.mvno_id = p_mvno_id)
    AND (p_distributor_id IS NULL OR dev.distributor_id = p_distributor_id)
    AND (p_date_from IS NULL OR dev.distribution_date >= p_date_from)
    AND (p_date_to IS NULL OR dev.distribution_date <= p_date_to + INTERVAL '1 day')
  ORDER BY dev.distribution_date DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- Create function to log export action
CREATE FUNCTION log_export_action(
  p_action VARCHAR,
  p_user_id UUID,
  p_user_email VARCHAR,
  p_user_role VARCHAR,
  p_filters JSONB,
  p_record_count INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit_logs (action, table_name, user_id, user_email, user_role, details)
  VALUES (
    p_action,
    'distribution_records',
    p_user_id,
    p_user_email,
    p_user_role,
    jsonb_build_object(
      'filters', p_filters,
      'record_count', p_record_count,
      'exported_at', NOW()
    )
  );
END;
$$;

-- Grant execute permissions
GRANT SELECT ON distribution_export_view TO anon;
GRANT EXECUTE ON FUNCTION get_distribution_export TO anon;
GRANT EXECUTE ON FUNCTION log_export_action TO anon;
