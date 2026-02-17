-- ============================================
-- FUNCTIONS, TRIGGERS, VIEWS, SAMPLE DATA
-- ============================================

-- Update distributor updated_at
CREATE OR REPLACE FUNCTION update_distributor_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS distributor_updated_at ON distributors;
CREATE TRIGGER distributor_updated_at
  BEFORE UPDATE ON distributors
  FOR EACH ROW EXECUTE FUNCTION update_distributor_updated_at();

-- Distributor balance trigger
CREATE OR REPLACE FUNCTION update_distributor_balance()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO distributor_balances (distributor_id, total_sims_received, last_transaction_date, updated_at)
  VALUES (NEW.distributor_id, NEW.quantity, NOW(), NOW())
  ON CONFLICT (distributor_id) DO UPDATE SET
    total_sims_received = distributor_balances.total_sims_received + NEW.quantity,
    last_transaction_date = NOW(),
    updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_distributor_balance_trigger ON stock_distributions;
CREATE TRIGGER update_distributor_balance_trigger
  AFTER INSERT ON stock_distributions
  FOR EACH ROW EXECUTE FUNCTION update_distributor_balance();

-- Generate 40 cartons of physical SIM stock (Paxtel)
-- IMSI: 641201100014001 to 641201100214000 (200k)
-- ICCID: 89256200000000025001 to 89256200000000225000 (200k)
CREATE OR REPLACE FUNCTION generate_physical_sim_stock()
RETURNS void AS $$
DECLARE
  mvno_paxtel_id UUID;
  carton_idx INT;
  box_idx INT;
  carton_id_val UUID;
  box_id_val UUID;
  carton_imsi_start BIGINT;
  carton_imsi_end BIGINT;
  carton_iccid_start BIGINT;
  carton_iccid_end BIGINT;
  box_imsi_start BIGINT;
  box_imsi_end BIGINT;
  box_iccid_start BIGINT;
  box_iccid_end BIGINT;
BEGIN
  SELECT id INTO mvno_paxtel_id FROM mvnos WHERE name = 'PAXTEL' LIMIT 1;
  IF mvno_paxtel_id IS NULL THEN
    RAISE EXCEPTION 'PAXTEL MVNO not found';
  END IF;

  IF EXISTS (SELECT 1 FROM cartons WHERE mvno_id = mvno_paxtel_id LIMIT 1) THEN
    RAISE NOTICE 'Paxtel cartons already exist - skipping';
    RETURN;
  END IF;

  FOR carton_idx IN 1..40 LOOP
    carton_imsi_start := 641201100014001 + (carton_idx - 1) * 5000;
    carton_imsi_end := carton_imsi_start + 4999;
    carton_iccid_start := 89256200000000025001 + (carton_idx - 1) * 5000;
    carton_iccid_end := carton_iccid_start + 4999;

    INSERT INTO cartons (carton_number, mvno_id, imsi_start, imsi_end, iccid_start, iccid_end, total_boxes, sims_per_box)
    VALUES (
      carton_idx || '/40',
      mvno_paxtel_id,
      carton_imsi_start,
      carton_imsi_end,
      LPAD(carton_iccid_start::TEXT, 20, '0'),
      LPAD(carton_iccid_end::TEXT, 20, '0'),
      20,
      250
    ) RETURNING id INTO carton_id_val;

    FOR box_idx IN 1..20 LOOP
      box_imsi_start := carton_imsi_start + (box_idx - 1) * 250;
      box_imsi_end := box_imsi_start + 249;
      box_iccid_start := carton_iccid_start + (box_idx - 1) * 250;
      box_iccid_end := box_iccid_start + 249;

      INSERT INTO boxes (carton_id, box_number, iccid_start, iccid_end, imsi_start, imsi_end, total_sims)
      VALUES (
        carton_id_val,
        box_idx,
        LPAD(box_iccid_start::TEXT, 20, '0'),
        LPAD(box_iccid_end::TEXT, 20, '0'),
        box_imsi_start,
        box_imsi_end,
        250
      ) RETURNING id INTO box_id_val;

      -- Optional: Insert 250 individual physical_sims per box (200k rows total - SLOW)
      -- Uncomment the loop below only if you need per-SIM tracking
      /*
      FOR sim_idx IN 0..249 LOOP
        imsi_val := box_imsi_start + sim_idx;
        iccid_str := LPAD((box_iccid_start + sim_idx)::TEXT, 20, '0');
        INSERT INTO physical_sims (iccid, imsi, mvno_id, carton_id, box_id, status)
        VALUES (iccid_str, imsi_val, mvno_paxtel_id, carton_id_val, box_id_val, 'IN_STORE')
        ON CONFLICT (iccid) DO NOTHING;
      END LOOP;
      */
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Generated 40 cartons (200,000 physical SIMs) for PAXTEL';
END;
$$ LANGUAGE plpgsql;

-- eSIM autocomplete suggestion
CREATE OR REPLACE FUNCTION suggest_available_esims(p_mvno_name mvno_name, p_search_term VARCHAR DEFAULT '')
RETURNS TABLE(iccid VARCHAR(22), imsi BIGINT, mvno_name TEXT, status sim_status) AS $$
BEGIN
  RETURN QUERY
  SELECT es.iccid, es.imsi, m.name::TEXT, es.status
  FROM esim_stock es
  JOIN mvnos m ON es.mvno_id = m.id
  WHERE m.name = p_mvno_name
    AND es.status = 'IN_STORE'
    AND (p_search_term = '' OR es.iccid LIKE p_search_term || '%')
  ORDER BY es.iccid
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- VIEWS
-- ============================================
CREATE OR REPLACE VIEW current_stock_view AS
SELECT m.name AS mvno, 'PHYSICAL'::TEXT AS sim_type,
  COUNT(*) AS total_stock,
  COUNT(*) FILTER (WHERE ps.status = 'IN_STORE') AS in_store,
  COUNT(*) FILTER (WHERE ps.status = 'ISSUED') AS issued,
  COUNT(*) FILTER (WHERE ps.status = 'ACTIVATED') AS activated,
  COUNT(*) FILTER (WHERE ps.status = 'SOLD') AS sold,
  COUNT(*) FILTER (WHERE ps.status = 'FAILED') AS failed
FROM physical_sims ps
JOIN mvnos m ON ps.mvno_id = m.id
GROUP BY m.name
UNION ALL
SELECT m.name, 'ESIM',
  COUNT(*),
  COUNT(*) FILTER (WHERE es.status = 'IN_STORE'),
  COUNT(*) FILTER (WHERE es.status = 'ISSUED'),
  COUNT(*) FILTER (WHERE es.status = 'ACTIVATED'),
  COUNT(*) FILTER (WHERE es.status = 'SOLD'),
  COUNT(*) FILTER (WHERE es.status = 'FAILED')
FROM esim_stock es
JOIN mvnos m ON es.mvno_id = m.id
GROUP BY m.name
ORDER BY 1, 2;

CREATE OR REPLACE VIEW distribution_summary_view AS
SELECT sd.distribution_date, d.name AS distributor_name, d.type AS distributor_type,
  d.location, m.name AS mvno, sd.purpose, sd.sim_type, sd.quantity,
  sd.status AS distribution_status,
  COUNT(dd.id) AS sims_issued,
  COUNT(dd.id) FILTER (WHERE dd.status = 'ACTIVATED') AS sims_activated,
  COUNT(dd.id) FILTER (WHERE dd.status = 'FAILED') AS sims_failed,
  COUNT(dd.id) FILTER (WHERE dd.status = 'ISSUED') AS sims_pending,
  COUNT(dd.id) FILTER (WHERE dd.boss_verified) AS boss_verified
FROM stock_distributions sd
JOIN distributors d ON sd.distributor_id = d.id
JOIN mvnos m ON sd.mvno_id = m.id
LEFT JOIN distribution_details dd ON sd.id = dd.distribution_id
GROUP BY sd.id, sd.distribution_date, sd.purpose, sd.sim_type, sd.quantity, sd.status,
  d.id, d.name, d.type, d.location, m.name;

-- ============================================
-- SAMPLE DISTRIBUTORS
-- ============================================
-- Sample distributors (run once)
INSERT INTO distributors (name, type, location, contact_person) VALUES
  ('Ben Kiwanuka Service Center', 'SERVICE_CENTER', 'Kampala', 'Ben Kiwanuka'),
  ('Masaka Service Centre', 'SERVICE_CENTER', 'Masaka', 'Masaka Manager'),
  ('PAXTEL Service Center', 'SERVICE_CENTER', 'Kampala', 'Service Center Manager'),
  ('PAXTEL Masaka', 'SERVICE_CENTER', 'Masaka', 'Masaka PAXTEL Manager'),
  ('Seamless Distributor', 'DISTRIBUTOR', NULL, 'Seamless Contact'),
  ('B2B Growth Ltd', 'CHANNEL_PARTNER', NULL, 'B2B Manager'),
  ('Mazzi Systems Ltd', 'CHANNEL_PARTNER', NULL, 'Mazzi Contact'),
  ('Management', 'MANAGEMENT', NULL, 'System Admin'),
  ('Hamilton Telecom', 'DISTRIBUTOR', NULL, 'Hamilton Manager');

-- Generate 40 cartons of Paxtel physical SIMs (cartons + boxes only, no individual SIMs)
SELECT generate_physical_sim_stock();
