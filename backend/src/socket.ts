import type http from 'http';
import { config } from './config/index.js';
import { logLine } from './logging/unified-logger.js';
import { verifyJwt } from './routes/api.js';

type SocketIOServer = any;
let io: SocketIOServer | null = null;

export function initSocket(server: http.Server): SocketIOServer | null {
  if (io) return io;

  // Lazy-load socket.io so the backend can still boot even
  // when npm install is blocked in some environments.
  let SocketIO: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    SocketIO = require('socket.io');
  } catch {
    logLine('WRN', 'SOCKET', 'socket.io not installed; realtime updates disabled');
    io = null;
    return null;
  }

  const { Server } = SocketIO;

  io = new Server(server, {
    cors: {
      origin: config.cors.origins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    },
  });

  io.use((socket: any, next: any) => {
    try {
      const token = socket?.handshake?.auth?.token;
      if (!token) return next(new Error('Authentication required'));
      const payload = verifyJwt(String(token));
      socket.data = socket.data || {};
      socket.data.auth = payload;
      next();
    } catch (e: any) {
      next(new Error(e?.message || 'Invalid token'));
    }
  });

  io.on('connection', (socket: any) => {
    const role = socket?.data?.auth?.role;
    const mvnoId = socket?.data?.auth?.mvno_id;
    logLine('INF', 'SOCKET', `Client connected: ${socket.id} role=${role} mvno_id=${mvnoId || 'n/a'}`);

    socket.on('join', (room: string) => {
      if (typeof room !== 'string' || !room.trim()) return;
      socket.join(room);
      logLine('INF', 'SOCKET', `Client ${socket.id} joined room=${room}`);
    });

    socket.on('disconnect', (reason: string) => {
      logLine('INF', 'SOCKET', `Client disconnected: ${socket.id} reason=${reason}`);
    });
  });

  return io;
}

export function getIo(): SocketIOServer | null {
  return io;
}
