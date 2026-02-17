-- SIM Card Stock Management table
CREATE TABLE IF NOT EXISTS simcards (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  iccid TEXT NOT NULL UNIQUE,
  phone_number TEXT,
  carrier TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'assigned', 'activated', 'deactivated')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Enable RLS (Row Level Security)
ALTER TABLE simcards ENABLE ROW LEVEL SECURITY;

-- Allow all operations for authenticated users (adjust policies as needed for your auth)
CREATE POLICY "Allow all for authenticated" ON simcards
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- For public anon key (development), allow all - restrict in production
CREATE POLICY "Allow all for anon" ON simcards
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_simcards_updated_at
  BEFORE UPDATE ON simcards
  FOR EACH ROW
  EXECUTE PROCEDURE update_updated_at_column();
