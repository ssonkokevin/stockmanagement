import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: string;
  tenantId?: string | null;
  mvnoId?: string | null;
}

export interface Notification {
  id: string;
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
  payload?: any;
}

interface AppState {
  currentUser: CurrentUser | null;
  authToken: string | null;
  sidebarCollapsed: boolean;
  notifications: Notification[];
  unreadCount: number;

  setUser: (user: CurrentUser | null) => void;
  setToken: (token: string | null) => void;
  toggleSidebar: () => void;
  addNotification: (n: Omit<Notification, 'read'> & { read?: boolean }) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
}

function recomputeUnread(notifications: Notification[]) {
  return notifications.reduce((acc, n) => acc + (n.read ? 0 : 1), 0);
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      currentUser: null,
      authToken: null,
      sidebarCollapsed: false,
      notifications: [],
      unreadCount: 0,

      setUser: (user) => set({ currentUser: user }),
      setToken: (token) => set({ authToken: token }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      addNotification: (n) =>
        set((s) => {
          const id = n.id || crypto.randomUUID();
          const createdAt = n.createdAt || new Date().toISOString();
          const next: Notification = {
            id,
            title: n.title,
            message: n.message,
            createdAt,
            read: n.read ?? false,
            payload: n.payload,
          };
          const notifications = [next, ...s.notifications].slice(0, 100);
          return { notifications, unreadCount: recomputeUnread(notifications) };
        }),

      markRead: (id) =>
        set((s) => {
          const notifications = s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
          return { notifications, unreadCount: recomputeUnread(notifications) };
        }),

      markAllRead: () =>
        set((s) => {
          const notifications = s.notifications.map((n) => ({ ...n, read: true }));
          return { notifications, unreadCount: 0 };
        }),
    }),
    {
      name: 'paxtel_app',
      partialize: (state) => ({
        currentUser: state.currentUser,
        authToken: state.authToken,
      }),
    }
  )
);

