-- Fix ICCID range calculation in pick_sims_from_box function
-- Bug: The loop was running p_quantity times instead of (p_quantity - 1) times
-- Example: Picking 50 SIMs starting at 25501 should end at 25550, not 25551

-- Drop existing function
DROP FUNCTION IF EXISTS pick_sims_from_box(UUID, UUID, INTEGER, TEXT);

-- Recreate function with fixed ICCID calculation
CREATE FUNCTION pick_sims_from_box(
  p_box_id UUID,
  p_distributor_id UUID,
  p_quantity INTEGER,
  p_purpose TEXT DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, message TEXT) 
LANGUAGE plpgsql
AS $$
DECLARE
  v_box RECORD;
  v_mvno_id UUID;
  v_carton_number VARCHAR(10);
  v_box_number INTEGER;
  v_iccid_start TEXT;
  v_iccid_end TEXT;
  v_remaining INTEGER;
  v_i INTEGER;
  v_new_iccid TEXT;
BEGIN
  -- Get box details
  SELECT b.*, c.carton_number, m.id as mvno_id
  INTO v_box
  FROM boxes b
  JOIN cartons c ON b.carton_id = c.id
  JOIN mvnos m ON c.mvno_id = m.id
  WHERE b.id = p_box_id;

  IF v_box IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Box not found';
    RETURN;
  END IF;

  -- Check remaining SIMs
  v_remaining := COALESCE(v_box.remaining_sims, v_box.total_sims);
  IF v_remaining < p_quantity THEN
    RETURN QUERY SELECT FALSE, 'Insufficient SIMs in box. Available: ' || v_remaining;
    RETURN;
  END IF;

  -- Calculate ICCID range (handle as string to avoid BIGINT overflow)
  v_iccid_start := v_box.iccid_start;
  
  -- Fix: Calculate ICCID range correctly
  -- If picking 1 SIM: start = end = iccid_start (0 increments)
  -- If picking 50 SIMs: end = iccid_start + 49 (49 increments)
  v_new_iccid := v_iccid_start;
  
  -- Only increment if picking more than 1 SIM
  -- This gives us: start + (quantity - 1)
  IF p_quantity > 1 THEN
    FOR v_i IN 1..(p_quantity - 1) LOOP
      v_new_iccid := increment_iccid(v_new_iccid);
    END LOOP;
  END IF;
  
  v_iccid_end := v_new_iccid;

  -- Update box remaining SIMs
  UPDATE boxes 
  SET remaining_sims = remaining_sims - p_quantity,
      issued_sims = COALESCE(issued_sims, 0) + p_quantity
  WHERE id = p_box_id;

  -- Record the pick in box_pick_records table
  INSERT INTO box_pick_records (box_id, distributor_id, quantity, sims_picked, iccid_start, iccid_end)
  VALUES (p_box_id, p_distributor_id, p_quantity, p_quantity, v_iccid_start, v_iccid_end);

  RETURN QUERY SELECT TRUE, 'Successfully distributed ' || p_quantity || ' SIMs to distributor';
END
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION pick_sims_from_box(UUID, UUID, INTEGER, TEXT) TO anon;
