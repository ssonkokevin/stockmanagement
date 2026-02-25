-- ============================================
-- Add missing get_available_boxes function
-- ============================================

-- Drop existing functions first
DROP FUNCTION IF EXISTS get_available_boxes(UUID);
DROP FUNCTION IF EXISTS pick_sims_from_box(UUID, UUID, INTEGER, TEXT);

-- Function to get available boxes with remaining SIMs
CREATE FUNCTION get_available_boxes(p_mvno_id UUID DEFAULT NULL)
RETURNS TABLE(
  id UUID,
  box_number INTEGER,
  iccid_start VARCHAR(22),
  iccid_end VARCHAR(22),
  total_sims INTEGER,
  remaining_sims INTEGER,
  issued_sims INTEGER,
  status sim_status,
  mvno_id UUID,
  mvno_name TEXT,
  carton_number VARCHAR(10)
) 
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    b.id,
    b.box_number,
    b.iccid_start,
    b.iccid_end,
    b.total_sims,
    COALESCE(b.remaining_sims, b.total_sims) as remaining_sims,
    COALESCE(b.issued_sims, 0) as issued_sims,
    b.status::sim_status,
    b.mvno_id,
    m.name::TEXT,
    c.carton_number
  FROM boxes b
  JOIN cartons c ON b.carton_id = c.id
  JOIN mvnos m ON c.mvno_id = m.id
  WHERE (p_mvno_id IS NULL OR b.mvno_id = p_mvno_id)
    AND (b.remaining_sims IS NULL OR b.remaining_sims > 0)
  ORDER BY m.name, c.carton_number, b.box_number;
END;
$$;

-- Function to pick SIMs from a box
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

  -- Calculate ICCID range
  v_iccid_start := v_box.iccid_start;
  v_iccid_end := LPAD((v_box.iccid_start::BIGINT + p_quantity - 1)::TEXT, 20, '0');

  -- Update box remaining SIMs
  UPDATE boxes 
  SET remaining_sims = remaining_sims - p_quantity,
      issued_sims = COALESCE(issued_sims, 0) + p_quantity
  WHERE id = p_box_id;

  -- Record the pick
  INSERT INTO box_pick_records (box_id, distributor_id, quantity, iccid_start, iccid_end)
  VALUES (p_box_id, p_distributor_id, p_quantity, v_iccid_start, v_iccid_end);

  RETURN QUERY SELECT TRUE, 'Successfully picked ' || p_quantity || ' SIMs';
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_available_boxes(UUID) TO anon;
GRANT EXECUTE ON FUNCTION pick_sims_from_box(UUID, UUID, INTEGER, TEXT) TO anon;

-- Test the function
SELECT * FROM get_available_boxes(NULL) LIMIT 10;
