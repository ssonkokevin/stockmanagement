-- ============================================
-- Functions to issue/update eSIM stock
-- ============================================

-- Function to issue (assign) eSIMs to a distributor
CREATE OR REPLACE FUNCTION issue_esims(
  p_operator TEXT,
  p_quantity INTEGER,
  p_distributor_name TEXT DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
  v_updated INTEGER := 0;
BEGIN
  -- Update the specified number of available eSIMs to 'assigned' status
  UPDATE esim_stock
  SET status = 'assigned'
  WHERE id IN (
    SELECT id FROM esim_stock
    WHERE operator = p_operator AND status = 'available'
    ORDER BY created_at
    LIMIT p_quantity
  );
  
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql;

-- Function to activate issued eSIMs
CREATE OR REPLACE FUNCTION activate_esims(
  p_operator TEXT,
  p_quantity INTEGER
)
RETURNS INTEGER AS $$
DECLARE
  v_updated INTEGER := 0;
BEGIN
  UPDATE esim_stock
  SET status = 'activated'
  WHERE id IN (
    SELECT id FROM esim_stock
    WHERE operator = p_operator AND status = 'assigned'
    ORDER BY created_at
    LIMIT p_quantity
  );
  
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql;

-- Function to return eSIMs back to available stock
CREATE OR REPLACE FUNCTION return_esims(
  p_operator TEXT,
  p_quantity INTEGER
)
RETURNS INTEGER AS $$
DECLARE
  v_updated INTEGER := 0;
BEGIN
  UPDATE esim_stock
  SET status = 'available'
  WHERE id IN (
    SELECT id FROM esim_stock
    WHERE operator = p_operator AND status IN ('assigned', 'activated')
    ORDER BY created_at DESC
    LIMIT p_quantity
  );
  
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION issue_esims(TEXT, INTEGER, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION activate_esims(TEXT, INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION return_esims(TEXT, INTEGER) TO anon, authenticated;

-- Example usage:
-- SELECT issue_esims('PAXTEL', 10, 'Distributor Name');
-- SELECT activate_esims('PAXTEL', 5);
-- SELECT return_esims('PAXTEL', 3);

-- Verify current stock status
SELECT 
  operator,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE status = 'available') as available,
  COUNT(*) FILTER (WHERE status = 'assigned') as assigned,
  COUNT(*) FILTER (WHERE status = 'activated') as activated
FROM esim_stock
GROUP BY operator
ORDER BY operator;
