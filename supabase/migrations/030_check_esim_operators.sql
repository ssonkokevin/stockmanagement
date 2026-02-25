-- ============================================
-- Check what operators exist in esim_stock
-- ============================================

-- Show all unique operators and their counts
SELECT 
  operator as "Operator",
  COUNT(*) as "Total eSIMs",
  COUNT(*) FILTER (WHERE status = 'available') as "Available",
  COUNT(*) FILTER (WHERE status = 'assigned') as "Assigned",
  COUNT(*) FILTER (WHERE status = 'activated') as "Activated"
FROM esim_stock
GROUP BY operator
ORDER BY operator;
