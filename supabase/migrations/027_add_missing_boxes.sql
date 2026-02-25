-- ============================================
-- Add missing boxes to match Migration 013 specifications
-- PAXTEL: 800 boxes (40 cartons * 20 boxes)
-- SALAMTEL: 200 boxes (10 cartons * 20 boxes)
-- AGROTEL: 200 boxes (10 cartons * 20 boxes)
-- ============================================

-- Check current box counts by MVNO
SELECT 
  m.name as mvno,
  COUNT(b.id) as current_boxes,
  1200 as expected_total,
  (1200 - COUNT(b.id)) as boxes_to_add
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;

-- Check how many cartons each MVNO has
SELECT 
  m.name as mvno,
  COUNT(c.id) as carton_count
FROM cartons c
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;

-- Check box numbers per MVNO to see what's missing
SELECT 
  m.name as mvno,
  MIN(b.box_number) as min_box,
  MAX(b.box_number) as max_box,
  COUNT(b.id) as box_count
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;
