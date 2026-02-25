-- ============================================
-- Fix Box Numbering - Calculate carton from box number
-- Carton = CEIL(box_number / 20) with total based on MVNO
-- Box display = x/total_boxes (e.g., x/800 for PAXTEL, x/200 for SALAMTEL/AGROTEL)
-- ============================================

DO $$
DECLARE
  v_mvno RECORD;
  v_carton RECORD;
  v_box RECORD;
  v_count INT := 0;
  v_current_mvno_id UUID;
  v_current_carton_id UUID;
BEGIN
  RAISE NOTICE 'Starting box numbering fix...';

  -- Process each MVNO separately
  FOR v_mvno IN 
    SELECT id, name FROM mvnos ORDER BY name
  LOOP
    RAISE NOTICE 'Processing MVNO: %', v_mvno.name;
    v_count := 0;
    v_current_mvno_id := v_mvno.id;
    
    -- Get all cartons for this MVNO in order
    FOR v_carton IN 
      SELECT c.id as carton_id, c.carton_number
      FROM cartons c
      WHERE c.mvno_id = v_current_mvno_id
      ORDER BY c.carton_number
    LOOP
      RAISE NOTICE 'Processing carton: %', v_carton.carton_number;
      v_current_carton_id := v_carton.carton_id;
      
      -- Get existing boxes in this carton and update to sequential numbers
      FOR v_box IN 
        SELECT b.id, b.iccid_start, 
               ROW_NUMBER() OVER (ORDER BY b.iccid_start) as row_num
        FROM boxes b
        WHERE b.carton_id = v_current_carton_id
      LOOP
        v_count := v_count + 1;
        
        UPDATE boxes 
        SET box_number = v_count,
            mvno_id = v_current_mvno_id
        WHERE id = v_box.id;
        
        RAISE NOTICE 'Updated box to number % in carton %', v_count, v_carton.carton_number;
      END LOOP;
    END LOOP;
    
    RAISE NOTICE 'MVNO % has % boxes total', v_mvno.name, v_count;
  END LOOP;

  -- Update cartons table to show total boxes per carton
  UPDATE cartons c
  SET total_boxes = (
    SELECT COUNT(*) FROM boxes b WHERE b.carton_id = c.id
  );

  -- Ensure mvno_id is set for all boxes
  UPDATE boxes b
  SET mvno_id = c.mvno_id
  FROM cartons c
  WHERE b.carton_id = c.id
  AND (b.mvno_id IS NULL OR b.mvno_id != c.mvno_id);

  -- Ensure remaining_sims is set for all boxes
  UPDATE boxes
  SET remaining_sims = COALESCE(remaining_sims, total_sims)
  WHERE remaining_sims IS NULL;

  -- Ensure issued_sims is set for all boxes
  UPDATE boxes
  SET issued_sims = COALESCE(issued_sims, 0)
  WHERE issued_sims IS NULL;

  RAISE NOTICE 'Box numbering fix complete!';

END $$;

-- ============================================
-- Create box_stock_summary view for frontend
-- Calculate carton number and box display dynamically based on MVNO
-- PAXTEL: Carton = CEIL(box_number/20) with total 40, Box = x/800
-- SALAMTEL: Carton = CEIL(box_number/20) with total 10, Box = x/200
-- AGROTEL: Carton = CEIL(box_number/20) with total 10, Box = x/200
-- ============================================
DROP VIEW IF EXISTS box_stock_summary;

CREATE OR REPLACE VIEW box_stock_summary AS
SELECT 
  b.id as box_id,
  -- Carton number: current carton / total cartons
  -- PAXTEL: 40 cartons, SALAMTEL: 10 cartons, AGROTEL: 10 cartons
  CASE m.name
    WHEN 'PAXTEL' THEN CONCAT(CEIL(b.box_number::numeric / 20)::text, '/40')
    WHEN 'SALAMTEL' THEN CONCAT(CEIL(b.box_number::numeric / 20)::text, '/10')
    WHEN 'AGROTEL' THEN CONCAT(CEIL(b.box_number::numeric / 20)::text, '/10')
    ELSE CONCAT(CEIL(b.box_number::numeric / 20)::text, '/', 
      (SELECT COUNT(*)::text FROM cartons c2 WHERE c2.mvno_id = m.id))
  END as carton_number,
  -- Box number: sequential across all cartons
  b.box_number,
  -- Box display: x/total_boxes (e.g., x/800 for PAXTEL, x/200 for SALAMTEL/AGROTEL)
  CASE m.name
    WHEN 'PAXTEL' THEN CONCAT(b.box_number::text, '/800')
    WHEN 'SALAMTEL' THEN CONCAT(b.box_number::text, '/200')
    WHEN 'AGROTEL' THEN CONCAT(b.box_number::text, '/200')
    ELSE CONCAT(b.box_number::text, '/', 
      (SELECT COUNT(*)::text FROM boxes b2 
       JOIN cartons c2 ON b2.carton_id = c2.id 
       WHERE c2.mvno_id = m.id))
  END as box_display,
  m.name as mvno,
  b.iccid_start,
  b.iccid_end,
  b.total_sims,
  COALESCE(b.remaining_sims, b.total_sims) as remaining_sims,
  COALESCE(b.issued_sims, 0) as issued_sims,
  CASE 
    WHEN b.remaining_sims IS NULL OR b.remaining_sims = b.total_sims THEN 100
    ELSE ROUND((b.remaining_sims::NUMERIC / b.total_sims::NUMERIC) * 100, 1)
  END as remaining_percent,
  b.status
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
ORDER BY m.name, b.box_number;

-- Grant access
GRANT SELECT ON box_stock_summary TO anon, authenticated;

-- Verify the view
SELECT * FROM box_stock_summary LIMIT 20;
