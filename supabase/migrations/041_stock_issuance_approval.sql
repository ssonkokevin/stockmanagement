-- ============================================
-- MVNE Platform - Phase 6: Enterprise Dual Approval
-- ============================================
-- Creates stock_issuance_requests table for Hamilton→MVNO 
-- stock transfers requiring dual approval
-- ============================================

-- STOCK ISSUANCE REQUESTS TABLE
CREATE TABLE IF NOT EXISTS stock_issuance_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mvno_id UUID NOT NULL,
  requester_id UUID NOT NULL,
  sim_type VARCHAR(20) NOT NULL,  -- 'PHYSICAL', 'ESIM'
  quantity INTEGER NOT NULL,
  
  -- Status workflow: PENDING → LEVEL_1_APPROVED → LEVEL_2_APPROVED → COMPLETED
  -- Can be REJECTED at any stage
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'LEVEL_1_APPROVED', 'LEVEL_2_APPROVED', 'COMPLETED', 'REJECTED')),
  
  -- Level 1 Approval (Manager)
  level_1_approver_id UUID,
  level_1_approved_at TIMESTAMPTZ,
  level_1_approval_token VARCHAR(255),
  level_1_token_expires TIMESTAMPTZ,
  
  -- Level 2 Approval (Director/Senior Manager)
  level_2_approver_id UUID,
  level_2_approved_at TIMESTAMPTZ,
  level_2_approval_token VARCHAR(255),
  level_2_token_expires TIMESTAMPTZ,
  
  rejection_reason TEXT,
  notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE stock_issuance_requests ENABLE ROW LEVEL SECURITY;

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_stock_issuance_mvno_id ON stock_issuance_requests(mvno_id);
CREATE INDEX IF NOT EXISTS idx_stock_issuance_status ON stock_issuance_requests(status);
CREATE INDEX IF NOT EXISTS idx_stock_issuance_created ON stock_issuance_requests(created_at DESC);

-- Grant permissions
GRANT SELECT ON stock_issuance_requests TO anon;

-- GRANT INSERT, UPDATE ON stock_issuance_requests TO authenticated;

-- FUNCTION: Generate approval token
CREATE OR REPLACE FUNCTION generate_approval_token()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
BEGIN
  return encode(gen_random_bytes(32), 'hex');
END;
$$;

-- FUNCTION: Create stock issuance request
CREATE OR REPLACE FUNCTION create_stock_issuance_request(
  p_mvno_id UUID,
  p_requester_id UUID,
  p_sim_type VARCHAR,
  p_quantity INTEGER,
  p_notes TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_request_id UUID := gen_random_uuid();
  v_token TEXT;
BEGIN
  v_token := generate_approval_token();
  
  INSERT INTO stock_issuance_requests (
    id, mvno_id, requester_id, sim_type, quantity, 
    status, level_1_approval_token, level_1_token_expires, notes
  )
  VALUES (
    v_request_id, p_mvno_id, p_requester_id, p_sim_type, p_quantity,
    'PENDING', v_token, NOW() + INTERVAL '48 hours', p_notes
  );
  
  RETURN v_request_id;
END;
$$;

-- FUNCTION: Approve issuance request (level 1 or 2)
CREATE OR REPLACE FUNCTION approve_issuance_request(
  p_request_id UUID,
  p_approver_id UUID,
  p_token VARCHAR,
  p_level INTEGER
)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request RECORD;
BEGIN
  SELECT * INTO v_request
  FROM stock_issuance_requests
  WHERE id = p_request_id;
  
  IF v_request IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found';
    RETURN;
  END IF;
  
  IF p_level = 1 THEN
    IF v_request.level_1_approval_token != p_token THEN
      RETURN QUERY SELECT FALSE, 'Invalid token';
      RETURN;
    END IF;
    IF v_request.level_1_token_expires < NOW() THEN
      RETURN QUERY SELECT FALSE, 'Token expired';
      RETURN;
    END IF;
    IF v_request.status != 'PENDING' THEN
      RETURN QUERY SELECT FALSE, 'Request already processed';
      RETURN;
    END IF;
    
    UPDATE stock_issuance_requests
    SET status = 'LEVEL_1_APPROVED',
        level_1_approver_id = p_approver_id,
        level_1_approved_at = NOW(),
        level_2_approval_token = generate_approval_token(),
        level_2_token_expires = NOW() + INTERVAL '48 hours',
        updated_at = NOW()
    WHERE id = p_request_id;
    
    RETURN QUERY SELECT TRUE, 'Level 1 approved. Level 2 approval pending.';
    
  ELSIF p_level = 2 THEN
    IF v_request.level_2_approval_token != p_token THEN
      RETURN QUERY SELECT FALSE, 'Invalid token';
      RETURN;
    END IF;
    IF v_request.level_2_token_expires < NOW() THEN
      RETURN QUERY SELECT FALSE, 'Token expired';
      RETURN;
    END IF;
    IF v_request.status != 'LEVEL_1_APPROVED' THEN
      RETURN QUERY SELECT FALSE, 'Level 1 approval required first';
      RETURN;
    END IF;
    
    UPDATE stock_issuance_requests
    SET status = 'COMPLETED',
        level_2_approver_id = p_approver_id,
        level_2_approved_at = NOW(),
        updated_at = NOW()
    WHERE id = p_request_id;
    
    RETURN QUERY SELECT TRUE, 'Stock issuance completed successfully.';
  END IF;
  
  RETURN QUERY SELECT FALSE, 'Invalid approval level';
END;
$$;

-- FUNCTION: Reject issuance request
CREATE OR REPLACE FUNCTION reject_issuance_request(
  p_request_id UUID,
  p_rejecter_id UUID,
  p_token VARCHAR,
  p_level INTEGER,
  p_reason TEXT
)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request RECORD;
BEGIN
  SELECT * INTO v_request
  FROM stock_issuance_requests
  WHERE id = p_request_id;
  
  IF v_request IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found';
    RETURN;
  END IF;
  
  -- Validate token based on level
  IF p_level = 1 THEN
    IF v_request.level_1_approval_token != p_token THEN
      RETURN QUERY SELECT FALSE, 'Invalid token';
      RETURN;
    END IF;
  ELSIF p_level = 2 THEN
    IF v_request.level_2_approval_token != p_token THEN
      RETURN QUERY SELECT FALSE, 'Invalid token';
      RETURN;
    END IF;
  END IF;
  
  UPDATE stock_issuance_requests
  SET status = 'REJECTED',
      rejection_reason = p_reason,
      updated_at = NOW()
  WHERE id = p_request_id;
  
  RETURN QUERY SELECT TRUE, 'Request rejected';
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION generate_approval_token TO anon;
GRANT EXECUTE ON FUNCTION create_stock_issuance_request TO anon;
GRANT EXECUTE ON FUNCTION approve_issuance_request TO anon;
GRANT EXECUTE ON FUNCTION reject_issuance_request TO anon;
