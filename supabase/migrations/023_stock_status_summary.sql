-- ============================================
-- Stock Status Overview View
-- Aggregates SIM stock counts by status for donut chart
-- ============================================

-- Drop existing views if exists
DROP VIEW IF EXISTS stock_status_summary;
DROP VIEW IF EXISTS stock_by_status;

-- Create simplified view to get stock by status
-- This aggregates boxes and esim_stock by their status
CREATE OR REPLACE VIEW stock_by_status AS
SELECT 
  'IN_STORE' as status,
  (
    (SELECT COALESCE(SUM(b.remaining_sims), 0) FROM boxes b WHERE b.status = 'IN_STORE' OR b.status IS NULL) +
    (SELECT COUNT(*) FROM esim_stock e WHERE e.status = 'IN_STORE')
  ) as count
UNION ALL
SELECT 
  'ISSUED' as status,
  (
    (SELECT COALESCE(SUM(b.issued_sims), 0) FROM boxes b WHERE b.status = 'ISSUED') +
    (SELECT COUNT(*) FROM esim_stock e WHERE e.status = 'ISSUED')
  ) as count
UNION ALL
SELECT 
  'ACTIVATED' as status,
  (
    (SELECT COALESCE(SUM(b.issued_sims), 0) FROM boxes b WHERE b.status = 'ACTIVATED') +
    (SELECT COUNT(*) FROM esim_stock e WHERE e.status = 'ACTIVATED')
  ) as count
UNION ALL
SELECT 
  'SOLD' as status,
  (
    (SELECT COALESCE(SUM(b.issued_sims), 0) FROM boxes b WHERE b.status = 'SOLD') +
    (SELECT COUNT(*) FROM esim_stock e WHERE e.status = 'SOLD')
  ) as count
UNION ALL
SELECT 
  'FAILED' as status,
  (
    (SELECT COALESCE(SUM(b.total_sims), 0) FROM boxes b WHERE b.status = 'FAILED') +
    (SELECT COUNT(*) FROM esim_stock e WHERE e.status = 'FAILED')
  ) as count;

-- Grant access
GRANT SELECT ON stock_by_status TO anon, authenticated;

-- Verify the view
SELECT * FROM stock_by_status ORDER BY status;
