-- ============================================
-- DEBUG: Check current request status values
-- Run this to see what statuses exist in your database
-- ============================================

-- 1. Check all distinct status values
SELECT DISTINCT status, COUNT(*) as count 
FROM stock_issuance_requests 
GROUP BY status 
ORDER BY status;

-- 2. Check full details of recent requests
SELECT 
    id, 
    status, 
    sim_type, 
    quantity, 
    created_at,
    assigned_box_ids,
    assigned_esim_iccids
FROM stock_issuance_requests 
ORDER BY created_at DESC 
LIMIT 10;

-- 3. Manually fix: Update all PENDING requests with assigned boxes to READY_FOR_APPROVAL
UPDATE stock_issuance_requests
SET status = 'READY_FOR_APPROVAL'
WHERE status = 'PENDING' 
AND (
  assigned_box_ids IS NOT NULL 
  OR assigned_esim_iccids IS NOT NULL
);

-- 4. Check requests that should appear in Approve Stock tab
SELECT id, status FROM stock_issuance_requests
WHERE status IN ('READY_FOR_APPROVAL', 'LEVEL_1_APPROVED', 'LEVEL_2_APPROVED')
ORDER BY created_at DESC;
