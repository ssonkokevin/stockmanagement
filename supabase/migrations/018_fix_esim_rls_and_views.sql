-- ============================================
-- Fix eSIM stock views and RLS
-- The views show 0 because RLS blocks access
-- ============================================

-- First, check if data actually exists (bypasses RLS for superuser)
-- SELECT COUNT(*) FROM esim_stock;

-- Option 1: Disable RLS entirely (simplest for internal tool)
ALTER TABLE esim_stock DISABLE ROW LEVEL SECURITY;

-- Option 2: Or if you want RLS, create a permissive policy
-- DROP POLICY IF EXISTS "Allow all access to esim_stock" ON esim_stock;
-- CREATE POLICY "Allow all access to esim_stock" ON esim_stock
--   FOR ALL USING (true) WITH CHECK (true);

-- Recreate views with SECURITY DEFINER to bypass RLS
DROP VIEW IF EXISTS total_esim_stock;
DROP VIEW IF EXISTS esim_stock_by_operator;

CREATE VIEW total_esim_stock 
WITH (security_invoker = false)
AS
SELECT 
  COUNT(*) AS total_esims,
  COUNT(*) FILTER (WHERE status = 'available') AS total_available,
  COUNT(*) FILTER (WHERE status = 'assigned') AS total_assigned,
  COUNT(*) FILTER (WHERE status = 'activated') AS total_activated
FROM esim_stock;

CREATE VIEW esim_stock_by_operator 
WITH (security_invoker = false)
AS
SELECT 
  operator,
  COUNT(*) AS total_esims,
  COUNT(*) FILTER (WHERE status = 'available') AS available,
  COUNT(*) FILTER (WHERE status = 'assigned') AS assigned,
  COUNT(*) FILTER (WHERE status = 'activated') AS activated
FROM esim_stock
GROUP BY operator
ORDER BY operator;

-- Grant access to views
GRANT SELECT ON total_esim_stock TO anon, authenticated;
GRANT SELECT ON esim_stock_by_operator TO anon, authenticated;
GRANT ALL ON esim_stock TO anon, authenticated;

-- Verify
SELECT * FROM total_esim_stock;
SELECT * FROM esim_stock_by_operator;
