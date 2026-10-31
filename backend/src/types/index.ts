// Stock Request Types
export interface StockRequest {
  id: string;
  distributor_id: string;
  requested_quantity: number;
  status: 'pending' | 'approved' | 'rejected' | 'issued' | 'completed';
  request_date: string;
  approval_date?: string;
  issued_date?: string;
  created_at: string;
  updated_at: string;
}

// Stock Assignment Types
export interface StockAssignment {
  id: string;
  request_id: string;
  box_id: string;
  quantity: number;
  status: 'reserved' | 'issued' | 'picked';
  reservation_date: string;
  issue_date?: string;
  pick_date?: string;
  created_at: string;
  updated_at: string;
}

// Pick Form Types
export interface PickForm {
  id: string;
  request_id: string;
  assignment_ids: string[];
  pdf_url?: string;
  status: 'pending' | 'generated' | 'downloaded';
  generated_at?: string;
  created_at: string;
  updated_at: string;
}

// Approval Token Types
export interface ApprovalToken {
  id: string;
  request_id: string;
  token: string;
  level: number;
  approver_email: string;
  approver_name?: string;
  approver_role?: string;
  status: 'pending' | 'approved' | 'rejected';
  expires_at: string;
  approved_at?: string;
  used?: boolean;
  used_at?: string;
  created_at: string;
  updated_at: string;
}

// API Request/Response Types
export interface AssignStockRequest {
  request_id: string;
  box_ids: string[];
  quantity: number;
}

export interface ApproveStockRequest {
  token: string;
  action: 'approve' | 'reject';
}

export interface FinalizeIssueRequest {
  request_id: string;
  pick_form_url?: string;
}

export interface GeneratePickFormRequest {
  request_id: string;
  assignment_ids: string[];
}

// API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
