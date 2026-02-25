-- ============================================
-- Create simcards table
-- ============================================

-- Drop trigger if exists first (for re-runs)
DROP TRIGGER IF EXISTS update_simcards_updated_at ON simcards;

-- Drop table if exists (for fresh setup)
DROP TABLE IF EXISTS simcards CASCADE;

-- Create simcards table
CREATE TABLE simcards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iccid TEXT UNIQUE NOT NULL,
  imsi TEXT,
  phone_number TEXT,
  status TEXT NOT NULL DEFAULT 'IN_STORE',
  mvno_id UUID,
  distributor_id UUID,
  box_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add updated_at trigger
CREATE TRIGGER update_simcards_updated_at
  BEFORE UPDATE ON simcards
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS
ALTER TABLE simcards ENABLE ROW LEVEL SECURITY;

-- Drop policy if exists (for re-runs)
DROP POLICY IF EXISTS "allow_all_simcards" ON simcards;

-- Create policy
CREATE POLICY "allow_all_simcards" ON simcards
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);
