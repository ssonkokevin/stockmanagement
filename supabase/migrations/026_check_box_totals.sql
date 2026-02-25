-- ============================================
-- Check and fix box total_sims values
-- ============================================

-- Check current box counts and totals by MVNO
SELECT 
  m.name as mvno,
  COUNT(b.id) as box_count,
  SUM(b.total_sims) as total_sims,
  SUM(b.remaining_sims) as remaining_sims,
  SUM(b.issued_sims) as issued_sims,
  AVG(b.total_sims)::numeric(10,2) as avg_sims_per_box
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;

-- Check for duplicate or unusual boxes
SELECT 
  b.id,
  b.box_number,
  b.total_sims,
  b.remaining_sims,
  b.issued_sims,
  c.carton_number,
  m.name as mvno
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
WHERE b.total_sims != 250
ORDER BY m.name, b.box_number;

-- Check for boxes with NULL or zero total_sims
SELECT 
  'Boxes with NULL or zero total_sims' as issue,
  COUNT(*) as count
FROM boxes b
WHERE b.total_sims IS NULL OR b.total_sims = 0;

-- Fix: Set total_sims = 250 for boxes with wrong values
UPDATE boxes 
SET total_sims = 250 
WHERE total_sims != 250;

-- Verify the fix
SELECT 
  m.name as mvno,
  COUNT(b.id) as box_count,
  SUM(b.total_sims) as total_sims
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;
