-- ============================================
-- eSIM UPLOAD - Paxtel, Agrotel, Salamtel
-- FIX: Column order is (iccid, imsi) not (imsi, iccid)
-- ============================================

-- Enable RLS on esim_stock
ALTER TABLE esim_stock ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if exists and recreate
DROP POLICY IF EXISTS "Allow all for authenticated" ON esim_stock;
CREATE POLICY "Allow all for authenticated" ON esim_stock FOR ALL USING (true) WITH CHECK (true);

-- PAXTEL eSIMs - FIX: INSERT uses (iccid, imsi) column order
WITH paxtel_data(imsi, iccid) AS (
  VALUES
  ('641201100214184', '89256201000000000116'),
  ('641201100214185', '89256201000000000124'),
  ('641201100214186', '89256201000000000132')
  -- Add all Paxtel eSIMs: (imsi, iccid) - expand from your Paxtel esims.txt
)
INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
SELECT pd.iccid, pd.imsi::BIGINT, m.id, 'IN_STORE'
FROM paxtel_data pd
CROSS JOIN mvnos m WHERE m.name = 'PAXTEL'
ON CONFLICT (iccid) DO NOTHING;

-- AGROTEL eSIMs - same pattern
WITH agrotel_data(imsi, iccid) AS (
  VALUES ('641200019999752', '89256201000000017631'), ('641200019999753', '89256201000000017649')
  -- Add all Agrotel eSIMs from Agrotel esims.txt
)
INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
SELECT ad.iccid, ad.imsi::BIGINT, m.id, 'IN_STORE'
FROM agrotel_data ad
CROSS JOIN mvnos m WHERE m.name = 'AGROTEL'
ON CONFLICT (iccid) DO NOTHING;

-- SALAMTEL eSIMs - same pattern
WITH salamtel_data(imsi, iccid) AS (
  VALUES ('641200019999504', '89256201000000015155'), ('641200019999505', '89256201000000015163')
  -- Add all Salamtel eSIMs from Salamtel esims.txt
)
INSERT INTO esim_stock (iccid, imsi, mvno_id, status)
SELECT sd.iccid, sd.imsi::BIGINT, m.id, 'IN_STORE'
FROM salamtel_data sd
CROSS JOIN mvnos m WHERE m.name = 'SALAMTEL'
ON CONFLICT (iccid) DO NOTHING;
