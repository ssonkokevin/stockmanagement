-- ============================================
-- Insert missing eSIM data for SALAMTEL and AGROTEL
-- Current database only has 1000 PAXTEL eSIMs, missing 248 SALAMTEL + 248 AGROTEL
-- ============================================

-- Check current state
SELECT 'Current eSIM count' as check, COUNT(*) as count FROM esim_stock;
SELECT operator, COUNT(*) as count FROM esim_stock GROUP BY operator ORDER BY operator;

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

-- Verify the data after insert
SELECT 'Updated eSIM count' as check, COUNT(*) as count FROM esim_stock;
SELECT operator, COUNT(*) as count FROM esim_stock GROUP BY operator ORDER BY operator;

-- Refresh the views
DROP MATERIALIZED VIEW IF EXISTS current_stock_view;
CREATE MATERIALIZED VIEW current_stock_view AS
SELECT * FROM (
  -- TOTAL row - Physical SIMs (all MVNOs)
  SELECT 
    'TOTAL'::TEXT AS mvno, 
    'PHYSICAL'::TEXT AS sim_type,
    COALESCE(SUM(b.total_sims), 0) AS total_stock,
    COALESCE(SUM(b.remaining_sims), 0) AS in_store,
    COALESCE(SUM(b.issued_sims), 0) AS issued,
    0::BIGINT AS activated,
    0::BIGINT AS sold,
    0::BIGINT AS failed
  FROM boxes b
  WHERE b.mvno_id IS NOT NULL
  
  UNION ALL
  
  -- Physical SIMs by MVNO (using mvno_id directly)
  SELECT 
    m.name::TEXT AS mvno, 
    'PHYSICAL'::TEXT AS sim_type,
    COALESCE(SUM(b.total_sims), 0) AS total_stock,
    COALESCE(SUM(b.remaining_sims), 0) AS in_store,
    COALESCE(SUM(b.issued_sims), 0) AS issued,
    0::BIGINT AS activated,
    0::BIGINT AS sold,
    0::BIGINT AS failed
  FROM boxes b
  JOIN mvnos m ON b.mvno_id = m.id
  WHERE b.mvno_id IS NOT NULL
  GROUP BY m.name
  
  UNION ALL
  
  -- TOTAL row - eSIMs
  SELECT 
    'TOTAL'::TEXT AS mvno,
    'ESIM'::TEXT AS sim_type,
    COUNT(*)::BIGINT AS total_stock,
    COUNT(*) FILTER (WHERE es.status = 'available')::BIGINT AS in_store,
    COUNT(*) FILTER (WHERE es.status = 'assigned')::BIGINT AS issued,
    COUNT(*) FILTER (WHERE es.status = 'activated')::BIGINT AS activated,
    0::BIGINT AS sold,
    0::BIGINT AS failed
  FROM esim_stock es
  
  UNION ALL
  
  -- eSIMs by operator
  SELECT 
    es.operator::TEXT AS mvno,
    'ESIM'::TEXT AS sim_type,
    COUNT(*)::BIGINT AS total_stock,
    COUNT(*) FILTER (WHERE es.status = 'available')::BIGINT AS in_store,
    COUNT(*) FILTER (WHERE es.status = 'assigned')::BIGINT AS issued,
    COUNT(*) FILTER (WHERE es.status = 'activated')::BIGINT AS activated,
    0::BIGINT AS sold,
    0::BIGINT AS failed
  FROM esim_stock es
  WHERE es.operator IS NOT NULL
  GROUP BY es.operator
) AS combined_stock
ORDER BY 
  CASE WHEN mvno = 'TOTAL' THEN 0 ELSE 1 END,
  sim_type,
  mvno;

-- Grant permissions
GRANT SELECT ON current_stock_view TO anon, authenticated;

-- Verify the view
SELECT * FROM current_stock_view WHERE sim_type = 'ESIM' ORDER BY mvno;
