-- ============================================
-- Recreate current_stock_view with correct data
-- This view shows stock by MVNO for both Physical SIMs and eSIMs
-- ============================================

-- First, fix any boxes that don't have mvno_id set
UPDATE boxes b
SET mvno_id = c.mvno_id
FROM cartons c
WHERE b.carton_id = c.id
AND (b.mvno_id IS NULL OR b.mvno_id != c.mvno_id);

-- Verify boxes now have mvno_id
SELECT 
  'Boxes without mvno_id' as check,
  COUNT(*) as count
FROM boxes b
WHERE b.mvno_id IS NULL;

-- First, ensure RLS is disabled for esim_stock so the view can read it
ALTER TABLE esim_stock DISABLE ROW LEVEL SECURITY;

-- Drop existing view
DROP VIEW IF EXISTS current_stock_view CASCADE;

-- Create the view with proper MVNO grouping
CREATE OR REPLACE VIEW current_stock_view AS
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

ORDER BY mvno, sim_type;

-- Grant access
GRANT SELECT ON current_stock_view TO anon, authenticated;

-- Verify the view
SELECT * FROM current_stock_view ORDER BY mvno, sim_type;

-- Show breakdown by MVNO for Physical SIMs
SELECT 
  mvno,
  sim_type,
  total_stock,
  in_store,
  issued
FROM current_stock_view 
WHERE sim_type = 'PHYSICAL'
ORDER BY mvno;

-- Show breakdown by operator for eSIMs
SELECT 
  mvno,
  sim_type,
  total_stock,
  in_store,
  issued,
  activated
FROM current_stock_view 
WHERE sim_type = 'ESIM'
ORDER BY mvno;
