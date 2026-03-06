// ============================================
// Database Types for SIM Card Inventory System
// ============================================

// MVNO (Mobile Virtual Network Operator)
export type MvnoName = 'PAXTEL' | 'SALAMTEL' | 'AGROTEL' | 'BCC';

export interface Mvno {
  id: string;
  name: MvnoName;
  created_at: string;
}

// SIM Types
export type SimType = 'PHYSICAL' | 'ESIM';

// SIM Status
export type SimStatus = 'IN_STORE' | 'ISSUED' | 'ACTIVATED' | 'FAILED' | 'SOLD' | 'RETURNED';

// Legacy status for backward compatibility
export type LegacySimStatus = 'available' | 'assigned' | 'activated' | 'deactivated';

// Distributor Types
export type DistributorType = 
  | 'SERVICE_CENTER' 
  | 'CHANNEL_PARTNER' 
  | 'INDIVIDUAL' 
  | 'MANAGEMENT'
  | 'DISTRIBUTOR' 
  | 'AGENT' 
  | 'RETAILER' 
  | 'WHOLESALER' 
  | 'EMPLOYEE' 
  | 'OTHER';

// Distributor
export interface Distributor {
  id: string;
  name: string;
  type: DistributorType;
  location: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  contact_phone: string | null;
  mvno_id: string | null;
  mvno_name?: string | null;  // Computed field for display
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  is_active: boolean;
  notes: string | null;
  request_token: string | null;
  request_token_expires: string | null;
  created_at: string;
  updated_at: string;
}

// Uganda Region
export interface UgandaRegion {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  description: string | null;
}

// Distributor Contact
export interface DistributorContact {
  id: string;
  distributor_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  position: string | null;
  is_primary: boolean;
  created_at: string;
}

// Distributor Balance
export interface DistributorBalance {
  distributor_id: string;
  total_sims_received: number;
  total_sims_activated: number;
  total_sims_returned: number;
  total_sims_failed: number;
  pending_activation: number;
  last_transaction_date: string | null;
  updated_at: string;
}

// Carton
export interface Carton {
  id: string;
  carton_number: string;
  mvno_id: string;
  imsi_start: number;
  imsi_end: number;
  iccid_start: string;
  iccid_end: string;
  total_boxes: number;
  sims_per_box: number;
  total_sims: number;
  status: SimStatus;
  created_at: string;
}

// Box (with tracking)
export interface Box {
  id: string;
  carton_id: string;
  box_number: number;
  iccid_start: string;
  iccid_end: string;
  imsi_start: number;
  imsi_end: number;
  total_sims: number;
  remaining_sims: number;
  issued_sims: number;
  status: SimStatus;
  created_at: string;
}

// Physical SIM
export interface PhysicalSim {
  id: string;
  iccid: string;
  imsi: number;
  mvno_id: string;
  carton_id: string | null;
  box_id: string | null;
  status: SimStatus;
  issued_to_distributor_id: string | null;
  issued_date: string | null;
  activation_date: string | null;
  created_at: string;
}

// eSIM Stock
export interface EsimStock {
  id: string;
  iccid: string;
  imsi: number;
  mvno_id: string;
  status: SimStatus;
  issued_to_distributor_id: string | null;
  issued_date: string | null;
  activation_date: string | null;
  created_at: string;
}

// eSIM Range
export interface EsimRange {
  id: string;
  mvno_id: string;
  iccid_start: string;
  iccid_end: string;
  imsi_start: number;
  imsi_end: number;
  total_sims: number;
  available_sims: number;
  created_at: string;
}

// Stock Distribution
export interface StockDistribution {
  id: string;
  distribution_date: string;
  distributor_id: string;
  mvno_id: string;
  purpose: string | null;
  sim_type: SimType;
  quantity: number;
  status: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

// Distribution Detail
export interface DistributionDetail {
  id: string;
  distribution_id: string;
  sim_type: SimType;
  iccid: string;
  imsi: number | null;
  status: SimStatus;
  activation_date: string | null;
  boss_verified: boolean;
  boss_verification_date: string | null;
  failure_reason: string | null;
  created_at: string;
}

// Box Pick Record
export interface BoxPickRecord {
  id: string;
  box_id: string;
  distributor_id: string;
  sims_picked: number;
  iccid_start: string | null;
  iccid_end: string | null;
  created_at: string;
}

// View: Box Stock Summary
export interface BoxStockSummary {
  box_id: string;
  carton_number: string;
  box_number: number;
  box_display: string;
  mvno: string;
  iccid_start: string;
  iccid_end: string;
  total_sims: number;
  remaining_sims: number;
  issued_sims: number;
  remaining_percent: number;
  status: SimStatus;
}

// View: Current Stock
export interface CurrentStock {
  mvno: string;
  sim_type: string;
  total_stock: number;
  in_store: number;
  issued: number;
  activated: number;
  sold: number;
  failed: number;
}

// View: Distribution Summary
export interface DistributionSummary {
  distribution_date: string;
  distributor_name: string;
  distributor_type: DistributorType;
  location: string | null;
  mvno: string;
  purpose: string | null;
  sim_type: SimType;
  quantity: number;
  distribution_status: string;
  sims_issued: number;
  sims_activated: number;
  sims_failed: number;
  sims_pending: number;
  boss_verified: number;
}

// View: Distributor Pick History
export interface DistributorPickHistory {
  id?: string;
  distributor_name: string;
  distributor_type: DistributorType;
  carton_number: string;
  box_number: number;
  box_display: string;
  sims_picked: number;
  iccid_start: string;
  iccid_end: string;
  pick_date: string;
  mvno: string;
}

// ============================================
// Frontend Types
// ============================================

// Legacy type for backward compatibility
export interface Simcard {
  id: string;
  iccid: string;
  phone_number: string | null;
  carrier: string | null;
  status: LegacySimStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SimcardInsert {
  iccid: string;
  phone_number?: string | null;
  carrier?: string | null;
  status?: LegacySimStatus;
  notes?: string | null;
}

export interface SimcardUpdate {
  iccid?: string;
  phone_number?: string | null;
  carrier?: string | null;
  status?: LegacySimStatus;
  notes?: string | null;
}

// Form Types
export interface BoxPickFormData {
  distributor_id: string;
  box_id: string;
  quantity: number;
  purpose?: string;
}

export interface DistributorFormData {
  name: string;
  type: DistributorType;
  location?: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  address?: string;
  contact_phone?: string;
  mvno_id?: string;
  contact_person?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

// Filter Types
export interface StockFilter {
  mvno?: string;
  sim_type?: SimType;
  status?: SimStatus;
  search?: string;
  distributor_id?: string;
  date_from?: string;
  date_to?: string;
}

// Stats Types
export interface StockStats {
  total: number;
  in_store: number;
  issued: number;
  activated: number;
  sold: number;
  failed: number;
  returned: number;
}

// Pagination
export interface PaginationParams {
  page: number;
  limit: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

// ============================================
// Platform User Types (MVNE Platform)
// ============================================

export type PlatformRole = 'SUPER_ADMIN' | 'MANAGEMENT' | 'MVNO_ADMIN' | 'DISTRIBUTOR';

export interface PlatformUser {
  id: string;
  email: string;
  password_hash?: string; // Only used for internal, not exposed
  full_name: string;
  role: PlatformRole;
  mvno_id: string | null;
  is_active: boolean;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================
// Activation Records Types (BOSS Integration)
// ============================================

export type ActivationStatus = 'PENDING' | 'ISSUED' | 'ACTIVATED' | 'DEACTIVATED' | 'FAILED';

export interface ActivationRecord {
  id: string;
  mvno_id: string;
  iccid: string;
  imsi: number | null;
  distributor_id: string | null;
  distribution_id: string | null;
  activation_status: ActivationStatus;
  activation_date: string | null;
  deactivation_date: string | null;
  boss_iccid: string | null;
  boss_status: string | null;
  boss_last_check: string | null;
  failure_reason: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

// ============================================
// BOSS API Configuration Types
// ============================================

export interface BossApiConfig {
  id: string;
  mvno_id: string;
  api_name: string;
  api_url: string;
  api_key: string;
  api_secret: string | null;
  is_active: boolean;
  last_sync: string | null;
  created_at: string;
}

// ============================================
// BOSS Sync Log Types
// ============================================

export type SyncType = 'FULL' | 'DAILY' | 'MANUAL';
export type SyncStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL';

export interface BossSyncLog {
  id: string;
  mvno_id: string;
  sync_type: SyncType;
  status: SyncStatus;
  records_processed: number;
  records_activated: number;
  records_deactivated: number;
  records_failed: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
}

// ============================================
// Stock Issuance Request Types (Dual Approval) - STRICT STATE MACHINE
// ============================================

export enum StockStatus {
  PENDING = 'PENDING',
  READY_FOR_APPROVAL = 'READY_FOR_APPROVAL',
  LEVEL_1_APPROVED = 'LEVEL_1_APPROVED',
  LEVEL_2_APPROVED = 'LEVEL_2_APPROVED',
  STOCK_ISSUED = 'STOCK_ISSUED',
  REJECTED = 'REJECTED'
}

// Legacy type for backward compatibility (deprecated - use StockStatus enum)
export type IssuanceRequestStatus = StockStatus | 'READY_FOR_APPROVAL' | 'PENDING_LEVEL_1_APPROVAL' | 'PENDING_LEVEL_2_APPROVAL';

// Role types for approval workflow
export type ManagementRole = 'SUPER_ADMIN' | 'MANAGEMENT_LEVEL_1' | 'MANAGEMENT_LEVEL_2';

export interface StockIssuanceRequest {
  id: string;
  mvno_id: string;
  requester_id: string;
  sim_type: SimType;
  quantity: number;
  status: StockStatus;  // Use strict enum
  assigned_box_ids: string[] | null;
  assigned_box_quantities: any[] | null;  // JSONB with box_id, quantity, iccid_start, iccid_end
  assigned_esim_iccids: string[] | null;
  level_1_approver_id: string | null;
  level_1_approved_at: string | null;
  level_1_approval_token: string | null;
  level_1_token_expires: string | null;
  level_1_approver_email: string | null;
  level_2_approver_id: string | null;
  level_2_approved_at: string | null;
  level_2_approval_token: string | null;
  level_2_token_expires: string | null;
  level_2_approver_email: string | null;
  rejection_reason: string | null;
  notes: string | null;
  completion_record: any | null;  // JSONB with completion details
  created_at: string;
  updated_at: string;
  // Additional fields for combined view
  request_type?: 'ISSUANCE' | 'DISTRIBUTOR';
  distributor_name?: string | null;
  distributor_id?: string | null;
}

// ============================================
// Distribution Records Types (Updated)
// ============================================

export type TransactionType = 'HAMILTON_TO_MVNO' | 'MVNO_TO_DISTRIBUTOR';
export type PaymentStatus = 'PENDING' | 'PAID' | 'UNPAID';

export interface DistributionRecord {
  id: string;
  box_id: string | null;
  distributor_id: string | null;
  sims_picked: number;
  iccid_start: string | null;
  iccid_end: string | null;
  created_at: string;
  // New fields
  transaction_type: TransactionType;
  unit_cost: number;
  total_cost: number;
  currency: string;
  payment_status: PaymentStatus;
  payment_date: string | null;
  invoice_number: string | null;
  distribution_id: string | null;
}

// ============================================
// Stock Request Types (External Distributor Requests)
// ============================================

export type StockRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface StockRequest {
  id: string;
  distributor_id: string | null;
  mvno_id: string;
  sim_type: SimType;
  quantity: number;
  status: StockRequestStatus;
  assigned_carton_ids: string[];
  assigned_box_ids: string[];
  notes: string | null;
  requested_at: string;
  updated_at: string;
  created_at: string;
}

export interface MvnoStockRequest {
  id: string;
  mvno_id: string;
  sim_type: SimType;
  quantity: number;
  status: StockRequestStatus;
  notes: string | null;
  requested_at: string;
  updated_at: string;
  created_at: string;
}

export interface StockIssuance {
  id: string;
  request_id: string | null;
  distributor_id: string | null;
  mvno_id: string;
  sim_type: SimType;
  quantity: number;
  carton_boxes: any[];
  status: StockRequestStatus;
  issued_by: string | null;
  issued_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

// ============================================
// Notification Types
// ============================================

export type NotificationType = 'INFO' | 'WARNING' | 'SUCCESS' | 'ERROR';

export interface Notification {
  id: string;
  user_id: string | null;
  title: string;
  message: string;
  type: NotificationType;
  is_read: boolean;
  link: string | null;
  created_at: string;
}

// ============================================
// Stock Ownership Types
// ============================================

export type OwnerType = 'HAMILTON' | 'MVNO' | 'DISTRIBUTOR';
