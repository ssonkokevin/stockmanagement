-- Add UPDATE policies for approval workflow

-- Stock Issuance Requests - UPDATE for anon (needed for approval)
DROP POLICY IF EXISTS "Allow anon update stock_issuance_requests" ON stock_issuance_requests;
CREATE POLICY "Allow anon update stock_issuance_requests" 
ON stock_issuance_requests FOR UPDATE TO anon USING (true) WITH CHECK (true);
GRANT UPDATE ON stock_issuance_requests TO anon;

-- Stock Requests - UPDATE for anon
DROP POLICY IF EXISTS "Allow anon update stock_requests" ON stock_requests;
CREATE POLICY "Allow anon update stock_requests" 
ON stock_requests FOR UPDATE TO anon USING (true) WITH CHECK (true);
GRANT UPDATE ON stock_requests TO anon;
