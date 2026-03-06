-- ============================================
-- Normalize Status Values and Add Constraints
-- Fix case mismatch issues and enforce valid states
-- ============================================

-- First, check what status values exist currently
-- This is informational only
-- SELECT DISTINCT status FROM stock_issuance_requests;

-- Normalize all status values to uppercase
UPDATE stock_issuance_requests
SET status = UPPER(TRIM(status))
WHERE status IS NOT NULL;

-- Fix common typos/variants to standard values
UPDATE stock_issuance_requests
SET status = 'PENDING'
WHERE UPPER(TRIM(status)) IN ('PEND', 'PENDING', 'WAITING', 'NEW', 'DRAFT');

UPDATE stock_issuance_requests
SET status = 'LEVEL_1_APPROVED'
WHERE UPPER(TRIM(status)) IN ('LEVEL1', 'LEVEL_1', 'APPROVED_LEVEL_1', 'L1_APPROVED', 'LEVEL1_APPROVED', 'APPROVED');

UPDATE stock_issuance_requests
SET status = 'LEVEL_2_APPROVED'
WHERE UPPER(TRIM(status)) IN ('LEVEL2', 'LEVEL_2', 'APPROVED_LEVEL_2', 'L2_APPROVED', 'LEVEL2_APPROVED');

UPDATE stock_issuance_requests
SET status = 'COMPLETED'
WHERE UPPER(TRIM(status)) IN ('DONE', 'ISSUED', 'COMPLETE', 'FINISHED', 'SUCCESS');

UPDATE stock_issuance_requests
SET status = 'REJECTED'
WHERE UPPER(TRIM(status)) IN ('REJECT', 'DENIED', 'DECLINED', 'CANCELLED');

-- Add CHECK constraint to enforce valid status values
-- First drop if exists, then add
ALTER TABLE stock_issuance_requests 
DROP CONSTRAINT IF EXISTS valid_stock_status;

ALTER TABLE stock_issuance_requests
ADD CONSTRAINT valid_stock_status 
CHECK (status IN ('PENDING', 'LEVEL_1_APPROVED', 'LEVEL_2_APPROVED', 'COMPLETED', 'REJECTED'));

-- Ensure all required indexes exist
CREATE INDEX IF NOT EXISTS idx_stock_issuance_status_check ON stock_issuance_requests(status);

-- Log the normalization for audit
DO $$
BEGIN
  RAISE NOTICE 'Status values normalized. Current distinct values:';
END $$;

-- Show what we have now
-- SELECT status, COUNT(*) as count FROM stock_issuance_requests GROUP BY status;
