-- ============================================
-- Stock Request Audit Log Table
-- Professional Telecom-Grade Audit Trail
-- Tracks all status transitions for compliance
-- ============================================

-- Create stock_request_logs table
CREATE TABLE IF NOT EXISTS stock_request_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES stock_issuance_requests(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,  -- 'LEVEL_1_APPROVED', 'LEVEL_2_APPROVED', 'COMPLETED', 'REJECTED', 'ASSIGNED'
  performed_by UUID,  -- User ID who performed the action
  performed_by_email VARCHAR(255),
  performed_at TIMESTAMPTZ DEFAULT NOW(),
  old_status VARCHAR(50),
  new_status VARCHAR(50),
  notes TEXT,
  ip_address VARCHAR(45)
);

-- Enable RLS
ALTER TABLE stock_request_logs ENABLE ROW LEVEL SECURITY;

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_stock_request_logs_request_id ON stock_request_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_stock_request_logs_performed_at ON stock_request_logs(performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_request_logs_performed_by ON stock_request_logs(performed_by);

-- Grant permissions
GRANT SELECT ON stock_request_logs TO anon, authenticated;
GRANT INSERT ON stock_request_logs TO authenticated, anon;

-- RLS policy
DROP POLICY IF EXISTS "Allow anon stock_request_logs" ON stock_request_logs;
CREATE POLICY "Allow anon stock_request_logs" ON stock_request_logs FOR ALL TO anon USING (true);

-- ============================================
-- Function to log status transitions
-- ============================================
CREATE OR REPLACE FUNCTION log_stock_request_transition(
  p_request_id UUID,
  p_action VARCHAR,
  p_performed_by UUID,
  p_performed_by_email VARCHAR,
  p_old_status VARCHAR,
  p_new_status VARCHAR,
  p_notes TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO stock_request_logs (
    request_id,
    action,
    performed_by,
    performed_by_email,
    old_status,
    new_status,
    notes
  )
  VALUES (
    p_request_id,
    p_action,
    p_performed_by,
    p_performed_by_email,
    p_old_status,
    p_new_status,
    p_notes
  );
END;
$$;

GRANT EXECUTE ON FUNCTION log_stock_request_transition TO anon, authenticated;
