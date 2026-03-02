-- Add SELECT policies for anon role (app uses anon key, not authenticated sessions)

-- Stock Issuance Requests - SELECT for anon
DROP POLICY IF EXISTS "Allow anon select stock_issuance_requests" ON stock_issuance_requests;
CREATE POLICY "Allow anon select stock_issuance_requests" 
ON stock_issuance_requests FOR SELECT TO anon USING (true);
GRANT SELECT ON stock_issuance_requests TO anon;

-- Stock Requests - SELECT for anon
DROP POLICY IF EXISTS "Allow anon select stock_requests" ON stock_requests;
CREATE POLICY "Allow anon select stock_requests" 
ON stock_requests FOR SELECT TO anon USING (true);
GRANT SELECT ON stock_requests TO anon;
