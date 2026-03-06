-- Add column for storing assigned eSIM ICCIDs
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS assigned_esim_iccids TEXT[];
