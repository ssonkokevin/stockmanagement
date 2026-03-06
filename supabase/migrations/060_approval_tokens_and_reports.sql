-- ============================================
-- Secure Dual-Approval Workflow Tables
-- ============================================

-- ============================================
-- APPROVAL TOKENS TABLE
-- Secure token-based approval system
-- ============================================
CREATE TABLE IF NOT EXISTS stock_approval_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES stock_issuance_requests(id) ON DELETE CASCADE,
  approver_role VARCHAR(50) NOT NULL,  -- 'LEVEL_1', 'LEVEL_2'
  approver_email VARCHAR(255) NOT NULL,
  token VARCHAR(64) UNIQUE NOT NULL,  -- 32-byte hex = 64 chars
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE stock_approval_tokens ENABLE ROW LEVEL SECURITY;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_approval_tokens_token ON stock_approval_tokens(token);
CREATE INDEX IF NOT EXISTS idx_approval_tokens_request ON stock_approval_tokens(request_id);

-- Grant permissions
GRANT SELECT, INSERT ON stock_approval_tokens TO anon, authenticated;
GRANT UPDATE ON stock_approval_tokens TO authenticated;

-- RLS Policy
DROP POLICY IF EXISTS "Allow anon stock_approval_tokens" ON stock_approval_tokens;
CREATE POLICY "Allow anon stock_approval_tokens" ON stock_approval_tokens FOR ALL TO anon USING (true);

-- ============================================
-- ISSUANCE REPORTS TABLE
-- Auto-generated after Level 2 approval
-- ============================================
CREATE TABLE IF NOT EXISTS stock_issuance_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES stock_issuance_requests(id) ON DELETE CASCADE,
  
  -- Distributor info
  distributor_name VARCHAR(255),
  distributor_id UUID,
  
  -- Stock details
  sim_type VARCHAR(20),
  quantity INTEGER,
  
  -- Assigned stock summary
  assigned_boxes JSONB,  -- Array of box details
  assigned_esims JSONB,  -- Array of ICCIDs
  
  -- Approval chain
  level_1_approved_by UUID,
  level_1_approved_email VARCHAR(255),
  level_1_approved_at TIMESTAMPTZ,
  
  level_2_approved_by UUID,
  level_2_approved_email VARCHAR(255),
  level_2_approved_at TIMESTAMPTZ,
  
  -- Report metadata
  report_generated_at TIMESTAMPTZ DEFAULT NOW(),
  report_notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE stock_issuance_reports ENABLE ROW LEVEL SECURITY;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_stock_reports_request ON stock_issuance_reports(request_id);
CREATE INDEX IF NOT EXISTS idx_stock_reports_created ON stock_issuance_reports(created_at DESC);

-- Grant permissions
GRANT SELECT ON stock_issuance_reports TO anon, authenticated;
GRANT INSERT ON stock_issuance_reports TO authenticated;

-- RLS Policy
DROP POLICY IF EXISTS "Allow anon stock_issuance_reports" ON stock_issuance_reports;
CREATE POLICY "Allow anon stock_issuance_reports" ON stock_issuance_reports FOR SELECT TO anon USING (true);

-- ============================================
-- APPROVER CONFIGURATION TABLE
-- Store Level 1 and Level 2 approver emails
-- ============================================
CREATE TABLE IF NOT EXISTS stock_approver_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approver_level VARCHAR(20) NOT NULL CHECK (approver_level IN ('LEVEL_1', 'LEVEL_2')),
  approver_name VARCHAR(255) NOT NULL,
  approver_email VARCHAR(255) NOT NULL UNIQUE,
  approver_role VARCHAR(50),  -- Link to platform role
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE stock_approver_config ENABLE ROW LEVEL SECURITY;

-- Insert default approvers (can be changed)
INSERT INTO stock_approver_config (approver_level, approver_name, approver_email, approver_role)
VALUES 
  ('LEVEL_1', 'Technical Lead', 'kssonkokevin@gmail.com', 'MANAGEMENT'),
  ('LEVEL_2', 'Commercial Lead', 'bombten09@gmail.com', 'SUPER_ADMIN')
ON CONFLICT (approver_email) DO NOTHING;

-- Grant permissions
GRANT SELECT ON stock_approver_config TO anon, authenticated;
GRANT INSERT, UPDATE ON stock_approver_config TO authenticated;

-- RLS Policy
DROP POLICY IF EXISTS "Allow anon stock_approver_config" ON stock_approver_config;
CREATE POLICY "Allow anon stock_approver_config" ON stock_approver_config FOR SELECT TO anon USING (true);

-- ============================================
-- Helper function to generate secure token
-- ============================================
CREATE OR REPLACE FUNCTION generate_secure_token()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
BEGIN
  return encode(gen_random_bytes(32), 'hex');
END;
$$;

GRANT EXECUTE ON FUNCTION generate_secure_token TO anon, authenticated;

-- ============================================
-- Function to create approval tokens for a request
-- ============================================
CREATE OR REPLACE FUNCTION create_approval_tokens(p_request_id UUID)
RETURNS TABLE(token_level VARCHAR, token_value TEXT, approver_email VARCHAR)
LANGUAGE plpgsql
AS $$
DECLARE
  v_level1_token TEXT;
  v_level2_token TEXT;
  v_level1_email VARCHAR;
  v_level2_email VARCHAR;
BEGIN
  -- Get approver emails from config
  SELECT ac1.approver_email, ac2.approver_email
  INTO v_level1_email, v_level2_email
  FROM stock_approver_config ac1
  CROSS JOIN stock_approver_config ac2
  WHERE ac1.approver_level = 'LEVEL_1' AND ac1.is_active = true
  AND ac2.approver_level = 'LEVEL_2' AND ac2.is_active = true;
  
  -- Generate tokens
  v_level1_token := generate_secure_token();
  v_level2_token := generate_secure_token();
  
  -- Insert Level 1 token
  INSERT INTO stock_approval_tokens (request_id, approver_role, approver_email, token, expires_at)
  VALUES (p_request_id, 'LEVEL_1', v_level1_email, v_level1_token, NOW() + INTERVAL '24 hours');
  
  -- Insert Level 2 token
  INSERT INTO stock_approval_tokens (request_id, approver_role, approver_email, token, expires_at)
  VALUES (p_request_id, 'LEVEL_2', v_level2_email, v_level2_token, NOW() + INTERVAL '24 hours');
  
  -- Return tokens
  RETURN QUERY VALUES ('LEVEL_1', v_level1_token, v_level1_email);
  RETURN QUERY VALUES ('LEVEL_2', v_level2_token, v_level2_email);
END;
$$;

GRANT EXECUTE ON FUNCTION create_approval_tokens TO authenticated;

-- ============================================
-- Function to validate and use token
-- ============================================
CREATE OR REPLACE FUNCTION validate_and_use_token(
  p_token VARCHAR,
  p_approver_email VARCHAR
)
RETURNS TABLE(success BOOLEAN, message TEXT, request_id UUID, approver_level VARCHAR)
LANGUAGE plpgsql
AS $$
DECLARE
  v_token_record RECORD;
BEGIN
  -- Find and validate token
  SELECT * INTO v_token_record
  FROM stock_approval_tokens
  WHERE token = p_token AND used = false;
  
  IF v_token_record IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Invalid or already used token', NULL, NULL;
    RETURN;
  END IF;
  
  -- Check expiration
  IF v_token_record.expires_at < NOW() THEN
    RETURN QUERY SELECT FALSE, 'Token has expired', NULL, NULL;
    RETURN;
  END IF;
  
  -- Check email matches
  IF v_token_record.approver_email != p_approver_email THEN
    RETURN QUERY SELECT FALSE, 'Email does not match token recipient', NULL, NULL;
    RETURN;
  END IF;
  
  -- Mark token as used
  UPDATE stock_approval_tokens
  SET used = true, used_at = NOW()
  WHERE id = v_token_record.id;
  
  RETURN QUERY SELECT TRUE, 'Token validated successfully', v_token_record.request_id, v_token_record.approver_role;
END;
$$;

GRANT EXECUTE ON FUNCTION validate_and_use_token TO anon, authenticated;

-- ============================================
-- Function to approve Level 1
-- ============================================
CREATE OR REPLACE FUNCTION approve_level_1_with_token(
  p_request_id UUID,
  p_approver_id UUID,
  p_approver_email VARCHAR
)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request RECORD;
  v_old_status VARCHAR;
BEGIN
  -- Get request
  SELECT * INTO v_request
  FROM stock_issuance_requests
  WHERE id = p_request_id;
  
  IF v_request IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found';
    RETURN;
  END IF;
  
  -- STRICT: Only allow if current status is PENDING
  IF v_request.status != 'PENDING' THEN
    RETURN QUERY SELECT FALSE, format('Invalid status: %s. Must be PENDING for Level 1 approval.', v_request.status);
    RETURN;
  END IF;
  
  v_old_status := v_request.status;
  
  -- Update to LEVEL_1_APPROVED
  UPDATE stock_issuance_requests
  SET status = 'LEVEL_1_APPROVED',
      level_1_approver_id = p_approver_id,
      level_1_approver_email = p_approver_email,
      level_1_approved_at = NOW(),
      updated_at = NOW()
  WHERE id = p_request_id;
  
  -- Log transition
  PERFORM log_stock_request_transition(
    p_request_id,
    'LEVEL_1_APPROVED',
    p_approver_id,
    p_approver_email,
    v_old_status,
    'LEVEL_1_APPROVED',
    'Approved via token'
  );
  
  RETURN QUERY SELECT TRUE, 'Level 1 approval successful';
END;
$$;

GRANT EXECUTE ON FUNCTION approve_level_1_with_token TO anon, authenticated;

-- ============================================
-- Function to approve Level 2 (also generates report)
-- ============================================
CREATE OR REPLACE FUNCTION approve_level_2_with_token(
  p_request_id UUID,
  p_approver_id UUID,
  p_approver_email VARCHAR
)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request RECORD;
  v_old_status VARCHAR;
  v_distributor RECORD;
BEGIN
  -- Get request
  SELECT * INTO v_request
  FROM stock_issuance_requests
  WHERE id = p_request_id;
  
  IF v_request IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found';
    RETURN;
  END IF;
  
  -- STRICT: Only allow if current status is LEVEL_1_APPROVED
  IF v_request.status != 'LEVEL_1_APPROVED' THEN
    RETURN QUERY SELECT FALSE, format('Invalid status: %s. Must be LEVEL_1_APPROVED for Level 2 approval.', v_request.status);
    RETURN;
  END IF;
  
  v_old_status := v_request.status;
  
  -- Update to LEVEL_2_APPROVED
  UPDATE stock_issuance_requests
  SET status = 'LEVEL_2_APPROVED',
      level_2_approver_id = p_approver_id,
      level_2_approver_email = p_approver_email,
      level_2_approved_at = NOW(),
      updated_at = NOW()
  WHERE id = p_request_id;
  
  -- Log transition
  PERFORM log_stock_request_transition(
    p_request_id,
    'LEVEL_2_APPROVED',
    p_approver_id,
    p_approver_email,
    v_old_status,
    'LEVEL_2_APPROVED',
    'Approved via token'
  );
  
  -- Get distributor info if available
  SELECT * INTO v_distributor
  FROM distributors
  WHERE id = v_request.requester_id;
  
  -- Generate report
  INSERT INTO stock_issuance_reports (
    request_id,
    distributor_name,
    distributor_id,
    sim_type,
    quantity,
    assigned_boxes,
    assigned_esims,
    level_1_approved_by,
    level_1_approved_email,
    level_1_approved_at,
    level_2_approved_by,
    level_2_approved_email,
    level_2_approved_at,
    report_generated_at
  )
  VALUES (
    p_request_id,
    v_distributor.name,
    v_request.requester_id,
    v_request.sim_type,
    v_request.quantity,
    v_request.assigned_box_quantities,
    v_request.assigned_esim_iccids,
    v_request.level_1_approver_id,
    v_request.level_1_approver_email,
    v_request.level_1_approved_at,
    p_approver_id,
    p_approver_email,
    NOW(),
    NOW()
  );
  
  RETURN QUERY SELECT TRUE, 'Level 2 approval successful. Report generated.';
END;
$$;

GRANT EXECUTE ON FUNCTION approve_level_2_with_token TO anon, authenticated;
