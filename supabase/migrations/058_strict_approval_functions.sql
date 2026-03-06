-- ============================================
-- Strict State Machine Approval Functions
-- Backend enforces status transitions with guards
-- ============================================

-- ============================================
-- Level 1 Approval Function
-- PATCH /stock-requests/:id/approve-level-1
-- ============================================
CREATE OR REPLACE FUNCTION approve_level_1(
  p_request_id UUID,
  p_approver_id UUID,
  p_approver_email VARCHAR,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request RECORD;
  v_old_status VARCHAR;
BEGIN
  -- Get current request
  SELECT * INTO v_request
  FROM stock_issuance_requests
  WHERE id = p_request_id;
  
  IF v_request IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found';
    RETURN;
  END IF;
  
  -- STRICT STATE GUARD: Only allow if current status is PENDING
  IF v_request.status != 'PENDING' THEN
    RETURN QUERY SELECT FALSE, 
      format('Invalid status transition. Current status is %s, but must be PENDING to approve at Level 1', v_request.status);
    RETURN;
  END IF;
  
  -- Store old status for audit
  v_old_status := v_request.status;
  
  -- Update to LEVEL_1_APPROVED
  UPDATE stock_issuance_requests
  SET status = 'LEVEL_1_APPROVED',
      level_1_approver_id = p_approver_id,
      level_1_approver_email = p_approver_email,
      level_1_approved_at = NOW(),
      notes = COALESCE(p_notes, notes),
      updated_at = NOW()
  WHERE id = p_request_id;
  
  -- Log the transition
  PERFORM log_stock_request_transition(
    p_request_id,
    'LEVEL_1_APPROVED',
    p_approver_id,
    p_approver_email,
    v_old_status,
    'LEVEL_1_APPROVED',
    p_notes
  );
  
  RETURN QUERY SELECT TRUE, 'Level 1 approval successful';
END;
$$;

GRANT EXECUTE ON FUNCTION approve_level_1 TO anon, authenticated;

-- ============================================
-- Level 2 Approval Function
-- PATCH /stock-requests/:id/approve-level-2
-- ============================================
CREATE OR REPLACE FUNCTION approve_level_2(
  p_request_id UUID,
  p_approver_id UUID,
  p_approver_email VARCHAR,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request RECORD;
  v_old_status VARCHAR;
BEGIN
  -- Get current request
  SELECT * INTO v_request
  FROM stock_issuance_requests
  WHERE id = p_request_id;
  
  IF v_request IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found';
    RETURN;
  END IF;
  
  -- STRICT STATE GUARD: Only allow if current status is LEVEL_1_APPROVED
  IF v_request.status != 'LEVEL_1_APPROVED' THEN
    RETURN QUERY SELECT FALSE, 
      format('Invalid status transition. Current status is %s, but must be LEVEL_1_APPROVED to approve at Level 2', v_request.status);
    RETURN;
  END IF;
  
  -- Store old status for audit
  v_old_status := v_request.status;
  
  -- Update to LEVEL_2_APPROVED
  UPDATE stock_issuance_requests
  SET status = 'LEVEL_2_APPROVED',
      level_2_approver_id = p_approver_id,
      level_2_approver_email = p_approver_email,
      level_2_approved_at = NOW(),
      notes = COALESCE(p_notes, notes),
      updated_at = NOW()
  WHERE id = p_request_id;
  
  -- Log the transition
  PERFORM log_stock_request_transition(
    p_request_id,
    'LEVEL_2_APPROVED',
    p_approver_id,
    p_approver_email,
    v_old_status,
    'LEVEL_2_APPROVED',
    p_notes
  );
  
  RETURN QUERY SELECT TRUE, 'Level 2 approval successful';
END;
$$;

GRANT EXECUTE ON FUNCTION approve_level_2 TO anon, authenticated;

-- ============================================
-- Final Issue (Complete) Function
-- PATCH /stock-requests/:id/issue
-- ============================================
CREATE OR REPLACE FUNCTION issue_stock(
  p_request_id UUID,
  p_issuer_id UUID,
  p_issuer_email VARCHAR,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request RECORD;
  v_old_status VARCHAR;
BEGIN
  -- Get current request
  SELECT * INTO v_request
  FROM stock_issuance_requests
  WHERE id = p_request_id;
  
  IF v_request IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found';
    RETURN;
  END IF;
  
  -- STRICT STATE GUARD: Only allow if current status is LEVEL_2_APPROVED
  IF v_request.status != 'LEVEL_2_APPROVED' THEN
    RETURN QUERY SELECT FALSE, 
      format('Invalid status transition. Current status is %s, but must be LEVEL_2_APPROVED to issue stock', v_request.status);
    RETURN;
  END IF;
  
  -- Store old status for audit
  v_old_status := v_request.status;
  
  -- Update to COMPLETED
  UPDATE stock_issuance_requests
  SET status = 'COMPLETED',
      completion_record = jsonb_build_object(
        'issued_at', NOW(),
        'issued_by', p_issuer_id,
        'issued_by_email', p_issuer_email,
        'notes', p_notes
      ),
      notes = COALESCE(p_notes, notes),
      updated_at = NOW()
  WHERE id = p_request_id;
  
  -- Log the transition
  PERFORM log_stock_request_transition(
    p_request_id,
    'COMPLETED',
    p_issuer_id,
    p_issuer_email,
    v_old_status,
    'COMPLETED',
    p_notes
  );
  
  RETURN QUERY SELECT TRUE, 'Stock issued successfully';
END;
$$;

GRANT EXECUTE ON FUNCTION issue_stock TO anon, authenticated;

-- ============================================
-- Assign Stock (Box/eSIM) Function
-- NOTE: This does NOT change status - stays PENDING
-- ============================================
CREATE OR REPLACE FUNCTION assign_stock(
  p_request_id UUID,
  p_assigned_box_ids UUID[] DEFAULT NULL,
  p_assigned_box_quantities JSONB DEFAULT NULL,
  p_assigned_esim_iccids TEXT[] DEFAULT NULL,
  p_sim_type VARCHAR DEFAULT NULL,
  p_mvno_id UUID DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_request RECORD;
BEGIN
  -- Get current request
  SELECT * INTO v_request
  FROM stock_issuance_requests
  WHERE id = p_request_id;
  
  IF v_request IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Request not found';
    RETURN;
  END IF;
  
  -- NOTE: We DO NOT change status here!
  -- Status must remain PENDING - approvals are handled separately
  -- This is critical: assigning carton/box must NOT change status
  
  UPDATE stock_issuance_requests
  SET 
    -- Only update fields that are provided
    assigned_box_ids = COALESCE(p_assigned_box_ids, assigned_box_ids),
    assigned_box_quantities = COALESCE(p_assigned_box_quantities, assigned_box_quantities),
    assigned_esim_iccids = COALESCE(p_assigned_esim_iccids, assigned_esim_iccids),
    sim_type = COALESCE(p_sim_type, sim_type),
    mvno_id = COALESCE(p_mvno_id, mvno_id),
    notes = COALESCE(p_notes, notes),
    updated_at = NOW()
  WHERE id = p_request_id;
  
  -- Log the assignment
  PERFORM log_stock_request_transition(
    p_request_id,
    'ASSIGNED',
    NULL,
    NULL,
    v_request.status,  -- Status doesn't change
    v_request.status,
    'Stock boxes/ESIMs assigned'
  );
  
  RETURN QUERY SELECT TRUE, 'Stock assigned successfully. Status remains PENDING.';
END;
$$;

GRANT EXECUTE ON FUNCTION assign_stock TO anon, authenticated;
