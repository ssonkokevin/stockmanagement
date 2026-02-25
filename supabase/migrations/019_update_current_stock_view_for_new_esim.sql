-- ============================================
-- Update current_stock_view to work with new esim_stock table
-- The new esim_stock uses 'operator' (TEXT) instead of 'mvno_id' (UUID)
-- and 'available' status instead of 'IN_STORE'
-- ============================================

-- First disable RLS on esim_stock so views can read it
ALTER TABLE esim_stock DISABLE ROW LEVEL SECURITY;

-- Drop and recreate the view
DROP VIEW IF EXISTS current_stock_view CASCADE;

CREATE OR REPLACE VIEW current_stock_view AS
-- TOTAL row - Physical SIMs
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
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id

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
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name

UNION ALL

-- TOTAL row - eSIMs (using new operator column)
SELECT 
  'TOTAL'::TEXT AS mvno,
  'ESIM'::TEXT AS sim_type,
  COUNT(*)::BIGINT AS total_stock,
  COUNT(*) FILTER (WHERE es.status IN ('available', 'IN_STORE'))::BIGINT AS in_store,
  COUNT(*) FILTER (WHERE es.status IN ('assigned', 'ISSUED'))::BIGINT AS issued,
  COUNT(*) FILTER (WHERE es.status IN ('activated', 'ACTIVATED'))::BIGINT AS activated,
  COUNT(*) FILTER (WHERE es.status IN ('sold', 'SOLD'))::BIGINT AS sold,
  COUNT(*) FILTER (WHERE es.status IN ('failed', 'FAILED'))::BIGINT AS failed
FROM esim_stock es

UNION ALL

-- eSIMs by operator (using new operator column)
SELECT 
  es.operator::TEXT AS mvno,
  'ESIM'::TEXT AS sim_type,
  COUNT(*)::BIGINT AS total_stock,
  COUNT(*) FILTER (WHERE es.status IN ('available', 'IN_STORE'))::BIGINT AS in_store,
  COUNT(*) FILTER (WHERE es.status IN ('assigned', 'ISSUED'))::BIGINT AS issued,
  COUNT(*) FILTER (WHERE es.status IN ('activated', 'ACTIVATED'))::BIGINT AS activated,
  COUNT(*) FILTER (WHERE es.status IN ('sold', 'SOLD'))::BIGINT AS sold,
  COUNT(*) FILTER (WHERE es.status IN ('failed', 'FAILED'))::BIGINT AS failed
FROM esim_stock es
GROUP BY es.operator

ORDER BY mvno, sim_type;

-- Grant access
GRANT SELECT ON current_stock_view TO anon, authenticated;

-- Also recreate the esim-specific views
DROP VIEW IF EXISTS total_esim_stock;
DROP VIEW IF EXISTS esim_stock_by_operator;

CREATE VIEW total_esim_stock AS
SELECT 
  COUNT(*) AS total_esims,
  COUNT(*) FILTER (WHERE status = 'available') AS total_available,
  COUNT(*) FILTER (WHERE status = 'assigned') AS total_assigned,
  COUNT(*) FILTER (WHERE status = 'activated') AS total_activated
FROM esim_stock;

CREATE VIEW esim_stock_by_operator AS
SELECT 
  operator,
  COUNT(*) AS total_esims,
  COUNT(*) FILTER (WHERE status = 'available') AS available,
  COUNT(*) FILTER (WHERE status = 'assigned') AS assigned,
  COUNT(*) FILTER (WHERE status = 'activated') AS activated
FROM esim_stock
GROUP BY operator
ORDER BY operator;

GRANT SELECT ON total_esim_stock TO anon, authenticated;
GRANT SELECT ON esim_stock_by_operator TO anon, authenticated;

-- Verify
SELECT 'current_stock_view' as view_name, * FROM current_stock_view ORDER BY mvno, sim_type;
SELECT 'total_esim_stock' as view_name, * FROM total_esim_stock;
SELECT 'esim_stock_by_operator' as view_name, * FROM esim_stock_by_operator;

-- Check if esim_stock table has data
SELECT 'esim_stock count' as check_name, COUNT(*) as count FROM esim_stock;

-- Check sample data
SELECT 'esim_stock sample' as check_name, * FROM esim_stock LIMIT 5;
