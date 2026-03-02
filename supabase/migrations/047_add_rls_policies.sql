-- Add RLS policies for external distributor forms to work without authentication
-- This fixes the "new row violates row-level security policy" errors

-- ============================================
-- 1. Stock Issuance Requests - INSERT
-- ============================================
DROP POLICY IF EXISTS "Allow anon insert stock_issuance_requests" ON stock_issuance_requests;
CREATE POLICY "Allow anon insert stock_issuance_requests" 
ON stock_issuance_requests FOR INSERT TO anon WITH CHECK (true);
GRANT INSERT ON stock_issuance_requests TO authenticated;

-- ============================================
-- 2. Stock Requests - INSERT  
-- ============================================
DROP POLICY IF EXISTS "Allow anon insert stock_requests" ON stock_requests;
CREATE POLICY "Allow anon insert stock_requests" 
ON stock_requests FOR INSERT TO anon WITH CHECK (true);
GRANT INSERT ON stock_requests TO authenticated, anon;

-- ============================================
-- 3. SELECT policies for viewing data (needed for dashboards)
-- ============================================

-- Stock Issuance Requests - SELECT for authenticated users
DROP POLICY IF EXISTS "Allow authenticated select stock_issuance_requests" ON stock_issuance_requests;
CREATE POLICY "Allow authenticated select stock_issuance_requests" 
ON stock_issuance_requests FOR SELECT TO authenticated USING (true);
GRANT SELECT ON stock_issuance_requests TO authenticated;

-- Stock Requests - SELECT for authenticated users  
DROP POLICY IF EXISTS "Allow authenticated select stock_requests" ON stock_requests;
CREATE POLICY "Allow authenticated select stock_requests" 
ON stock_requests FOR SELECT TO authenticated USING (true);
GRANT SELECT ON stock_requests TO authenticated;
