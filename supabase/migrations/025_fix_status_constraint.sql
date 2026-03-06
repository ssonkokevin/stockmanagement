-- Fix the CHECK constraint on status column
-- The previous migration didn't properly update the constraint

-- First, drop the old constraint
ALTER TABLE stock_issuance_requests 
DROP CONSTRAINT IF EXISTS stock_issuance_requests_status_check;

-- Also drop any other constraint that might be blocking
ALTER TABLE stock_issuance_requests 
DROP CONSTRAINT IF EXISTS valid_stock_status;

-- Add new constraint with all valid statuses
ALTER TABLE stock_issuance_requests
ADD CONSTRAINT valid_stock_status 
CHECK (status IN (
  'PENDING', 
  'READY_FOR_APPROVAL', 
  'LEVEL_1_APPROVED', 
  'LEVEL_2_APPROVED', 
  'STOCK_ISSUED', 
  'REJECTED'
));

-- Now try the update again
UPDATE stock_issuance_requests 
SET status = 'READY_FOR_APPROVAL' 
WHERE status = 'PENDING';

-- Verify the fix
SELECT DISTINCT status, COUNT(*) as count 
FROM stock_issuance_requests 
GROUP BY status 
ORDER BY status;
