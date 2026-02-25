-- ============================================
-- Sample Agrotel eSIMs for verification (4 SIMs)
-- ============================================

-- Get the Agrotel MVNO ID
DO $$
DECLARE
  v_agrotel_id UUID;
BEGIN
  SELECT id INTO v_agrotel_id FROM mvnos WHERE name = 'AGROTEL';
  
  RAISE NOTICE 'Agrotel ID: %', v_agrotel_id;

  -- Insert 4 sample Agrotel eSIMs for verification
  INSERT INTO esim_stock (iccid, imsi, mvno_id, status) VALUES
    ('8925620100000017631', 641200019999752, v_agrotel_id, 'IN_STORE'),
    ('8925620100000017649', 641200019999753, v_agrotel_id, 'IN_STORE'),
    ('8925620100000017656', 641200019999754, v_agrotel_id, 'IN_STORE'),
    ('8925620100000017664', 641200019999755, v_agrotel_id, 'IN_STORE')
  ON CONFLICT (iccid) DO NOTHING;
  
  RAISE NOTICE 'Inserted 4 sample Agrotel eSIMs for verification';
END $$;
