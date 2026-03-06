-- Add column for storing box quantities with ICCID ranges
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS assigned_box_quantities JSONB;
