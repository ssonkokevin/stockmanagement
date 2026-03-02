-- ============================================
-- Create stock_requests table for distributor requests
-- ============================================

-- Stock requests from distributors to MVNOs
CREATE TABLE IF NOT EXISTS stock_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  distributor_id UUID REFERENCES distributors(id),
  mvno_id UUID REFERENCES mvnos(id),
  sim_type VARCHAR(20) NOT NULL, -- 'PHYSICAL' or 'ESIM'
  quantity INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED
  assigned_carton_ids UUID[] DEFAULT '{}',
  assigned_box_ids UUID[] DEFAULT '{}',
  notes TEXT,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE stock_requests ENABLE ROW LEVEL SECURITY;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON stock_requests TO anon;
GRANT SELECT, INSERT, UPDATE ON stock_requests TO authenticated;

-- Create RLS policy
CREATE POLICY "Allow anon stock_requests" ON stock_requests FOR ALL TO anon USING (true);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_stock_requests_distributor ON stock_requests(distributor_id);
CREATE INDEX IF NOT EXISTS idx_stock_requests_mvno ON stock_requests(mvno_id);
CREATE INDEX IF NOT EXISTS idx_stock_requests_status ON stock_requests(status);
