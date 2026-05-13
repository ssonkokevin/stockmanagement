import axios from 'axios';
import type { DashboardStats, PagedResponse, SimRequest } from '../types';
import { useAppStore } from '../store/useAppStore';

const BASE =
  import.meta.env.VITE_API_BASE_URL ||
  'http://localhost:3001/api/mvno-admin';

const api = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = useAppStore.getState().authToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

function unwrap<T>(resp: any): T {
  return resp?.data?.data as T;
}

function errMessage(err: any): string {
  return (
    err?.response?.data?.message ||
    err?.message ||
    'Request failed'
  );
}

export async function fetchDashboardStats(): Promise<DashboardStats> {
  try {
    const resp = await api.get('/dashboard/stats');
    return unwrap<DashboardStats>(resp);
  } catch (e: any) {
    throw new Error(errMessage(e));
  }
}

export interface FetchSimRequestsParams {
  status?: string; // can be "PENDING" or "PENDING,ESCALATED"
  page?: number;
  limit?: number;
  search?: string;
  sim_type?: string;
  date_from?: string;
  date_to?: string;
}

export async function fetchSimRequests(params: FetchSimRequestsParams = {}): Promise<PagedResponse<SimRequest>> {
  const status = (params.status || '').trim();
  const statuses = status.includes(',') ? status.split(',').map((s) => s.trim()).filter(Boolean) : [];

  const doFetch = async (singleStatus?: string) => {
    const qs = new URLSearchParams();
    if (singleStatus) qs.set('status', singleStatus);
    if (params.search) qs.set('search', params.search);
    if (params.sim_type) qs.set('sim_type', params.sim_type);
    if (params.date_from) qs.set('date_from', params.date_from);
    if (params.date_to) qs.set('date_to', params.date_to);
    qs.set('page', String(params.page ?? 1));
    qs.set('limit', String(params.limit ?? 25));
    const resp = await api.get(`/sim-requests?${qs.toString()}`);
    return unwrap<PagedResponse<SimRequest>>(resp);
  };

  try {
    if (statuses.length) {
      const results = await Promise.all(statuses.map((s) => doFetch(s)));
      const rows = results.flatMap((r) => r.rows);
      const seen = new Set<string>();
      const merged = rows.filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
      // Keep escalated first like backend order intent
      merged.sort((a, b) => {
        const rank = (s: string) => (s === 'ESCALATED' ? 0 : s === 'PENDING' ? 1 : 2);
        const r = rank(a.status) - rank(b.status);
        if (r !== 0) return r;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
      return {
        rows: merged,
        total: results.reduce((acc, r) => acc + (r.total || 0), 0),
        page: 1,
        limit: params.limit ?? 25,
      };
    }

    return await doFetch(status || undefined);
  } catch (e: any) {
    throw new Error(errMessage(e));
  }
}

export async function fetchSimRequestById(id: string): Promise<SimRequest> {
  try {
    const resp = await api.get(`/sim-requests/${id}`);
    return unwrap<SimRequest>(resp);
  } catch (e: any) {
    throw new Error(errMessage(e));
  }
}

export async function approveRequest(id: string, notes?: string | null) {
  try {
    const resp = await api.patch(`/sim-requests/${id}/approve`, { notes: notes || undefined });
    return unwrap<any>(resp);
  } catch (e: any) {
    throw new Error(errMessage(e));
  }
}

export async function rejectRequest(id: string, reason: string) {
  try {
    const resp = await api.patch(`/sim-requests/${id}/reject`, { reason });
    return unwrap<any>(resp);
  } catch (e: any) {
    throw new Error(errMessage(e));
  }
}

export async function fetchPhysicalStock() {
  try {
    const resp = await api.get('/physical-stock');
    return unwrap<any>(resp);
  } catch (e: any) {
    throw new Error(errMessage(e));
  }
}

export async function fetchEsimStock() {
  try {
    const resp = await api.get('/esim-stock');
    return unwrap<any>(resp);
  } catch (e: any) {
    throw new Error(errMessage(e));
  }
}

