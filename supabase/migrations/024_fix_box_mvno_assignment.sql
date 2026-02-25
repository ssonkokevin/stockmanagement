-- ============================================
-- Fix Box MVNO Assignment
-- Ensure all boxes have mvno_id set from their cartons
-- and verify total_sims values are correct
-- ============================================

-- First, ensure mvno_id is set for all boxes from cartons
UPDATE boxes b
SET mvno_id = c.mvno_id
FROM cartons c
WHERE b.carton_id = c.id
AND (b.mvno_id IS NULL OR b.mvno_id != c.mvno_id);

-- Verify the fix
SELECT 
  m.name as mvno,
  COUNT(b.id) as box_count,
  SUM(b.total_sims) as total_sims,
  SUM(b.remaining_sims) as remaining_sims,
  SUM(b.issued_sims) as issued_sims
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;

-- Check for boxes without mvno_id
SELECT 
  'Boxes without mvno_id' as issue,
  COUNT(*) as count
FROM boxes b
WHERE b.mvno_id IS NULL;

-- Check sample boxes for each MVNO
SELECT 
  m.name as mvno,
  b.box_number,
  b.total_sims,
  b.remaining_sims,
  b.issued_sims
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
WHERE m.name = 'PAXTEL'
ORDER BY b.box_number
LIMIT 10;
