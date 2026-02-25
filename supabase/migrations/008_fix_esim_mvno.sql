-- ============================================
-- Fix eSIM MVNO assignments
-- ============================================

-- First, let's see what we have
SELECT 'MVNOs:' as info;
SELECT id, name FROM mvnos ORDER BY name;

SELECT 'Current eSIM counts by internal mvno_id:' as info;
SELECT mvno_id, COUNT(*) as count FROM esim_stock GROUP BY mvno_id;

-- Get the MVNO IDs
DO $$
DECLARE
  v_paxtel_id UUID;
  v_agrotel_id UUID;
  v_salamtel_id UUID;
  v_bcc_id UUID;
  v_count INTEGER;
BEGIN
  -- Get IDs
  SELECT id INTO v_paxtel_id FROM mvnos WHERE name = 'PAXTEL';
  SELECT id INTO v_agrotel_id FROM mvnos WHERE name = 'AGROTEL';
  SELECT id INTO v_salamtel_id FROM mvnos WHERE name = 'SALAMTEL';
  SELECT id INTO v_bcc_id FROM mvnos WHERE name = 'BCC';
  
  RAISE NOTICE 'Paxtel ID: %', v_paxtel_id;
  RAISE NOTICE 'Agrotel ID: %', v_agrotel_id;
  RAISE NOTICE 'Salamtel ID: %', v_salamtel_id;
  RAISE NOTICE 'BCC ID: %', v_bcc_id;

  -- First, clear all esim_stock
  DELETE FROM esim_stock WHERE true;

  -- Insert Paxtel eSIMs (1500 SIMs)
  -- IMSI: 641201100214184 to 641201100215683
  INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
  SELECT 
    LPAD((89256201000000000116 + (gs - 1))::TEXT, 20, '0'),
    (641201100214184 + (gs - 1))::BIGINT,
    v_paxtel_id,
    'IN_STORE'
  FROM generate_series(1, 1500) AS gs;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Inserted % Paxtel eSIMs', v_count;

  -- Insert Salamtel eSIMs (248 SIMs)
  -- IMSI: 641200019999504 to 641200019999751
  INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
  SELECT 
    LPAD((8925620100000015155 + (gs - 1))::TEXT, 20, '0'),
    (641200019999504 + (gs - 1))::BIGINT,
    v_salamtel_id,
    'IN_STORE'
  FROM generate_series(1, 248) AS gs;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Inserted % Salamtel eSIMs', v_count;

  -- Insert Agrotel eSIMs (248 SIMs)
  -- IMSI: 641200019999752 to 641200019999999
  INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
  SELECT 
    LPAD((8925620100000017631 + (gs - 1))::TEXT, 20, '0'),
    (641200019999752 + (gs - 1))::BIGINT,
    v_agrotel_id,
    'IN_STORE'
  FROM generate_series(1, 248) AS gs;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Inserted % Agrotel eSIMs', v_count;

  RAISE NOTICE 'Done!';
END $$;

-- Verify results
SELECT 
  m.name as mvno,
  COUNT(e.id) as total_esims
FROM mvnos m
LEFT JOIN esim_stock e ON e.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;

SELECT COUNT(*) as total FROM esim_stock;
