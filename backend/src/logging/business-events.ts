import { logLine } from './unified-logger.js';

// ─── Business Event Types ─────────────────────────────────────────────────────

export type BusinessEventType =
  | 'STOCK_IMPORTED'
  | 'STOCK_ASSIGNED'
  | 'STOCK_TRANSFERRED'
  | 'STOCK_RETURNED'
  | 'STOCK_REVERSED'
  | 'APPROVAL_CREATED'
  | 'APPROVAL_COMPLETED'
  | 'APPROVAL_REJECTED'
  | 'LOW_STOCK_ALERT'
  | 'DISTRIBUTOR_CREATED'
  | 'DISTRIBUTOR_UPDATED'
  | 'ESIM_BATCH_CREATED'
  | 'ESIM_ACTIVATED'
  | 'USER_LOGIN'
  | 'USER_LOGOUT'
  | 'MVNO_CREATED'
  | 'MVNO_SETTINGS_CHANGED'
  | 'REQUEST_CANCELLED'
  | 'REQUEST_SUBMITTED';

export interface BusinessEvent {
  event: BusinessEventType;
  user?: string;
  mvno?: string;
  distributor?: string;
  quantity?: number;
  requestId?: string;
  range?: string;
  simType?: 'PHYSICAL' | 'ESIM' | 'ALL';
  trace?: string;
  meta?: Record<string, unknown>;
}

// ─── Core event logger ────────────────────────────────────────────────────────

export function logBusinessEvent(evt: BusinessEvent): void {
  const parts: string[] = [evt.event];

  if (evt.requestId) parts.push(`req=${evt.requestId.slice(0, 8)}`);
  if (evt.user)      parts.push(`user=${evt.user}`);
  if (evt.mvno)      parts.push(`mvno=${evt.mvno}`);
  if (evt.distributor) parts.push(`dist=${evt.distributor}`);
  if (evt.simType)   parts.push(`type=${evt.simType}`);
  if (evt.quantity !== undefined) parts.push(`qty=${evt.quantity.toLocaleString()}`);
  if (evt.range)     parts.push(`range=${evt.range}`);

  const level =
    evt.event === 'LOW_STOCK_ALERT' ? 'WRN' :
    evt.event.includes('REJECTED') ? 'WRN' : 'INF';

  logLine(level, 'BUSINESS', parts.join(' | '), {
    trace: evt.trace,
    user:  evt.user,
    ...evt.meta,
  });
}

// ─── Typed helpers ────────────────────────────────────────────────────────────

export function logStockImported(params: {
  user: string; mvno: string; quantity: number; simType: 'PHYSICAL' | 'ESIM'; trace?: string;
}): void {
  logBusinessEvent({ event: 'STOCK_IMPORTED', ...params });
}

export function logStockAssigned(params: {
  user: string; mvno: string; distributor: string; quantity: number;
  requestId: string; simType: 'PHYSICAL' | 'ESIM'; range?: string; trace?: string;
}): void {
  logBusinessEvent({ event: 'STOCK_ASSIGNED', ...params });
}

export function logApprovalCreated(params: {
  user: string; mvno: string; distributor: string; quantity: number;
  requestId: string; simType: 'PHYSICAL' | 'ESIM'; trace?: string;
}): void {
  logBusinessEvent({ event: 'APPROVAL_CREATED', ...params });
}

export function logApprovalCompleted(params: {
  user: string; requestId: string; mvno?: string; distributor?: string; trace?: string;
}): void {
  logBusinessEvent({ event: 'APPROVAL_COMPLETED', ...params });
}

export function logApprovalRejected(params: {
  user: string; requestId: string; mvno?: string; trace?: string;
}): void {
  logBusinessEvent({ event: 'APPROVAL_REJECTED', ...params });
}

export function logLowStockAlert(params: {
  mvno: string; quantity: number; threshold: number; simType: 'PHYSICAL' | 'ESIM'; trace?: string;
}): void {
  logBusinessEvent({
    event: 'LOW_STOCK_ALERT',
    mvno: params.mvno,
    quantity: params.quantity,
    simType: params.simType,
    trace: params.trace,
    meta: { threshold: params.threshold },
  });
}

export function logDistributorCreated(params: {
  user: string; mvno: string; distributor: string; trace?: string;
}): void {
  logBusinessEvent({ event: 'DISTRIBUTOR_CREATED', ...params });
}

export function logStockReversed(params: {
  user: string; requestId: string; mvno?: string; distributor?: string; trace?: string;
}): void {
  logBusinessEvent({ event: 'STOCK_REVERSED', ...params });
}

export function logRequestCancelled(params: {
  user: string; requestId: string; trace?: string;
}): void {
  logBusinessEvent({ event: 'REQUEST_CANCELLED', ...params });
}
