import dotenv from 'dotenv';

// Load environment variables
dotenv.config();
dotenv.config({ path: '.env.local', override: true });

export const config = {
  // Server
  port: parseInt(process.env.APP_PORT || '3001'),
  
  // Database
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '53cur3@kevin',
    database: process.env.DB_NAME || 'simcard_stock',
  },
  
  // Mailjet (Email)
  mailjet: {
    apiKey: process.env.MAILJET_API_KEY || '',
    secretKey: process.env.MAILJET_SECRET_KEY || '',
    fromEmail: process.env.MAILJET_FROM_EMAIL || 'noreply@yourdomain.com',
  },

  // SMTP (Gmail / generic)
  smtp: {
    fromEmail: (process.env.EMAIL_FROM || process.env.MAILJET_FROM_EMAIL || 'noreply@yourdomain.com').trim(),
    user: (process.env.SMTP_USER || process.env.EMAIL_FROM || '').trim(),
    defaultTo: (process.env.EMAIL_TO || '').trim(),
    password: (process.env.EMAIL_PASSWORD || '').trim(),
    server: (process.env.SMTP_SERVER || '').trim(),
    port: parseInt(process.env.SMTP_PORT || '587'),
  },
  
  // SendGrid (Legacy - kept for compatibility)
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY || '',
    fromEmail: process.env.SENDGRID_FROM_EMAIL || 'noreply@yourdomain.com',
  },
  
  // App
  app: {
    baseUrl: process.env.BASE_URL || 'http://localhost:3001',
    // FRONTEND_URL must be set in production (e.g., https://admin.yourdomain.com)
    // Falls back to localhost only in development
    frontendUrl: process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173'),
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  
  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || 'hamilton-simcard-jwt-secret-2024-change-in-prod',
    expiresIn: parseInt(process.env.JWT_EXPIRES_IN_SECONDS || String(24 * 3600)),
  },

  // Allowed CORS origins (all portal dev ports + production)
  cors: {
    origins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://localhost:5175,http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:5175').split(',').map(s => s.trim()),
  },
};
