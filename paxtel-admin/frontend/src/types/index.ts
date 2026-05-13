export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'ESCALATED' | 'COMPLETED';
export type SimType = 'PHYSICAL' | 'ESIM';

export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  role: string;
  mvno_id: string | null;
}

export interface SimRequest {
  id: string;
  request_ref: string;
  distributor_id: string;
  distributor_name: string;
  contact_person: string | null;
  contact_email: string | null;
  sim_type: SimType;
  quantity: number;
  status: RequestStatus;
  notes: string | null;
  rejection_reason: string | null;
  escalation_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  escalated_at: string | null;
  created_at: string;
  mvno_id: string;
  response_minutes: number | null;
}

export interface DashboardStats {
  total_requests: number;
  pending_requests: number;
  approved_today: number;
  rejected_today: number;
  escalated_count: number;
  total_physical_stock: number;
  available_physical_stock: number;
  distributed_physical: number;
  total_esim_stock: number;
  available_esim_stock: number;
  distributed_esim: number;
  distribution_trend: TrendPoint[];
  requests_overview: RequestsOverview;
  recent_requests: SimRequest[];
}

export interface TrendPoint {
  date: string;
  physical: number;
  esim: number;
}

export interface RequestsOverview {
  pending: number;
  approved: number;
  rejected: number;
  escalated: number;
  completed: number;
  total: number;
}

export interface Distributor {
  id: string;
  name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  region: string | null;
  is_active: boolean;
}

export interface PagedResponse<T> {
  rows: T[];
  total: number;
  page: number;
  limit: number;
}
