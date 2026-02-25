-- ============================================
-- Verify and Fix Data Issues
-- ============================================

-- 1. Check current eSIM counts by MVNO
SELECT 
  m.name as mvno,
  COUNT(e.id) as total_esims
FROM mvnos m
LEFT JOIN esim_stock e ON e.mvno_id = m.id
GROUP BY m.name
ORDER BY m.name;

-- 2. Check for duplicate distributors
SELECT 
  name, 
  COUNT(*) as count,
  array_agg(id) as ids
FROM distributors
GROUP BY name
HAVING COUNT(*) > 1;

-- 3. Check total eSIMs
SELECT COUNT(*) as total_esims FROM esim_stock;

-- 4. Fix: Delete duplicate distributors keeping the oldest (first created)
-- Use created_at to keep oldest, delete newer duplicates
DELETE FROM distributors
WHERE id IN (
  SELECT id FROM (
    SELECT 
      id, 
      name,
      ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at ASC) as rn
    FROM distributors
  ) sub
  WHERE rn > 1
);

-- 5. Verify distributor count after cleanup
SELECT COUNT(*) as total_distributors FROM distributors;

-- 6. List all distributors
SELECT id, name, type, location, created_at FROM distributors ORDER BY name;
