-- ============================================
-- Set box total_sims based on Migration 013 specifications
-- PAXTEL: 800 boxes (40 cartons * 20 boxes per carton)
-- SALAMTEL: 200 boxes (10 cartons * 20 boxes per carton)  
-- AGROTEL: 200 boxes (10 cartons * 20 boxes per carton)
-- Each box should have 250 SIMs
-- ============================================

-- First, ensure all boxes have mvno_id set from cartons
UPDATE boxes b
SET mvno_id = c.mvno_id
FROM cartons c
WHERE b.carton_id = c.id
AND (b.mvno_id IS NULL OR b.mvno_id != c.mvno_id);

-- Count boxes per MVNO BEFORE fix
SELECT 
  m.name as mvno,
  COUNT(b.id) as box_count,
  SUM(b.total_sims) as current_total_sims,
  SUM(b.remaining_sims) as current_remaining
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;

-- Set total_sims = 250 for all boxes (based on Migration 013)
UPDATE boxes
SET total_sims = 250
WHERE total_sims != 250 OR total_sims IS NULL;

-- Ensure remaining_sims is set correctly (total - issued)
UPDATE boxes
SET remaining_sims = COALESCE(total_sims, 250) - COALESCE(issued_sims, 0)
WHERE remaining_sims IS NULL OR remaining_sims != (COALESCE(total_sims, 250) - COALESCE(issued_sims, 0));

-- Count boxes per MVNO AFTER fix
SELECT 
  m.name as mvno,
  COUNT(b.id) as box_count,
  SUM(b.total_sims) as fixed_total_sims,
  SUM(b.remaining_sims) as fixed_remaining,
  SUM(b.issued_sims) as fixed_issued
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;

-- Expected results after fix:
-- PAXTEL: 800 boxes * 250 = 200,000
-- SALAMTEL: 200 boxes * 250 = 50,000
-- AGROTEL: 200 boxes * 250 = 50,000
-- Total: 300,000
