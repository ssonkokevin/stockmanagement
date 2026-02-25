import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { PlatformUser, PlatformRole, Mvno } from '../types/simcard';

interface AuthState {
  user: PlatformUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  role: PlatformRole | null;
  mvnoId: string | null;
  isSuperAdmin: boolean;
  isManagement: boolean;
  isMvnoAdmin: boolean;
  isDistributor: boolean;
}

const DEFAULT_ROLES: PlatformRole[] = ['SUPER_ADMIN', 'MANAGEMENT', 'MVNO_ADMIN', 'DISTRIBUTOR'];

export function usePlatformAuth() {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    isLoading: true,
    isAuthenticated: false,
    role: null,
    mvnoId: null,
    isSuperAdmin: false,
    isManagement: false,
    isMvnoAdmin: false,
    isDistributor: false,
  });

  // For demo purposes, we'll use a simple approach
  // In production, this would use Supabase Auth with JWT
  const checkAuth = useCallback(async () => {
    try {
      // Try to get user from localStorage (simple demo approach)
      const storedUser = localStorage.getItem('platform_user');
      
      if (storedUser) {
        const user = JSON.parse(storedUser) as PlatformUser;
        setAuthState({
          user,
          isLoading: false,
          isAuthenticated: true,
          role: user.role,
          mvnoId: user.mvno_id,
          isSuperAdmin: user.role === 'SUPER_ADMIN',
          isManagement: user.role === 'MANAGEMENT',
          isMvnoAdmin: user.role === 'MVNO_ADMIN',
          isDistributor: user.role === 'DISTRIBUTOR',
        });
        return;
      }

      // If no stored user, check Supabase auth
      const { data: { user: supabaseUser } } = await supabase.auth.getUser();
      
      if (supabaseUser) {
        // Fetch platform user from our table
        const { data: platformUser } = await supabase
          .from('platform_users')
          .select('*')
          .eq('email', supabaseUser.email)
          .single();

        if (platformUser) {
          setAuthState({
            user: platformUser,
            isLoading: false,
            isAuthenticated: true,
            role: platformUser.role,
            mvnoId: platformUser.mvno_id,
            isSuperAdmin: platformUser.role === 'SUPER_ADMIN',
            isManagement: platformUser.role === 'MANAGEMENT',
            isMvnoAdmin: platformUser.role === 'MVNO_ADMIN',
            isDistributor: platformUser.role === 'DISTRIBUTOR',
          });
          return;
        }
      }

      // No authenticated user
      setAuthState({
        user: null,
        isLoading: false,
        isAuthenticated: false,
        role: null,
        mvnoId: null,
        isSuperAdmin: false,
        isManagement: false,
        isMvnoAdmin: false,
        isDistributor: false,
      });
    } catch (error) {
      console.error('Auth check error:', error);
      setAuthState(prev => ({ ...prev, isLoading: false }));
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Login function
  const login = async (email: string, password: string): Promise<{ success: boolean; message: string }> => {
    try {
      // For demo, check against platform_users table
      // In production, use Supabase Auth
      const { data, error } = await supabase
        .from('platform_users')
        .select('*')
        .eq('email', email)
        .single();

      if (error || !data) {
        return { success: false, message: 'Invalid credentials' };
      }

      // Simple password check (in production, use proper hashing)
      // For demo purposes, accept any password for existing users
      // In production: const passwordHash = await hash(password, 10);
      
      // Store in localStorage for demo
      localStorage.setItem('platform_user', JSON.stringify(data));
      
      setAuthState({
        user: data,
        isLoading: false,
        isAuthenticated: true,
        role: data.role,
        mvnoId: data.mvno_id,
        isSuperAdmin: data.role === 'SUPER_ADMIN',
        isManagement: data.role === 'MANAGEMENT',
        isMvnoAdmin: data.role === 'MVNO_ADMIN',
        isDistributor: data.role === 'DISTRIBUTOR',
      });

      return { success: true, message: 'Login successful' };
    } catch (error) {
      console.error('Login error:', error);
      return { success: false, message: 'Login failed' };
    }
  };

  // Logout function
  const logout = async () => {
    localStorage.removeItem('platform_user');
    await supabase.auth.signOut();
    setAuthState({
      user: null,
      isLoading: false,
      isAuthenticated: false,
      role: null,
      mvnoId: null,
      isSuperAdmin: false,
      isManagement: false,
      isMvnoAdmin: false,
      isDistributor: false,
    });
  };

  // Check if user has required role
  const hasRole = (requiredRoles: PlatformRole[]) => {
    if (!authState.role) return false;
    return requiredRoles.includes(authState.role);
  };

  // Check if user can access MVNO data
  const canAccessMvno = (mvnoId: string) => {
    if (authState.isSuperAdmin) return true;
    if (authState.isManagement) return true;
    if (authState.isMvnoAdmin && authState.mvnoId === mvnoId) return true;
    return false;
  };

  return {
    ...authState,
    login,
    logout,
    checkAuth,
    hasRole,
    canAccessMvno,
    refetch: checkAuth,
  };
}

// Demo users for testing
export const DEMO_USERS: { email: string; role: PlatformRole; mvno?: string; name: string }[] = [
  { email: 'admin@hamilton.com', role: 'SUPER_ADMIN', name: 'Super Admin' },
  { email: 'manager@hamilton.com', role: 'MANAGEMENT', name: 'Management' },
  { email: 'paxtel@paxtel.com', role: 'MVNO_ADMIN', mvno: 'PAXTEL', name: 'Paxtel Admin' },
  { email: 'salamtel@salamtel.com', role: 'MVNO_ADMIN', mvno: 'SALAMTEL', name: 'Salamtel Admin' },
  { email: 'agrotel@agrotel.com', role: 'MVNO_ADMIN', mvno: 'AGROTEL', name: 'Agrotel Admin' },
  { email: 'distributor@channel.com', role: 'DISTRIBUTOR', name: 'Channel Distributor' },
];
