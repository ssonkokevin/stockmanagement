-- ============================================
-- Insert exact eSIM data: 1996 total (1500 PAXTEL + 248 SALAMTEL + 248 AGROTEL)
-- All status = 'available' since nothing issued yet
-- ============================================

-- First clear existing data and insert correct amounts
TRUNCATE TABLE esim_stock RESTART IDENTITY;

-- Insert PAXTEL eSIMs (1500 records) - all available
INSERT INTO esim_stock (operator, imsi, iccid, status)
SELECT 
  'PAXTEL' as operator,
  '63970' || LPAD((1000000000000 + generate_series)::TEXT, 13, '0') as imsi,
  '890141000' || LPAD((100000000000 + generate_series)::TEXT, 12, '0') as iccid,
  'available' as status
FROM generate_series(1, 1500);

-- Insert SALAMTEL eSIMs (248 records) - all available
INSERT INTO esim_stock (operator, imsi, iccid, status)
SELECT 
  'SALAMTEL' as operator,
  '63971' || LPAD((1000000000000 + generate_series)::TEXT, 13, '0') as imsi,
  '890141000' || LPAD((200000000000 + generate_series)::TEXT, 12, '0') as iccid,
  'available' as status
FROM generate_series(1, 248);

-- Insert AGROTEL eSIMs (248 records) - all available
INSERT INTO esim_stock (operator, imsi, iccid, status)
SELECT 
  'AGROTEL' as operator,
  '63972' || LPAD((1000000000000 + generate_series)::TEXT, 13, '0') as imsi,
  '890141000' || LPAD((300000000000 + generate_series)::TEXT, 12, '0') as iccid,
  'available' as status
FROM generate_series(1, 248);

-- Verify the data
SELECT 'Total eSIMs' as check_name, COUNT(*) as count FROM esim_stock;
SELECT operator, COUNT(*) as count FROM esim_stock GROUP BY operator ORDER BY operator;
SELECT * FROM total_esim_stock;
SELECT * FROM esim_stock_by_operator;
SELECT * FROM current_stock_view WHERE sim_type = 'ESIM' ORDER BY mvno;
