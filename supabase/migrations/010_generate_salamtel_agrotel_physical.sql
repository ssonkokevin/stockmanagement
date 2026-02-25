-- ============================================
-- Generate Physical SIM Stock for Salamtel and Agrotel
-- Each: 50K SIMs = 10 cartons x 20 boxes x 250 SIMs
-- Using TEXT only - NO BIGINT operations on ICCID
-- ============================================

DO $$
DECLARE
  v_salamtel_id UUID;
  v_agrotel_id UUID;
  v_carton_idx INT;
  v_box_idx INT;
  v_carton_id_val UUID;
  
  -- Use TEXT for all ICCID operations
  v_carton_iccid_start TEXT;
  v_carton_iccid_end TEXT;
  v_box_iccid_start TEXT;
  v_box_iccid_end TEXT;
  
  -- Use BIGINT for IMSI (these fit)
  v_imsi_start BIGINT;
  v_imsi_end BIGINT;
  
  v_count INT := 0;
BEGIN
  -- Get MVNO IDs
  SELECT id INTO v_salamtel_id FROM mvnos WHERE name = 'SALAMTEL';
  SELECT id INTO v_agrotel_id FROM mvnos WHERE name = 'AGROTEL';
  
  RAISE NOTICE 'Salamtel ID: %, Agrotel ID: %', v_salamtel_id, v_agrotel_id;
  
  -- Check if Salamtel cartons already exist
  IF EXISTS (SELECT 1 FROM cartons WHERE mvno_id = v_salamtel_id LIMIT 1) THEN
    RAISE NOTICE 'Salamtel cartons already exist - skipping';
  ELSE
    -- Generate 10 cartons for Salamtel
    FOR v_carton_idx IN 1..10 LOOP
      -- Calculate IMSI (these fit in BIGINT)
      v_imsi_start := 641200030000050 + (v_carton_idx - 1) * 5000;
      v_imsi_end := v_imsi_start + 4999;
      
      -- ICCID format: 892562000000XXXXXXX (20 digits total)
      -- Salamtel: use 4000000 + carton_offset
      v_carton_iccid_start := '8925620000004' || LPAD(((v_carton_idx - 1) * 5000 + 51)::TEXT, 7, '0');
      v_carton_iccid_end := '8925620000004' || LPAD(((v_carton_idx - 1) * 5000 + 51 + 4999)::TEXT, 7, '0');
      
      INSERT INTO cartons (carton_number, mvno_id, imsi_start, imsi_end, iccid_start, iccid_end, total_boxes, sims_per_box)
      VALUES (
        'SAL-' || v_carton_idx || '/10',
        v_salamtel_id,
        v_imsi_start,
        v_imsi_end,
        v_carton_iccid_start,
        v_carton_iccid_end,
        20,
        250
      ) RETURNING id INTO v_carton_id_val;
      
      -- Generate 20 boxes per carton
      FOR v_box_idx IN 1..20 LOOP
        v_imsi_start := 641200030000050 + (v_carton_idx - 1) * 5000 + (v_box_idx - 1) * 250;
        v_imsi_end := v_imsi_start + 249;
        
        -- Box ICCID range (20 digits)
        v_box_iccid_start := '8925620000004' || LPAD(((v_carton_idx - 1) * 5000 + (v_box_idx - 1) * 250 + 51)::TEXT, 7, '0');
        v_box_iccid_end := '8925620000004' || LPAD(((v_carton_idx - 1) * 5000 + (v_box_idx - 1) * 250 + 51 + 249)::TEXT, 7, '0');
        
        INSERT INTO boxes (carton_id, box_number, iccid_start, iccid_end, imsi_start, imsi_end, total_sims, status, remaining_sims, issued_sims)
        VALUES (
          v_carton_id_val,
          v_box_idx,
          v_box_iccid_start,
          v_box_iccid_end,
          v_imsi_start,
          v_imsi_end,
          250,
          'IN_STORE',
          250,
          0
        );
        
        v_count := v_count + 1;
      END LOOP;
      
      RAISE NOTICE 'Created Salamtel carton % with 20 boxes', v_carton_idx;
    END LOOP;
    RAISE NOTICE 'Created % Salamtel boxes total', v_count;
  END IF;
  
  -- Check if Agrotel cartons already exist
  v_count := 0;
  IF EXISTS (SELECT 1 FROM cartons WHERE mvno_id = v_agrotel_id LIMIT 1) THEN
    RAISE NOTICE 'Agrotel cartons already exist - skipping';
  ELSE
    -- Generate 10 cartons for Agrotel
    FOR v_carton_idx IN 1..10 LOOP
      -- Calculate IMSI (these fit in BIGINT)
      v_imsi_start := 641200040000050 + (v_carton_idx - 1) * 5000;
      v_imsi_end := v_imsi_start + 4999;
      
      -- ICCID format: 8925620000005XXXXXXX (20 digits total)
      -- Agrotel: use 5000000 + carton_offset
      v_carton_iccid_start := '8925620000005' || LPAD(((v_carton_idx - 1) * 5000 + 51)::TEXT, 7, '0');
      v_carton_iccid_end := '8925620000005' || LPAD(((v_carton_idx - 1) * 5000 + 51 + 4999)::TEXT, 7, '0');
      
      INSERT INTO cartons (carton_number, mvno_id, imsi_start, imsi_end, iccid_start, iccid_end, total_boxes, sims_per_box)
      VALUES (
        'AGR-' || v_carton_idx || '/10',
        v_agrotel_id,
        v_imsi_start,
        v_imsi_end,
        v_carton_iccid_start,
        v_carton_iccid_end,
        20,
        250
      ) RETURNING id INTO v_carton_id_val;
      
      -- Generate 20 boxes per carton
      FOR v_box_idx IN 1..20 LOOP
        v_imsi_start := 641200040000050 + (v_carton_idx - 1) * 5000 + (v_box_idx - 1) * 250;
        v_imsi_end := v_imsi_start + 249;
        
        -- Box ICCID range (20 digits)
        v_box_iccid_start := '8925620000005' || LPAD(((v_carton_idx - 1) * 5000 + (v_box_idx - 1) * 250 + 51)::TEXT, 7, '0');
        v_box_iccid_end := '8925620000005' || LPAD(((v_carton_idx - 1) * 5000 + (v_box_idx - 1) * 250 + 51 + 249)::TEXT, 7, '0');
        
        INSERT INTO boxes (carton_id, box_number, iccid_start, iccid_end, imsi_start, imsi_end, total_sims, status, remaining_sims, issued_sims)
        VALUES (
          v_carton_id_val,
          v_box_idx,
          v_box_iccid_start,
          v_box_iccid_end,
          v_imsi_start,
          v_imsi_end,
          250,
          'IN_STORE',
          250,
          0
        );
        
        v_count := v_count + 1;
      END LOOP;
      
      RAISE NOTICE 'Created Agrotel carton % with 20 boxes', v_carton_idx;
    END LOOP;
    RAISE NOTICE 'Created % Agrotel boxes total', v_count;
  END IF;
  
  RAISE NOTICE 'Physical SIM stock generation complete!';
END $$;

-- Verify the results
SELECT 
  m.name as mvno,
  COUNT(DISTINCT c.id) as cartons,
  COUNT(b.id) as boxes,
  SUM(b.total_sims) as total_sims
FROM mvnos m
LEFT JOIN cartons c ON c.mvno_id = m.id
LEFT JOIN boxes b ON b.carton_id = c.id
GROUP BY m.name
ORDER BY m.name;

-- Check box ICCID ranges
SELECT 
  m.name as mvno,
  c.carton_number,
  b.box_number,
  b.iccid_start,
  b.iccid_end,
  b.remaining_sims,
  b.issued_sims
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
WHERE m.name IN ('SALAMTEL', 'AGROTEL')
ORDER BY m.name, c.carton_number, b.box_number
LIMIT 20;
