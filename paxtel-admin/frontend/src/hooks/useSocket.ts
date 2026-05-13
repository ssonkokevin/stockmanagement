import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { useAppStore } from '../store/useAppStore';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

export function useSocket() {
  const queryClient = useQueryClient();
  const token = useAppStore((s) => s.authToken);
  const addNotification = useAppStore((s) => s.addNotification);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!token) return;

    let retry = 0;
    let stopped = false;

    const connect = () => {
      if (stopped) return;

      const socket = io(SOCKET_URL, {
        transports: ['websocket'],
        auth: { token },
        reconnection: false,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        retry = 0;
        socket.emit('join', `mvno:${import.meta.env.VITE_TENANT_SLUG || 'paxtel'}`);
      });

      socket.on('mvno_admin:request_updated', (payload: any) => {
        queryClient.invalidateQueries({ queryKey: ['sim-requests'] });
        queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
        addNotification({
          id: payload?.id || crypto.randomUUID(),
          title: 'Request updated',
          message: `Request ${String(payload?.id || '').slice(0, 8)} status: ${payload?.status || 'UPDATED'}`,
          createdAt: new Date().toISOString(),
          payload,
        });
      });

      socket.on('stock:low', () => {
        toast('Stock running low — check Physical Stock page', { icon: '⚠️' });
      });

      const scheduleReconnect = () => {
        if (stopped) return;
        retry += 1;
        const wait = Math.min(30_000, 500 * Math.pow(2, retry));
        setTimeout(connect, wait);
      };

      socket.on('disconnect', scheduleReconnect);
      socket.on('connect_error', scheduleReconnect);
    };

    connect();

    return () => {
      stopped = true;
      try {
        socketRef.current?.disconnect();
      } catch {
      }
      socketRef.current = null;
    };
  }, [token, queryClient, addNotification]);
}

