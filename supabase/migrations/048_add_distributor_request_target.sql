-- Add request_target column to distributors table
-- This determines where the stock request goes:
-- 'stock_issuance' = Superadmin (Hamilton) pool
-- 'stock_request' = MVNO pool

ALTER TABLE distributors ADD COLUMN IF NOT EXISTS request_target VARCHAR(50) DEFAULT 'stock_issuance';

-- Grant permissions
GRANT SELECT, UPDATE ON distributors TO authenticated;
GRANT SELECT ON distributors TO anon;
