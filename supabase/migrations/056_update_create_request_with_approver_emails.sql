-- Migration: Add level 1 and level 2 approver email parameters to create_stock_issuance_request

-- Add level_2 columns if they don't exist
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS level_2_approval_token TEXT;
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS level_2_token_expires TIMESTAMPTZ;
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS level_1_approver_email TEXT;
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS level_2_approver_email TEXT;

-- Drop the old 5-parameter function
DROP FUNCTION IF EXISTS create_stock_issuance_request(UUID, UUID, VARCHAR, INTEGER, TEXT);

-- Create new function with 7 parameters including approver emails
CREATE OR REPLACE FUNCTION create_stock_issuance_request(
  p_mvno_id UUID,
  p_requester_id UUID,
  p_sim_type VARCHAR,
  p_quantity INTEGER,
  p_notes TEXT DEFAULT NULL,
  p_level_1_approver_email TEXT DEFAULT NULL,
  p_level_2_approver_email TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_request_id UUID := gen_random_uuid();
  v_level1_token TEXT;
  v_level2_token TEXT;
BEGIN
  v_level1_token := generate_approval_token();
  v_level2_token := generate_approval_token();
  
  INSERT INTO stock_issuance_requests (
    id, mvno_id, requester_id, sim_type, quantity, 
    status, 
    level_1_approval_token, level_1_token_expires,
    level_2_approval_token, level_2_token_expires,
    level_1_approver_email, level_2_approver_email,
    notes
  )
  VALUES (
    v_request_id, p_mvno_id, p_requester_id, p_sim_type, p_quantity,
    'PENDING', 
    v_level1_token, NOW() + INTERVAL '48 hours',
    v_level2_token, NOW() + INTERVAL '48 hours',
    p_level_1_approver_email, p_level_2_approver_email,
    p_notes
  );
  
  RETURN v_request_id;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION create_stock_issuance_request TO anon;
GRANT EXECUTE ON FUNCTION create_stock_issuance_request TO authenticated;
