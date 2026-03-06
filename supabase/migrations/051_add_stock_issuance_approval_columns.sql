-- Add columns for stock issuance approval workflow

-- Add assigned_box_ids to track which boxes are being issued
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS assigned_box_ids UUID[];

-- Add level 1 and level 2 approver info
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS level_1_approver_email VARCHAR(255);
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS level_2_approver_email VARCHAR(255);

-- Add approval token for email verification
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS level_1_token VARCHAR(255);
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS level_1_token_expires TIMESTAMPTZ;
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS level_2_token VARCHAR(255);
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS level_2_token_expires TIMESTAMPTZ;

-- Add completion record info
ALTER TABLE stock_issuance_requests ADD COLUMN IF NOT EXISTS completion_record JSONB;

-- Create table for approvers (team leaders and managers who can approve)
CREATE TABLE IF NOT EXISTS stock_issuance_approvers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  approval_level VARCHAR(20) NOT NULL CHECK (approval_level IN ('LEVEL_1', 'LEVEL_2')),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE stock_issuance_approvers ENABLE ROW LEVEL SECURITY;

-- Policy for anon
DROP POLICY IF EXISTS "Allow anon stock_issuance_approvers" ON stock_issuance_approvers;
CREATE POLICY "Allow anon stock_issuance_approvers" ON stock_issuance_approvers FOR ALL TO anon USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON stock_issuance_approvers TO authenticated, anon;
