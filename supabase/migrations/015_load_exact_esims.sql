-- ============================================
-- Load Exact eSIM Data from CSV values
-- PAXTEL: 1500 eSIMs (IMSI 641201100214184 to 641201100215683)
-- SALAMTEL: 248 eSIMs (IMSI 641200019999504 to 641200019999751)
-- AGROTEL: 248 eSIMs (IMSI 641200019999752 to 641200019999999)
-- ============================================

DO $BODY$
DECLARE
  v_paxtel_id UUID;
  v_salamtel_id UUID;
  v_agrotel_id UUID;
  v_count INTEGER;
BEGIN
  -- Get MVNO IDs
  SELECT id INTO v_paxtel_id FROM mvnos WHERE name = 'PAXTEL';
  SELECT id INTO v_salamtel_id FROM mvnos WHERE name = 'SALAMTEL';
  SELECT id INTO v_agrotel_id FROM mvnos WHERE name = 'AGROTEL';

  RAISE NOTICE 'MVNO IDs - PAXTEL: %, SALAMTEL: %, AGROTEL: %', 
    v_paxtel_id, v_salamtel_id, v_agrotel_id;

  -- Delete existing eSIMs for these MVNOs
  DELETE FROM esim_stock WHERE mvno_id = v_paxtel_id;
  DELETE FROM esim_stock WHERE mvno_id = v_salamtel_id;
  DELETE FROM esim_stock WHERE mvno_id = v_agrotel_id;
  RAISE NOTICE 'Deleted existing eSIMs';

  -- Insert PAXTEL eSIMs (1500) - ICCID increments by 8 each row
  -- ICCID: 89256201000000000116 to 89256201000000015106 (20 digits)
  -- IMSI: 641201100214184 to 641201100215683
  INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
  SELECT 
    LPAD((89256201000000000116 + (gs - 1) * 8)::TEXT, 20, '0'),
    (641201100214184 + (gs - 1))::BIGINT,
    v_paxtel_id,
    'IN_STORE'
  FROM generate_series(1, 1500) AS gs;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Inserted PAXTEL eSIMs: %', v_count;

  -- Insert SALAMTEL eSIMs (248) - ICCID increments by 8 each row
  -- ICCID: 89256201000000015155 to 89256201000000017623 (20 digits)
  -- IMSI: 641200019999504 to 641200019999751
  INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
  SELECT 
    LPAD((89256201000000015155 + (gs - 1) * 8)::TEXT, 20, '0'),
    (641200019999504 + (gs - 1))::BIGINT,
    v_salamtel_id,
    'IN_STORE'
  FROM generate_series(1, 248) AS gs;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Inserted SALAMTEL eSIMs: %', v_count;

  -- Insert AGROTEL eSIMs (248) - ICCID increments by 8 each row
  -- ICCID: 89256201000000017631 to 89256201000000020106 (20 digits)
  -- IMSI: 641200019999752 to 641200019999999
  INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
  SELECT 
    LPAD((89256201000000017631 + (gs - 1) * 8)::TEXT, 20, '0'),
    (641200019999752 + (gs - 1))::BIGINT,
    v_agrotel_id,
    'IN_STORE'
  FROM generate_series(1, 248) AS gs;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Inserted AGROTEL eSIMs: %', v_count;

  -- Verify totals
  RAISE NOTICE '=== Verification ===';
  RAISE NOTICE 'PAXTEL total: %', (SELECT COUNT(*) FROM esim_stock WHERE mvno_id = v_paxtel_id);
  RAISE NOTICE 'SALAMTEL total: %', (SELECT COUNT(*) FROM esim_stock WHERE mvno_id = v_salamtel_id);
  RAISE NOTICE 'AGROTEL total: %', (SELECT COUNT(*) FROM esim_stock WHERE mvno_id = v_agrotel_id);
  RAISE NOTICE 'GRAND TOTAL: %', (SELECT COUNT(*) FROM esim_stock);

  -- Show sample data
  RAISE NOTICE '=== Sample PAXTEL eSIMs ===';
  SELECT iccid, imsi INTO v_count FROM esim_stock WHERE mvno_id = v_paxtel_id ORDER BY iccid LIMIT 1;
  RAISE NOTICE 'First PAXTEL ICCID: %', v_count;
  SELECT iccid INTO v_count FROM esim_stock WHERE mvno_id = v_paxtel_id ORDER BY iccid DESC LIMIT 1;
  RAISE NOTICE 'Last PAXTEL ICCID: %', v_count;

END $BODY$;
