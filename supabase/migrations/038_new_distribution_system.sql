-- ============================================
-- New Distribution System with DB Transactions
-- ============================================
-- This migration:
-- 1. Creates a new function for distributing eSIMs with DB transaction
-- 2. Creates a new function for distributing Physical SIMs with DB transaction
-- 3. Removes dependency on quantity column from box_pick_records
-- 4. Adds new columns to box_pick_records for better tracking
-- ============================================

-- First, add columns to esim_stock for tracking distribution if they don't exist
ALTER TABLE esim_stock ADD COLUMN IF NOT EXISTS issued_to_distributor_id UUID REFERENCES distributors(id);
ALTER TABLE esim_stock ADD COLUMN IF NOT EXISTS issued_date TIMESTAMPTZ;
ALTER TABLE esim_stock ADD COLUMN IF NOT EXISTS distribution_id UUID;

-- Add distribution_id to box_pick_records for tracking (replaces quantity dependency)
ALTER TABLE box_pick_records ADD COLUMN IF NOT EXISTS distribution_id UUID;

-- Create function to distribute eSIMs with transaction
CREATE OR REPLACE FUNCTION distribute_esims(
  p_distributor_id UUID,
  p_mvno_id UUID,
  p_iccids TEXT[],  -- Array of ICCIDs to distribute
  p_purpose TEXT DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, message TEXT, distributed_count INTEGER) 
LANGUAGE plpgsql
AS $$
DECLARE
  v_distribution_id UUID := gen_random_uuid();
  v_count INTEGER := 0;
  v_iccid TEXT;
  v_operator TEXT;
BEGIN
  -- Get operator name from mvno
  SELECT m.name INTO v_operator FROM mvnos m WHERE m.id = p_mvno_id;
  
  -- Validate all ICCIDs are available first
  FOR v_iccid IN SELECT unnest(p_iccids) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM esim_stock 
      WHERE iccid = v_iccid 
      AND status = 'available'
    ) THEN
      RETURN QUERY SELECT FALSE, 'ICCID ' || v_iccid || ' is not available', 0;
      RETURN;
    END IF;
  END LOOP;

  -- Update all eSIMs in a single transaction
  UPDATE esim_stock 
  SET 
    status = 'assigned',
    issued_to_distributor_id = p_distributor_id,
    issued_date = NOW(),
    distribution_id = v_distribution_id
  WHERE iccid = ANY(p_iccids)
  AND status = 'available';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Record the distribution
  INSERT INTO box_pick_records (id, box_id, distributor_id, sims_picked, iccid_start, iccid_end, distribution_id)
  VALUES (v_distribution_id, NULL, p_distributor_id, v_count, p_iccids[1], p_iccids[array_length(p_iccids, 1)], v_distribution_id);

  RETURN QUERY SELECT TRUE, 'Successfully distributed ' || v_count || ' eSIMs', v_count;
END;
$$;

-- Create function to distribute Physical SIMs (single box) with transaction
CREATE OR REPLACE FUNCTION distribute_physical_box(
  p_distributor_id UUID,
  p_box_id UUID,
  p_quantity INTEGER,
  p_purpose TEXT DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, message TEXT) 
LANGUAGE plpgsql
AS $$
DECLARE
  v_box RECORD;
  v_distribution_id UUID := gen_random_uuid();
  v_iccid_start TEXT;
  v_iccid_end TEXT;
  v_new_iccid TEXT;
  v_i INTEGER;
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
  IF COALESCE(v_box.remaining_sims, v_box.total_sims) < p_quantity THEN
    RETURN QUERY SELECT FALSE, 'Insufficient SIMs in box. Available: ' || COALESCE(v_box.remaining_sims, v_box.total_sims);
    RETURN;
  END IF;

  -- Calculate ICCID range
  v_iccid_start := v_box.iccid_start;
  v_new_iccid := v_iccid_start;
  
  -- Increment ICCID (quantity - 1 times for correct range)
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

  -- Record the pick (no quantity column dependency)
  INSERT INTO box_pick_records (box_id, distributor_id, sims_picked, iccid_start, iccid_end, distribution_id)
  VALUES (p_box_id, p_distributor_id, p_quantity, v_iccid_start, v_iccid_end, v_distribution_id);

  RETURN QUERY SELECT TRUE, 'Successfully distributed ' || p_quantity || ' SIMs from box ' || v_box.box_number;
END;
$$;

-- Create function to distribute Physical SIMs from multiple boxes with transaction
CREATE OR REPLACE FUNCTION distribute_physical_boxes(
  p_distributor_id UUID,
  p_box_quantities JSONB,  -- Array of {box_id, quantity} objects
  p_purpose TEXT DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, message TEXT, total_distributed INTEGER) 
LANGUAGE plpgsql
AS $$
DECLARE
  v_distribution_id UUID := gen_random_uuid();
  v_item JSONB;
  v_box_id UUID;
  v_quantity INTEGER;
  v_box RECORD;
  v_iccid_start TEXT;
  v_iccid_end TEXT;
  v_new_iccid TEXT;
  v_i INTEGER;
  v_total INTEGER := 0;
  v_box_count INTEGER := 0;
BEGIN
  -- Process each box
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_box_quantities) LOOP
    v_box_id := (v_item->>'box_id')::UUID;
    v_quantity := (v_item->>'quantity')::INTEGER;

    -- Get box details
    SELECT b.*, c.carton_number
    INTO v_box
    FROM boxes b
    JOIN cartons c ON b.carton_id = c.id
    WHERE b.id = v_box_id;

    IF v_box IS NULL THEN
      RETURN QUERY SELECT FALSE, 'Box not found: ' || v_box_id, 0;
      RETURN;
    END IF;

    -- Check remaining SIMs
    IF COALESCE(v_box.remaining_sims, v_box.total_sims) < v_quantity THEN
      RETURN QUERY SELECT FALSE, 'Insufficient SIMs in box ' || v_box.box_number || '. Available: ' || COALESCE(v_box.remaining_sims, v_box.total_sims), v_total;
      RETURN;
    END IF;

    -- Calculate ICCID range
    v_iccid_start := v_box.iccid_start;
    v_new_iccid := v_iccid_start;
    
    IF v_quantity > 1 THEN
      FOR v_i IN 1..(v_quantity - 1) LOOP
        v_new_iccid := increment_iccid(v_new_iccid);
      END LOOP;
    END IF;
    v_iccid_end := v_new_iccid;

    -- Update box
    UPDATE boxes 
    SET remaining_sims = remaining_sims - v_quantity,
        issued_sims = COALESCE(issued_sims, 0) + v_quantity
    WHERE id = v_box_id;

    -- Record the pick
    INSERT INTO box_pick_records (box_id, distributor_id, sims_picked, iccid_start, iccid_end, distribution_id)
    VALUES (v_box_id, p_distributor_id, v_quantity, v_iccid_start, v_iccid_end, v_distribution_id);

    v_total := v_total + v_quantity;
    v_box_count := v_box_count + 1;
  END LOOP;

  RETURN QUERY SELECT TRUE, 'Successfully distributed ' || v_total || ' SIMs from ' || v_box_count || ' boxes', v_total;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION distribute_esims(UUID, UUID, TEXT[], TEXT) TO anon;
GRANT EXECUTE ON FUNCTION distribute_physical_box(UUID, UUID, INTEGER, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION distribute_physical_boxes(UUID, JSONB, TEXT) TO anon;
