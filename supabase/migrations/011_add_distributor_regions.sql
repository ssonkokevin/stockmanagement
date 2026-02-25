-- ============================================
-- Add Region/Location fields to Distributors
-- ============================================

-- Add region column to distributors
ALTER TABLE distributors 
ADD COLUMN IF NOT EXISTS region VARCHAR(100);

-- Add latitude and longitude for map integration
ALTER TABLE distributors 
ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 8);

ALTER TABLE distributors 
ADD COLUMN IF NOT EXISTS longitude DECIMAL(11, 8);

-- Add address field
ALTER TABLE distributors 
ADD COLUMN IF NOT EXISTS address TEXT;

-- Add contact phone
ALTER TABLE distributors 
ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50);

-- Update existing distributors with region data
UPDATE distributors SET region = 'Kampala' WHERE name ILIKE '%Kampala%' OR location ILIKE '%Kampala%';
UPDATE distributors SET region = 'Masaka' WHERE name ILIKE '%Masaka%' OR location ILIKE '%Masaka%';
UPDATE distributors SET region = 'Mbarara' WHERE name ILIKE '%Mbarara%' OR location ILIKE '%Mbarara%';
UPDATE distributors SET region = 'Gulu' WHERE name ILIKE '%Gulu%' OR location ILIKE '%Gulu%';
UPDATE distributors SET region = 'Jinja' WHERE name ILIKE '%Jinja%' OR location ILIKE '%Jinja%';

-- Set default region for those without
UPDATE distributors SET region = 'Kampala' WHERE region IS NULL;

-- Uganda regions with approximate coordinates
CREATE TABLE IF NOT EXISTS uganda_regions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  description TEXT
);

-- Insert Uganda regions
INSERT INTO uganda_regions (name, latitude, longitude, description) VALUES
  ('Kampala', 0.3476, 32.5825, 'Capital City - Central Region'),
  ('Wakiso', 0.3644, 32.4793, 'Metropolitan Area'),
  ('Mukono', 0.3533, 32.7567, 'Central Region'),
  ('Jinja', 0.4252, 33.2037, 'Eastern Region'),
  ('Bugiri', 0.5635, 33.7401, 'Eastern Region'),
  ('Busia', 0.4635, 34.1117, 'Eastern Region'),
  ('Soroti', 1.7146, 33.6107, 'Eastern Region'),
  ('Mbale', 1.0823, 34.1713, 'Eastern Region'),
  ('Masaka', 0.3397, 31.7304, 'Central Region'),
  ('Rakai', 0.4859, 31.9339, 'Central Region'),
  ('Kalangala', -0.9833, 32.2333, 'Central Region - Islands'),
  ('Mbarara', -0.6052, 30.6485, 'Western Region'),
  ('Bushenyi', -0.5548, 30.0687, 'Western Region'),
  ('Kasese', 0.5829, 30.0637, 'Western Region'),
  ('Fort Portal', 0.6714, 30.2734, 'Western Region'),
  ('Gulu', 2.7746, 32.2990, 'Northern Region'),
  ('Kitgum', 3.2787, 32.8786, 'Northern Region'),
  ('Pader', 3.0496, 32.9897, 'Northern Region'),
  ('Arua', 3.0201, 30.9641, 'Northern Region'),
  ('Nebbi', 2.4776, 31.1783, 'Northern Region'),
  ('Lira', 2.3849, 32.8998, 'Northern Region'),
  ('Apac', 1.9889, 32.5331, 'Northern Region'),
  ('Moroto', 2.5446, 34.6214, 'Karamoja Region'),
  ('Kotido', 3.0176, 33.9699, 'Karamoja Region')
ON CONFLICT (name) DO NOTHING;

-- Create function to get nearby distributors by region
CREATE OR REPLACE FUNCTION get_distributors_by_region(p_region VARCHAR)
RETURNS TABLE(
  id UUID,
  name TEXT,
  location TEXT,
  region VARCHAR,
  latitude DECIMAL,
  longitude DECIMAL,
  address TEXT,
  contact_phone VARCHAR
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    d.id,
    d.name,
    d.location,
    d.region,
    d.latitude,
    d.longitude,
    d.address,
    d.contact_phone
  FROM distributors d
  WHERE d.region = p_region OR p_region IS NULL
  ORDER BY d.name;
END;
$$ LANGUAGE plpgsql;

-- Create function to get all regions with distributor counts
CREATE OR REPLACE FUNCTION get_regions_with_counts()
RETURNS TABLE(
  region VARCHAR,
  distributor_count BIGINT,
  total_sims_issued BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(d.region, 'Unknown')::VARCHAR,
    COUNT(DISTINCT d.id)::BIGINT,
    COALESCE(SUM(ph.quantity), 0)::BIGINT
  FROM distributors d
  LEFT JOIN pick_records ph ON ph.distributor_id = d.id
  GROUP BY d.region
  ORDER BY distributor_count DESC;
END;
$$ LANGUAGE plpgsql;

-- Add RLS policy for regions table
ALTER TABLE uganda_regions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable read access for all users" ON uganda_regions;
CREATE POLICY "Enable read access for all users" ON uganda_regions
  FOR SELECT USING (true);

-- Verify the changes
SELECT 
  d.name,
  d.region,
  d.location,
  d.latitude,
  d.longitude
FROM distributors d
ORDER BY d.name
LIMIT 20;

-- Show available regions
SELECT * FROM uganda_regions ORDER BY name;
