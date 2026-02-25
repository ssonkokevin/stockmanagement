-- ============================================
-- Update current_stock_view to include box-level physical SIM tracking
-- This ensures Paxtel, Salamtel, Agrotel physical SIMs are counted
-- Includes TOTAL row that sums all MVNOs
-- ============================================

-- First, let's see what's in the boxes table for each MVNO
SELECT 
  m.name as mvno,
  COUNT(DISTINCT c.id) as cartons,
  COUNT(b.id) as boxes,
  SUM(b.total_sims) as total_from_boxes,
  SUM(b.remaining_sims) as remaining_from_boxes,
  SUM(b.issued_sims) as issued_from_boxes
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;

-- Drop and recreate the view with box-level tracking for physical SIMs
DROP VIEW IF EXISTS current_stock_view CASCADE;

CREATE OR REPLACE VIEW current_stock_view AS
-- TOTAL row - sum of all MVNOs for Physical (cast as TEXT)
SELECT 
  'TOTAL'::TEXT AS mvno, 
  'PHYSICAL'::TEXT AS sim_type,
  COALESCE(SUM(b.total_sims), 0) AS total_stock,
  COALESCE(SUM(b.remaining_sims), 0) AS in_store,
  COALESCE(SUM(b.issued_sims), 0) AS issued,
  0 AS activated,
  0 AS sold,
  0 AS failed
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
UNION ALL
-- Physical SIMs from boxes table (box-level tracking) - by MVNO
SELECT 
  m.name::TEXT AS mvno, 
  'PHYSICAL'::TEXT AS sim_type,
  COALESCE(SUM(b.total_sims), 0) AS total_stock,
  COALESCE(SUM(b.remaining_sims), 0) AS in_store,
  COALESCE(SUM(b.issued_sims), 0) AS issued,
  0 AS activated,
  0 AS sold,
  0 AS failed
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
UNION ALL
-- TOTAL row - sum of all MVNOs for eSIM (cast as TEXT)
SELECT 
  'TOTAL'::TEXT AS mvno,
  'ESIM'::TEXT AS sim_type,
  COUNT(*),
  COUNT(*) FILTER (WHERE es.status = 'IN_STORE'),
  COUNT(*) FILTER (WHERE es.status = 'ISSUED'),
  COUNT(*) FILTER (WHERE es.status = 'ACTIVATED'),
  COUNT(*) FILTER (WHERE es.status = 'SOLD'),
  COUNT(*) FILTER (WHERE es.status = 'FAILED')
FROM esim_stock es
JOIN mvnos m ON es.mvno_id = m.id
UNION ALL
-- eSIM stock by MVNO
SELECT m.name::TEXT, 'ESIM'::TEXT,
  COUNT(*),
  COUNT(*) FILTER (WHERE es.status = 'IN_STORE'),
  COUNT(*) FILTER (WHERE es.status = 'ISSUED'),
  COUNT(*) FILTER (WHERE es.status = 'ACTIVATED'),
  COUNT(*) FILTER (WHERE es.status = 'SOLD'),
  COUNT(*) FILTER (WHERE es.status = 'FAILED')
FROM esim_stock es
JOIN mvnos m ON es.mvno_id = m.id
GROUP BY m.name
ORDER BY mvno, sim_type;

-- Verify the results
SELECT * FROM current_stock_view ORDER BY mvno, sim_type;

-- Show physical SIM totals
SELECT 
  mvno,
  total_stock,
  in_store,
  issued,
  activated,
  sold,
  failed
FROM current_stock_view
WHERE sim_type = 'PHYSICAL'
ORDER BY mvno;

-- Show eSIM totals
SELECT 
  mvno,
  total_stock,
  in_store,
  issued,
  activated,
  sold,
  failed
FROM current_stock_view
WHERE sim_type = 'ESIM'
ORDER BY mvno;
