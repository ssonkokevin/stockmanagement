-- ============================================
-- Fix RLS on esim_stock to allow all access
-- ============================================

-- Drop existing policies
DROP POLICY IF EXISTS "Allow all access to esim_stock" ON esim_stock;
DROP POLICY IF EXISTS "Allow all" ON esim_stock;
DROP POLICY IF EXISTS "Enable all access" ON esim_stock;

-- Create a permissive policy that allows all access
CREATE POLICY "esim_stock_all_access" ON esim_stock
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- Verify the policy
SELECT policyname, cmd, qual, with_check 
FROM pg_policies 
WHERE tablename = 'esim_stock';
