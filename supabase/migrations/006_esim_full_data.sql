-- ============================================
-- eSIM STOCK - Insert all Paxtel, Agrotel, Salamtel eSIMs
-- Using generate_series with proper BIGINT casting
-- ============================================

-- First, clear existing eSIM data to avoid duplicates
DELETE FROM esim_stock WHERE true;

-- Get MVNO IDs
DO $$
DECLARE
  v_paxtel_id UUID;
  v_agrotel_id UUID;
  v_salamtel_id UUID;
BEGIN
  SELECT id INTO v_paxtel_id FROM mvnos WHERE name = 'PAXTEL';
  SELECT id INTO v_agrotel_id FROM mvnos WHERE name = 'AGROTEL';
  SELECT id INTO v_salamtel_id FROM mvnos WHERE name = 'SALAMTEL';
  
  RAISE NOTICE 'Paxtel: %, Agrotel: %, Salamtel: %', v_paxtel_id, v_agrotel_id, v_salamtel_id;

  -- ========================================
  -- PAXTEL eSIMs: 1500 SIMs (641201100214184 to 641201100215683)
  -- ========================================
  
  INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
  SELECT 
    LPAD((89256201000000000116 + (gs - 1))::TEXT, 20, '0'),
    (641201100214184 + (gs - 1))::BIGINT,
    v_paxtel_id,
    'IN_STORE'
  FROM generate_series(1, 1500) AS gs;

  RAISE NOTICE 'Paxtel eSIMs inserted';

  -- ========================================
  -- SALAMTEL eSIMs: 248 SIMs (641200019999504 to 641200019999751)
  -- ========================================
  
  INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
  SELECT 
    LPAD((8925620100000015155 + (gs - 1))::TEXT, 20, '0'),
    (641200019999504 + (gs - 1))::BIGINT,
    v_salamtel_id,
    'IN_STORE'
  FROM generate_series(1, 248) AS gs;

  RAISE NOTICE 'Salamtel eSIMs inserted';

  -- ========================================
  -- AGROTEL eSIMs: 248 SIMs (641200019999752 to 641200019999999)
  -- ========================================
  
  INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
  SELECT 
    LPAD((8925620100000017631 + (gs - 1))::TEXT, 20, '0'),
    (641200019999752 + (gs - 1))::BIGINT,
    v_agrotel_id,
    'IN_STORE'
  FROM generate_series(1, 248) AS gs;

  RAISE NOTICE 'Agrotel eSIMs inserted';
  RAISE NOTICE 'All eSIMs inserted successfully!';
END $$;
