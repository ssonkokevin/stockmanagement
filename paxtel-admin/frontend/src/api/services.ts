import { api } from './client';
import type { DashboardStats, SimRequest, PagedResponse } from '../types';

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function login(email: string, password: string) {
  const { data } = await api.post('/auth/login', { email, password });
  return data.data as { token: string; user: any };
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export async function getDashboardStats(): Promise<DashboardStats> {
  const { data } = await api.get('/mvno-admin/dashboard/stats');
  return data.data as DashboardStats;
}

// ── Sim Requests ──────────────────────────────────────────────────────────────
export interface RequestFilters {
  status?: string;
  sim_type?: string;
  search?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  limit?: number;
}

export async function getSimRequests(filters: RequestFilters = {}): Promise<PagedResponse<SimRequest>> {
  const params = new URLSearchParams();
  if (filters.status)    params.set('status',    filters.status);
  if (filters.sim_type)  params.set('sim_type',  filters.sim_type);
  if (filters.search)    params.set('search',    filters.search);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to)   params.set('date_to',   filters.date_to);
  params.set('page',  String(filters.page  ?? 1));
  params.set('limit', String(filters.limit ?? 25));
  const { data } = await api.get(`/mvno-admin/sim-requests?${params}`);
  return data.data as PagedResponse<SimRequest>;
}

export async function getSimRequest(id: string): Promise<SimRequest> {
  const { data } = await api.get(`/mvno-admin/sim-requests/${id}`);
  return data.data as SimRequest;
}

export async function approveRequest(id: string, notes?: string) {
  const { data } = await api.patch(`/mvno-admin/sim-requests/${id}/approve`, { notes });
  return data;
}

export async function rejectRequest(id: string, reason: string) {
  const { data } = await api.patch(`/mvno-admin/sim-requests/${id}/reject`, { reason });
  return data;
}

export async function escalateRequest(id: string, reason: string) {
  const { data } = await api.patch(`/mvno-admin/sim-requests/${id}/escalate`, { reason });
  return data;
}
