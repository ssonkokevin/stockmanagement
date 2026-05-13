import { create } from 'zustand';
import type { AuthUser } from '../types';

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  setAuth: (user: AuthUser, token: string) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: (() => {
    try {
      const raw = localStorage.getItem('paxtel_user');
      return raw ? (JSON.parse(raw) as AuthUser) : null;
    } catch {
      return null;
    }
  })(),
  token: localStorage.getItem('paxtel_token'),
  isAuthenticated: !!localStorage.getItem('paxtel_token'),

  setAuth: (user, token) => {
    localStorage.setItem('paxtel_token', token);
    localStorage.setItem('paxtel_user', JSON.stringify(user));
    set({ user, token, isAuthenticated: true });
  },

  clearAuth: () => {
    localStorage.removeItem('paxtel_token');
    localStorage.removeItem('paxtel_user');
    set({ user: null, token: null, isAuthenticated: false });
  },
}));
