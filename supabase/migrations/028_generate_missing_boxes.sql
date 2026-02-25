-- ============================================
-- Generate missing boxes to match Migration 013 specifications
-- PAXTEL: 800 boxes (40 cartons * 20 boxes)
-- SALAMTEL: 200 boxes (10 cartons * 20 boxes)
-- AGROTEL: 200 boxes (10 cartons * 20 boxes)
-- ============================================

-- First, let's see what we have
SELECT 
  m.name as mvno,
  COUNT(b.id) as current_boxes
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;

-- Add missing boxes - simpler version without ICCID calculation
INSERT INTO boxes (id, carton_id, box_number, total_sims, remaining_sims, issued_sims, status, mvno_id, created_at)
SELECT 
  gen_random_uuid(),
  c.id,
  COALESCE(MAX(b.box_number), 0) + ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY c.id),
  250,
  250,
  0,
  'IN_STORE',
  c.mvno_id,
  NOW()
FROM cartons c
LEFT JOIN boxes b ON b.carton_id = c.id
GROUP BY c.id, c.mvno_id
HAVING COUNT(b.id) < 20
RETURNING carton_id, box_number;

-- Verify the results
SELECT 
  m.name as mvno,
  COUNT(b.id) as box_count,
  SUM(b.total_sims) as total_sims
FROM boxes b
JOIN cartons c ON b.carton_id = c.id
JOIN mvnos m ON c.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;

-- Total should be:
-- PAXTEL: 800 * 250 = 200,000
-- SALAMTEL: 200 * 250 = 50,000
-- AGROTEL: 200 * 250 = 50,000
-- Total: 300,000
