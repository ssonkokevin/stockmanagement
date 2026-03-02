-- ============================================
-- STOCK REQUEST AND APPROVAL SYSTEM
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

-- Stock requests from MVNOs to Superadmin
CREATE TABLE IF NOT EXISTS mvno_stock_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mvno_id UUID REFERENCES mvnos(id),
  sim_type VARCHAR(20) NOT NULL,
  quantity INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',
  notes TEXT,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Stock issuance records
CREATE TABLE IF NOT EXISTS stock_issuances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID,
  distributor_id UUID REFERENCES distributors(id),
  mvno_id UUID REFERENCES mvnos(id),
  sim_type VARCHAR(20) NOT NULL,
  quantity INTEGER NOT NULL,
  carton_boxes JSONB DEFAULT '[]', -- Array of {carton_id, box_ids}
  status VARCHAR(20) DEFAULT 'PENDING',
  issued_by UUID REFERENCES platform_users(id),
  issued_at TIMESTAMPTZ,
  approved_by UUID REFERENCES platform_users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Notification table
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES platform_users(id),
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(50) DEFAULT 'INFO', -- INFO, WARNING, SUCCESS, ERROR
  is_read BOOLEAN DEFAULT false,
  link VARCHAR(500),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE stock_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE mvno_stock_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON stock_requests TO anon;
GRANT SELECT, INSERT, UPDATE ON mvno_stock_requests TO anon;
GRANT SELECT, INSERT, UPDATE ON stock_issuances TO anon;
GRANT SELECT, INSERT, UPDATE ON notifications TO anon;

-- Create RLS policies
CREATE POLICY "Allow anon stock_requests" ON stock_requests FOR ALL TO anon USING (true);
CREATE POLICY "Allow anon mvno_stock_requests" ON mvno_stock_requests FOR ALL TO anon USING (true);
CREATE POLICY "Allow anon stock_issuances" ON stock_issuances FOR ALL TO anon USING (true);
CREATE POLICY "Allow anon notifications" ON notifications FOR ALL TO anon USING (true);

-- Add unique link token to distributors
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS request_token UUID DEFAULT gen_random_uuid();
ALTER TABLE distributors ADD COLUMN IF NOT EXISTS request_token_expires TIMESTAMPTZ;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_stock_requests_distributor ON stock_requests(distributor_id);
CREATE INDEX IF NOT EXISTS idx_stock_requests_mvno ON stock_requests(mvno_id);
CREATE INDEX IF NOT EXISTS idx_stock_requests_status ON stock_requests(status);
CREATE INDEX IF NOT EXISTS idx_mvno_stock_requests_mvno ON mvno_stock_requests(mvno_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);
