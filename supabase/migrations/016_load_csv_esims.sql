-- ============================================
-- Load eSIM data from CSV into esim_stock table
-- This migration works with user's table structure:
-- - operator (VARCHAR) - PAXTEL, SALAMTEL, AGROTEL
-- - imsi (VARCHAR)
-- - iccid (VARCHAR)
-- - status (VARCHAR)
-- ============================================

-- Step 1: Add operator column if esim_stock table exists but lacks it
DO $BODY$
BEGIN
  -- Add operator column if table exists but column doesn't
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'esim_stock')
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'esim_stock' AND column_name = 'operator'
  ) THEN
    ALTER TABLE esim_stock ADD COLUMN operator VARCHAR(50);
    RAISE NOTICE 'Added operator column';
  END IF;
  
  -- Add imsi column if not exists
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'esim_stock')
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'esim_stock' AND column_name = 'imsi'
  ) THEN
    ALTER TABLE esim_stock ADD COLUMN imsi VARCHAR(20);
    RAISE NOTICE 'Added imsi column';
  END IF;
END $BODY$;

-- Step 2: Clear existing data (optional - comment out if you want to keep existing)
-- DELETE FROM esim_stock;

-- Step 3: Insert PAXTEL eSIMs (1500)
-- ICCID: 89256201000000000116 to 89256201000000015106 (increments by 8)
-- IMSI: 641201100214184 to 641201100215683
INSERT INTO esim_stock (operator, imsi, iccid, status)
SELECT 
  'PAXTEL',
  (641201100214184 + (gs - 1))::TEXT,
  LPAD((89256201000000000116 + (gs - 1) * 8)::TEXT, 20, '0'),
  'available'
FROM generate_series(1, 1500) AS gs;

-- Step 4: Insert SALAMTEL eSIMs (248)
-- ICCID: 89256201000000015155 to 89256201000000017623
-- IMSI: 641200019999504 to 641200019999751
INSERT INTO esim_stock (operator, imsi, iccid, status)
SELECT 
  'SALAMTEL',
  (641200019999504 + (gs - 1))::TEXT,
  LPAD((89256201000000015155 + (gs - 1) * 8)::TEXT, 20, '0'),
  'available'
FROM generate_series(1, 248) AS gs;

-- Step 5: Insert AGROTEL eSIMs (248)
-- ICCID: 89256201000000017631 to 89256201000000020106
-- IMSI: 641200019999752 to 641200019999999
INSERT INTO esim_stock (operator, imsi, iccid, status)
SELECT 
  'AGROTEL',
  (641200019999752 + (gs - 1))::TEXT,
  LPAD((89256201000000017631 + (gs - 1) * 8)::TEXT, 20, '0'),
  'available'
FROM generate_series(1, 248) AS gs;

-- Step 6: Verify
SELECT 
  operator,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE status = 'available') AS available,
  COUNT(*) FILTER (WHERE status = 'assigned') AS assigned,
  COUNT(*) FILTER (WHERE status = 'activated') AS activated
FROM esim_stock
GROUP BY operator
ORDER BY operator;

-- Total count
SELECT COUNT(*) AS total_esims FROM esim_stock;
