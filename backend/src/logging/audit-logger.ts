import * as fs from 'fs';
import * as path from 'path';
import { logLine, getDailyLogDir } from './unified-logger.js';

// ─── Audit Event Types ────────────────────────────────────────────────────────

export type AuditEventType =
  | 'USER_LOGIN_SUCCESS'
  | 'USER_LOGIN_FAILED'
  | 'USER_LOGOUT'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'UNAUTHORIZED_ACCESS'
  | 'APPROVAL_ATTEMPT'
  | 'APPROVAL_OVERRIDE'
  | 'STOCK_MODIFIED'
  | 'STOCK_DELETED'
  | 'ADMIN_ACTION'
  | 'SETTINGS_CHANGED'
  | 'EXPORT_DATA'
  | 'SUSPICIOUS_REQUEST';

export interface AuditEvent {
  event: AuditEventType;
  user?: string;
  ip?: string;
  role?: string;
  resource?: string;
  requestId?: string;
  trace?: string;
  reason?: string;
  meta?: Record<string, unknown>;
}

// ─── Audit log file (never auto-deleted) ─────────────────────────────────────

function getAuditLogPath(): string {
  const dir = getDailyLogDir();
  return path.join(dir, 'audit.log');
}

function appendAudit(line: string): void {
  try {
    fs.appendFileSync(getAuditLogPath(), `${line}\n`);
  } catch {
    // fail silently to not disrupt main flow
  }
}

// ─── Core audit logger ────────────────────────────────────────────────────────

export function logAudit(evt: AuditEvent): void {
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').slice(0, 23);

  const parts: string[] = [`[AUDIT] ${evt.event}`];
  if (evt.user)      parts.push(`user=${evt.user}`);
  if (evt.ip)        parts.push(`ip=${evt.ip}`);
  if (evt.role)      parts.push(`role=${evt.role}`);
  if (evt.resource)  parts.push(`resource=${evt.resource}`);
  if (evt.requestId) parts.push(`req=${evt.requestId.slice(0, 8)}`);
  if (evt.reason)    parts.push(`reason=${evt.reason}`);
  if (evt.trace)     parts.push(`trace=${evt.trace.slice(0, 8)}`);

  const line = `${ts} | ${parts.join(' | ')}`;
  appendAudit(line);

  const logLevel = evt.event.includes('FAILED') || evt.event.includes('DENIED') ||
    evt.event.includes('INVALID') || evt.event.includes('SUSPICIOUS') ||
    evt.event.includes('UNAUTHORIZED') ? 'WRN' : 'INF';

  logLine(logLevel, 'AUDIT', parts.slice(1).join(' | '), { trace: evt.trace, user: evt.user });
}

// ─── Typed helpers ────────────────────────────────────────────────────────────

export function auditLogin(params: {
  user: string; ip: string; role: string; success: boolean; reason?: string; trace?: string;
}): void {
  logAudit({
    event: params.success ? 'USER_LOGIN_SUCCESS' : 'USER_LOGIN_FAILED',
    user: params.user,
    ip: params.ip,
    role: params.role,
    reason: params.reason,
    trace: params.trace,
  });
}

export function auditPermissionDenied(params: {
  user?: string; ip?: string; resource: string; trace?: string;
}): void {
  logAudit({
    event: 'PERMISSION_DENIED',
    ...params,
  });
}

export function auditInvalidToken(params: {
  ip?: string; reason?: string; trace?: string;
}): void {
  logAudit({
    event: 'TOKEN_INVALID',
    ...params,
  });
}

export function auditStockModified(params: {
  user: string; resource: string; requestId?: string; trace?: string;
}): void {
  logAudit({
    event: 'STOCK_MODIFIED',
    ...params,
  });
}

export function auditAdminAction(params: {
  user: string; resource: string; role?: string; trace?: string; meta?: Record<string, unknown>;
}): void {
  logAudit({
    event: 'ADMIN_ACTION',
    ...params,
  });
}

export function auditExport(params: {
  user: string; resource: string; ip?: string; trace?: string;
}): void {
  logAudit({
    event: 'EXPORT_DATA',
    ...params,
  });
}

export function auditSuspicious(params: {
  ip?: string; user?: string; resource?: string; reason: string; trace?: string;
}): void {
  logAudit({
    event: 'SUSPICIOUS_REQUEST',
    ...params,
  });
}
