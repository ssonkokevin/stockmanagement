-- Migration: Add new stock issuance status values
-- Adds READY_FOR_APPROVAL and STOCK_ISSUED statuses to stock_issuance_requests

-- First, update any existing COMPLETED status to STOCK_ISSUED
UPDATE stock_issuance_requests 
SET status = 'STOCK_ISSUED' 
WHERE status = 'COMPLETED';

-- Update any PENDING status with assigned boxes to READY_FOR_APPROVAL
UPDATE stock_issuance_requests
SET status = 'READY_FOR_APPROVAL'
WHERE status = 'PENDING' 
AND (
  (assigned_box_ids IS NOT NULL AND array_length(assigned_box_ids, 1) > 0)
  OR 
  (assigned_esim_iccids IS NOT NULL AND array_length(assigned_esim_iccids, 1) > 0)
);

-- Drop the old CHECK constraint that only allows old statuses
ALTER TABLE stock_issuance_requests 
DROP CONSTRAINT IF EXISTS valid_stock_status;

-- Add new CHECK constraint with updated status values
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

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_stock_issuance_requests_status_v2
ON stock_issuance_requests(status);

-- Verify the status values
SELECT DISTINCT status, COUNT(*) as count 
FROM stock_issuance_requests 
GROUP BY status 
ORDER BY status;

-- Add comment to document the status flow
COMMENT ON COLUMN stock_issuance_requests.status IS 
'Status flow: PENDING -> READY_FOR_APPROVAL -> LEVEL_1_APPROVED -> LEVEL_2_APPROVED -> STOCK_ISSUED or REJECTED';
