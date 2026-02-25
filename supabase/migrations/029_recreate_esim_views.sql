-- ============================================
-- Recreate esim_stock_by_operator view with correct data
-- ============================================

-- Drop existing views
DROP VIEW IF EXISTS esim_stock_by_operator;
DROP VIEW IF EXISTS total_esim_stock;

-- Create total_esim_stock view
CREATE VIEW total_esim_stock AS
SELECT 
  COUNT(*) AS total_esims,
  COUNT(*) FILTER (WHERE status = 'available') AS total_available,
  COUNT(*) FILTER (WHERE status = 'assigned') AS total_assigned,
  COUNT(*) FILTER (WHERE status = 'activated') AS total_activated
FROM esim_stock;

-- Create esim_stock_by_operator view
CREATE VIEW esim_stock_by_operator AS
SELECT 
  operator,
  COUNT(*) AS total_esims,
  COUNT(*) FILTER (WHERE status = 'available') AS available,
  COUNT(*) FILTER (WHERE status = 'assigned') AS assigned,
  COUNT(*) FILTER (WHERE status = 'activated') AS activated
FROM esim_stock
WHERE operator IS NOT NULL
GROUP BY operator
ORDER BY operator;

-- Grant access
GRANT SELECT ON total_esim_stock TO anon, authenticated;
GRANT SELECT ON esim_stock_by_operator TO anon, authenticated;

-- Verify
SELECT * FROM total_esim_stock;
SELECT * FROM esim_stock_by_operator ORDER BY operator;
