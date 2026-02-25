-- Fix box_pick_records table columns
-- The table might have different column names than expected

-- Add quantity column if it doesn't exist (for consistency with migrations)
ALTER TABLE box_pick_records ADD COLUMN IF NOT EXISTS quantity INTEGER;

-- Add sims_picked column if it doesn't exist (for compatibility with frontend)
ALTER TABLE box_pick_records ADD COLUMN IF NOT EXISTS sims_picked INTEGER;

-- If quantity column has data but sims_picked doesn't, sync them
UPDATE box_pick_records 
SET sims_picked = quantity 
WHERE sims_picked IS NULL AND quantity IS NOT NULL;

-- If sims_picked has data but quantity doesn't, sync them
UPDATE box_pick_records 
SET quantity = sims_picked 
WHERE quantity IS NULL AND sims_picked IS NOT NULL;
