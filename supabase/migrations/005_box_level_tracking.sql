-- ============================================
-- Box Level Tracking - Add columns for tracking remaining SIMs
-- ============================================

-- Add columns to boxes table (if not exists)
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS remaining_sims INTEGER DEFAULT 250;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS issued_sims INTEGER DEFAULT 0;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS mvno_id UUID;

-- Enable RLS on boxes if not enabled
ALTER TABLE boxes ENABLE ROW LEVEL SECURITY;

-- Drop policy if exists (for re-runs)
DROP POLICY IF EXISTS "allow_all_boxes" ON boxes;

-- Create policy
CREATE POLICY "allow_all_boxes" ON boxes
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

-- Create box_pick_records table if not exists
CREATE TABLE IF NOT EXISTS box_pick_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id UUID REFERENCES boxes(id) ON DELETE CASCADE,
  distributor_id UUID,
  quantity INTEGER NOT NULL,
  iccid_start TEXT,
  iccid_end TEXT,
  picked_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on box_pick_records
ALTER TABLE box_pick_records ENABLE ROW LEVEL SECURITY;

-- Drop policy if exists (for re-runs)
DROP POLICY IF EXISTS "allow_all_box_pick_records" ON box_pick_records;

-- Create policy
CREATE POLICY "allow_all_box_pick_records" ON box_pick_records
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);
