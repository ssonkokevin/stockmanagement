-- ============================================
-- Add carton_number and box_number columns to esim_stock table
-- This enables filtering by carton and box for eSIM inventory
-- ============================================

-- Add columns to esim_stock table
ALTER TABLE esim_stock ADD COLUMN IF NOT EXISTS carton_number TEXT;
ALTER TABLE esim_stock ADD COLUMN IF NOT EXISTS box_number TEXT;
ALTER TABLE esim_stock ADD COLUMN IF NOT EXISTS mvno TEXT;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_esim_stock_carton_number ON esim_stock(carton_number);
CREATE INDEX IF NOT EXISTS idx_esim_stock_box_number ON esim_stock(box_number);
CREATE INDEX IF NOT EXISTS idx_esim_stock_mvno ON esim_stock(mvno);
CREATE INDEX IF NOT EXISTS idx_esim_stock_iccid ON esim_stock(iccid);
CREATE INDEX IF NOT EXISTS idx_esim_stock_status ON esim_stock(status);

-- Update existing records to populate mvno from operator if not set
UPDATE esim_stock 
SET mvno = operator 
WHERE mvno IS NULL OR mvno = '';

-- Verify the columns
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'esim_stock' 
AND column_name IN ('carton_number', 'box_number', 'mvno', 'iccid', 'status')
ORDER BY column_name;
