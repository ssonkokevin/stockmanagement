-- ============================================
-- Demo Users for MVNE Platform Testing
-- ============================================
-- Run this SQL to create demo users in the platform_users table
-- After running migrations 040 and 041
-- ============================================

-- Get MVNO IDs first
DO $$
DECLARE
  v_paxtel_id UUID;
  v_salamtel_id UUID;
  v_agrotel_id UUID;
BEGIN
  -- Get MVNO IDs
  SELECT id INTO v_paxtel_id FROM mvnos WHERE name = 'PAXTEL';
  SELECT id INTO v_salamtel_id FROM mvnos WHERE name = 'SALAMTEL';
  SELECT id INTO v_agrotel_id FROM mvnos WHERE name = 'AGROTEL';

  -- Insert demo users (password is 'demo123' - in production use proper hashing)
  INSERT INTO platform_users (email, password_hash, full_name, role, mvno_id, is_active)
  VALUES 
    -- Super Admin
    ('admin@hamilton.com', 'demo123', 'System Administrator', 'SUPER_ADMIN', NULL, true),
    
    -- Management
    ('manager@hamilton.com', 'demo123', 'Operations Manager', 'MANAGEMENT', NULL, true),
    
    -- MVNO Admins
    ('paxtel@paxtel.com', 'demo123', 'Paxtel Admin', 'MVNO_ADMIN', v_paxtel_id, true),
    ('salamtel@salamtel.com', 'demo123', 'Salamtel Admin', 'MVNO_ADMIN', v_salamtel_id, true),
    ('agrotel@agrotel.com', 'demo123', 'Agrotel Admin', 'MVNO_ADMIN', v_agrotel_id, true),
    
    -- Distributors
    ('distributor1@channel.com', 'demo123', 'Channel Partner 1', 'DISTRIBUTOR', v_paxtel_id, true),
    ('distributor2@channel.com', 'demo123', 'Channel Partner 2', 'DISTRIBUTOR', v_salamtel_id, true)
  ON CONFLICT (email) DO NOTHING;
END $$;
