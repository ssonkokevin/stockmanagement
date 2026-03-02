-- Function to atomically allocate stock from boxes
-- This prevents race conditions when multiple admins approve simultaneously
CREATE OR REPLACE FUNCTION allocate_stock(
  p_request_id UUID,
  p_distributor_id UUID,
  p_mvno_id UUID,
  p_sim_type TEXT,
  p_quantity INTEGER,
  p_allocations JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $
DECLARE
  v_allocation JSONB;
  v_box_id UUID;
  v_allocated_qty INTEGER;
  v_current_sims INTEGER;
  v_current_issued INTEGER;
  v_total_allocated INTEGER := 0;
  v_previous_owner_type TEXT;
  v_previous_owner_id UUID;
BEGIN
  -- Validate allocations
  IF p_allocations IS NULL OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'No allocations provided';
  END IF;

  -- Verify total quantity matches
  FOR v_allocation IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_total_allocated := v_total_allocated + (v_allocation->>'quantity')::INTEGER;
  END LOOP;

  IF v_total_allocated != p_quantity THEN
    RAISE EXCEPTION 'Allocated quantity (%) does not match requested quantity (%)', v_total_allocated, p_quantity;
  END IF;

  -- Process each allocation
  FOR v_allocation IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_box_id := (v_allocation->>'box_id')::UUID;
    v_allocated_qty := (v_allocation->>'quantity')::INTEGER;

    -- Lock the row for update to prevent race conditions
    SELECT remaining_sims, issued_sims, owner_type, owner_id INTO v_current_sims, v_current_issued, v_previous_owner_type, v_previous_owner_id
    FROM boxes
    WHERE id = v_box_id
    FOR UPDATE;

    -- Validate sufficient stock
    IF v_current_sims < v_allocated_qty THEN
      RAISE EXCEPTION 'Insufficient stock in box %. Available: %, Requested: %', 
        v_box_id, v_current_sims, v_allocated_qty;
    END IF;

    -- Deduct stock AND transfer ownership to MVNO if coming from Hamilton
    UPDATE boxes
    SET remaining_sims = remaining_sims - v_allocated_qty,
        issued_sims = issued_sims + v_allocated_qty,
        -- Transfer ownership if was Hamilton-owned
        owner_type = CASE 
          WHEN owner_type = 'HAMILTON' THEN 'MVNO' 
          ELSE owner_type 
        END,
        owner_id = CASE 
          WHEN owner_type = 'HAMILTON' THEN p_mvno_id 
          ELSE owner_id 
        END,
        status = CASE
          WHEN remaining_sims - v_allocated_qty <= 0 THEN 'ISSUED'
          ELSE 'AVAILABLE'
        END
    WHERE id = v_box_id;
  END LOOP;

  -- Update request status
  UPDATE stock_requests
  SET status = 'APPROVED',
      assigned_box_ids = (SELECT array_agg((value->>'box_id')::UUID) FROM jsonb_array_elements(p_allocations)),
      updated_at = NOW()
  WHERE id = p_request_id;

  -- Create stock issuance record
  INSERT INTO stock_issuances (
    request_id,
    distributor_id,
    mvno_id,
    sim_type,
    quantity,
    carton_boxes,
    status,
    approved_at
  ) VALUES (
    p_request_id,
    p_distributor_id,
    p_mvno_id,
    p_sim_type,
    p_quantity,
    p_allocations::TEXT,
    'APPROVED',
    NOW()
  );

  RETURN TRUE;
END;
$;
