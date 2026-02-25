-- ============================================
-- Check actual eSIM data and refresh the view
-- ============================================

-- Check what operators exist in esim_stock
SELECT 'Checking esim_stock table...' as info;
SELECT operator, COUNT(*) as count 
FROM esim_stock 
GROUP BY operator 
ORDER BY operator;

-- Check for any null or empty operators
SELECT 'Checking for null/empty operators...' as info;
SELECT COUNT(*) as null_count FROM esim_stock WHERE operator IS NULL;
SELECT COUNT(*) as empty_count FROM esim_stock WHERE operator = '';

-- Check total count
SELECT 'Total eSIMs:' as info, COUNT(*) as count FROM esim_stock;

-- Fix: Update any NULL operators to 'Unknown'
UPDATE esim_stock 
SET operator = 'Unknown' 
WHERE operator IS NULL OR operator = '';

-- Create a refreshed view with the current data
DROP VIEW IF EXISTS current_stock_view;

CREATE OR REPLACE VIEW current_stock_view AS
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
  
  -- Physical SIMs by MVNO
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
  
  -- eSIMs by operator (case-insensitive grouping)
  SELECT 
    INITCAP(LOWER(es.operator))::TEXT AS mvno,
    'ESIM'::TEXT AS sim_type,
    COUNT(*)::BIGINT AS total_stock,
    COUNT(*) FILTER (WHERE es.status = 'available')::BIGINT AS in_store,
    COUNT(*) FILTER (WHERE es.status = 'assigned')::BIGINT AS issued,
    COUNT(*) FILTER (WHERE es.status = 'activated')::BIGINT AS activated,
    0::BIGINT AS sold,
    0::BIGINT AS failed
  FROM esim_stock es
  WHERE es.operator IS NOT NULL AND es.operator != ''
  GROUP BY INITCAP(LOWER(es.operator))
) AS combined_stock
ORDER BY 
  CASE WHEN mvno = 'TOTAL' THEN 0 ELSE 1 END,
  sim_type,
  mvno;

-- Grant permissions
GRANT SELECT ON current_stock_view TO anon, authenticated;

-- Verify the view now
SELECT 'Current stock view (eSIM):' as info;
SELECT * FROM current_stock_view WHERE sim_type = 'ESIM' ORDER BY mvno;
