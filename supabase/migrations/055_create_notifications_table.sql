-- Create notifications table for approval workflow
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  related_id UUID,
  target_emails TEXT[],
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Policy for anon
DROP POLICY IF EXISTS "Allow anon notifications" ON notifications;
CREATE POLICY "Allow anon notifications" ON notifications FOR ALL TO anon USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO authenticated, anon;
