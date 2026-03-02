-- ============================================
-- Add request_token columns to distributors table
-- ============================================

-- Add request_token and request_token_expires columns
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS request_token UUID;
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS request_token_expires TIMESTAMPTZ;

-- Create index for faster token lookup
CREATE INDEX IF NOT EXISTS idx_distributors_request_token ON distributors(request_token);

-- Grant permissions
GRANT UPDATE ON distributors TO anon;
GRANT UPDATE ON distributors TO authenticated;
