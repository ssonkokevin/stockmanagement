-- Add ownership columns to boxes table for multi-tenant stock visibility
-- Note: status column may already exist with different enum values

-- Add owner_type column if not exists
ALTER TABLE boxes 
ADD COLUMN IF NOT EXISTS owner_type TEXT DEFAULT 'HAMILTON' CHECK (owner_type IN ('HAMILTON', 'MVNO', 'DISTRIBUTOR'));

-- Add owner_id column if not exists
ALTER TABLE boxes 
ADD COLUMN IF NOT EXISTS owner_id UUID;

-- Create index for faster ownership queries
CREATE INDEX IF NOT EXISTS idx_boxes_owner ON boxes(owner_type, owner_id);

-- Initialize existing boxes with Hamilton ownership (null owner_id for HAMILTON)
UPDATE boxes 
SET owner_type = 'HAMILTON', 
    owner_id = NULL
WHERE owner_type IS NULL OR owner_type = 'HAMILTON';
