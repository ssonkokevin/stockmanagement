import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { StockIssuanceRequest, Mvno } from '../types/simcard';
import { StockStatus } from '../types/simcard';

interface User {
  id: string;
  email: string;
  role: string;
}

// Helper to get MVNO name
const getMvnoName = (mvnoId: string, mvnos: Mvno[] = []): string => {
  const mvno = mvnos.find(m => m.id === mvnoId);
  return mvno?.name || 'Unknown MVNO';
};

// Role guard functions - Allow both MANAGEMENT and SUPER_ADMIN to approve
const canApproveLevel1 = (request: StockIssuanceRequest, user: User | null): boolean => {
  if (!user) return false;
  return request.status === StockStatus.READY_FOR_APPROVAL && (user.role === 'MANAGEMENT' || user.role === 'SUPER_ADMIN');
};

const canApproveLevel2 = (request: StockIssuanceRequest, user: User | null): boolean => {
  if (!user) return false;
  return request.status === StockStatus.LEVEL_1_APPROVED && (user.role === 'MANAGEMENT' || user.role === 'SUPER_ADMIN');
};

const canIssueStock = (request: StockIssuanceRequest, user: User | null): boolean => {
  if (!user) return false;
  return request.status === StockStatus.LEVEL_2_APPROVED && user.role === 'SUPER_ADMIN';
};

export function ApproveStock() {
  const [requests, setRequests] = useState<StockIssuanceRequest[]>([]);
  const [mvnos, setMvnos] = useState<Mvno[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<StockIssuanceRequest | null>(null);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [actionType, setActionType] = useState<'approve' | 'reject'>('approve');
  const [approvalNotes, setApprovalNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Load user on mount - try multiple sources
  useEffect(() => {
    // Try platform_user first
    let storedUser = localStorage.getItem('platform_user');
    let user: User | null = null;
    
    if (storedUser) {
      try {
        user = JSON.parse(storedUser);
      } catch (e) {
        console.error('[ApproveStock] Failed to parse platform_user:', e);
      }
    }
    
    // Fallback: try supabase auth
    if (!user) {
      supabase.auth.getUser().then(({ data: { user: supabaseUser } }) => {
        if (supabaseUser) {
          user = {
            id: supabaseUser.id,
            email: supabaseUser.email || '',
            role: 'MANAGEMENT' // Default role for logged-in users
          };
          setCurrentUser(user);
          console.log('[ApproveStock] User from Supabase auth:', user);
        }
      });
    }
    
    if (user) {
      setCurrentUser(user);
      console.log('[ApproveStock] User loaded:', user.role, user.email);
    }
  }, []);

  // Load data
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      
      // Load MVNOs
      const { data: mvnosData } = await supabase.from('mvnos').select('*');
      setMvnos(mvnosData || []);
      
      // Load requests that need approval - ONLY requests with assigned stock (READY_FOR_APPROVAL and beyond)
      console.log('[ApproveStock] Loading requests with status: READY_FOR_APPROVAL, LEVEL_1_APPROVED, LEVEL_2_APPROVED');
      
      // First, let's try loading ALL requests to see what's available
      const { data: allRequests, error: allError } = await supabase
        .from('stock_issuance_requests')
        .select('id, status');
      
      console.log('[ApproveStock] All requests in DB:', allRequests?.map(r => ({ id: r.id?.slice(0,8), status: r.status })));
      
      // Now filter for approval statuses - EXCLUDE null/empty status
      const validStatuses = ['READY_FOR_APPROVAL', 'LEVEL_1_APPROVED', 'LEVEL_2_APPROVED'];
      const { data: requestsData, error: requestsError } = await supabase
        .from('stock_issuance_requests')
        .select('*')
        .in('status', validStatuses)
        .not('status', 'is', null)
        .neq('status', '')
        .order('created_at', { ascending: false });
      
      if (requestsError) {
        console.error('[ApproveStock] Error loading requests:', requestsError);
      }
      
      console.log('[ApproveStock] Filtered requests:', requestsData?.length, requestsData?.map(r => ({ id: r.id?.slice(0,8), status: r.status })));
      setRequests(requestsData || []);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Log approval action to database
  const logApproval = async (request: StockIssuanceRequest, approver: User, actionType: string, prevStatus: string, newStatus: string) => {
    try {
      console.log(`[ApproveStock] Logging ${actionType} to workflow log...`);
      
      const { data, error } = await supabase.from('approval_workflow_log').insert({
        request_id: request.id,
        action_type: actionType,
        action_by: approver.id,
        previous_status: prevStatus,
        new_status: newStatus,
        notes: `${actionType} by ${approver.email}`
      }).select();
      
      if (error) {
        console.error('[ApproveStock] Log insert error:', error);
        // Don't throw - continue with approval
      } else {
        console.log('[ApproveStock] Log saved:', data);
      }
    } catch (err) {
      console.error('[ApproveStock] Log error (non-blocking):', err);
      // Don't fail the approval if logging fails
    }
  };
  
  // Send Level 2 notification after Level 1 approval
  const sendLevel2Notification = async (request: StockIssuanceRequest, approver: User) => {
    console.log('[ApproveStock] Level 1 approved. Request ready for Level 2 approval.');
    console.log('[ApproveStock] Next approver should be: SUPER_ADMIN or MANAGEMENT');
    
    // Log the approval action
    await logApproval(request, approver, 'LEVEL_1_APPROVED', StockStatus.READY_FOR_APPROVAL, StockStatus.LEVEL_1_APPROVED);
  };
  
  // Send Super Admin notification after Level 2 approval
  const sendSuperAdminNotification = async (request: StockIssuanceRequest, approver: User) => {
    console.log('[ApproveStock] Level 2 approved. Request ready for stock issuance.');
    
    // Log the approval action
    await logApproval(request, approver, 'LEVEL_2_APPROVED', StockStatus.LEVEL_1_APPROVED, StockStatus.LEVEL_2_APPROVED);
  };

  const handleApprove = async () => {
    console.log('[ApproveStock] handleApprove called');
    console.log('[ApproveStock] selectedRequest:', selectedRequest?.id, 'status:', selectedRequest?.status);
    console.log('[ApproveStock] currentUser:', currentUser?.email, 'role:', currentUser?.role);
    
    if (!selectedRequest || !currentUser) {
      alert('No request selected or user not logged in');
      return;
    }
    
    try {
      setSubmitting(true);
      
      let nextStatus: StockStatus;
      let updateFields: any = {};
      
      console.log('[ApproveStock] Current status:', selectedRequest.status);
      console.log('[ApproveStock] User role:', currentUser.role);
      
      if (selectedRequest.status === StockStatus.READY_FOR_APPROVAL) {
        nextStatus = StockStatus.LEVEL_1_APPROVED;
        updateFields = {
          status: nextStatus,
          level_1_approver_id: currentUser.id,
          level_1_approver_email: currentUser.email,
          level_1_approved_at: new Date().toISOString(),
          notes: approvalNotes || null
        };
        console.log('[ApproveStock] Approving Level 1, new status:', nextStatus);
      } else if (selectedRequest.status === StockStatus.LEVEL_1_APPROVED) {
        nextStatus = StockStatus.LEVEL_2_APPROVED;
        updateFields = {
          status: nextStatus,
          level_2_approver_id: currentUser.id,
          level_2_approver_email: currentUser.email,
          level_2_approved_at: new Date().toISOString(),
          notes: approvalNotes || null
        };
        console.log('[ApproveStock] Approving Level 2, new status:', nextStatus);
      } else if (selectedRequest.status === StockStatus.LEVEL_2_APPROVED) {
        if (currentUser.role !== 'SUPER_ADMIN') {
          alert('Only SUPER_ADMIN can complete stock issuance');
          setSubmitting(false);
          return;
        }
        nextStatus = StockStatus.STOCK_ISSUED;
        updateFields = {
          status: nextStatus,
          completion_record: { issued_at: new Date().toISOString(), issued_by: currentUser.email },
          notes: approvalNotes || null
        };
        console.log('[ApproveStock] Issuing stock, new status:', nextStatus);
      } else {
        alert('Invalid status for approval: ' + selectedRequest.status);
        setSubmitting(false);
        return;
      }

      console.log('[ApproveStock] Updating request with:', updateFields);
      const { error } = await supabase
        .from('stock_issuance_requests')
        .update(updateFields)
        .eq('id', selectedRequest.id);

      if (error) {
        console.error('[ApproveStock] Update error:', error);
        throw error;
      }
      
      console.log('[ApproveStock] Update successful!');
      
      // Send email notification to Level 2 approver after Level 1 approval
      if (nextStatus === StockStatus.LEVEL_1_APPROVED) {
        await sendLevel2Notification(selectedRequest, currentUser);
      }
      
      // Send email notification to Super Admin after Level 2 approval
      if (nextStatus === StockStatus.LEVEL_2_APPROVED) {
        await sendSuperAdminNotification(selectedRequest, currentUser);
      }

      alert(`✅ Approved successfully! Status: ${nextStatus}`);
      setShowApprovalModal(false);
      loadData();
      
    } catch (error: any) {
      console.error('[ApproveStock] Approval error:', error);
      alert('Error: ' + error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const openApprovalModal = (request: StockIssuanceRequest, action: 'approve' | 'reject') => {
    setSelectedRequest(request);
    setActionType(action);
    setApprovalNotes('');
    setShowApprovalModal(true);
  };

  const getStatusBadge = (status: string | null | undefined) => {
    // Handle null/undefined/empty status
    if (!status || status === '' || status === 'null' || status === 'undefined') {
      return <span className="badge bg-warning text-dark">⚠️ No Status</span>;
    }
    switch (status) {
      case StockStatus.PENDING:
        return <span className="badge" style={{ backgroundColor: '#ffc107', color: '#000' }}>🟡 Pending</span>;
      case StockStatus.READY_FOR_APPROVAL:
        return <span className="badge" style={{ backgroundColor: '#0d6efd', color: '#fff' }}>🔵 Ready for Approval</span>;
      case StockStatus.LEVEL_1_APPROVED:
        return <span className="badge" style={{ backgroundColor: '#fd7e14', color: '#fff' }}>🟠 L1 Approved</span>;
      case StockStatus.LEVEL_2_APPROVED:
        return <span className="badge" style={{ backgroundColor: '#6f42c1', color: '#fff' }}>🟣 L2 Approved</span>;
      case StockStatus.STOCK_ISSUED:
        return <span className="badge bg-success">🟢 Issued</span>;
      case StockStatus.REJECTED:
        return <span className="badge bg-danger">🔴 Rejected</span>;
      default:
        return <span className="badge bg-secondary">❓ {status}</span>;
    }
  };

  const getMvnoName = (mvnoId: string) => {
    return mvnos.find(m => m.id === mvnoId)?.name || 'Unknown';
  };

  if (loading) {
    return (
      <div className="container mt-5 text-center">
        <div className="spinner-border text-primary"></div>
        <p className="mt-3">Loading approvals...</p>
      </div>
    );
  }

  // Filter requests based on user role
  const pendingRequests = requests.filter(r => r.status === StockStatus.PENDING || r.status === StockStatus.READY_FOR_APPROVAL);
  const level1Approved = requests.filter(r => r.status === StockStatus.LEVEL_1_APPROVED);
  const level2Approved = requests.filter(r => r.status === StockStatus.LEVEL_2_APPROVED);

  return (
    <div className="container-fluid p-3">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4>📋 Approve Stock Issuance</h4>
        <div>
          <span className="badge bg-secondary me-2">Your Role: {currentUser?.role || 'Not logged in'}</span>
          <button className="btn btn-sm btn-outline-primary" onClick={loadData}>
            <i className="bi bi-arrow-clockwise"></i> Refresh
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="row mb-4">
        <div className="col-md-4">
          <div className="card border-warning">
            <div className="card-body text-center">
              <h2 className="text-warning">{pendingRequests.length}</h2>
              <p className="mb-0">Pending Level 1</p>
            </div>
          </div>
        </div>
        <div className="col-md-4">
          <div className="card border-info">
            <div className="card-body text-center">
              <h2 className="text-info">{level1Approved.length}</h2>
              <p className="mb-0">Pending Level 2</p>
            </div>
          </div>
        </div>
        <div className="col-md-4">
          <div className="card border-primary">
            <div className="card-body text-center">
              <h2 className="text-primary">{level2Approved.length}</h2>
              <p className="mb-0">Ready for Issuance</p>
            </div>
          </div>
        </div>
      </div>

      {/* Requests Table */}
      <div className="card">
        <div className="card-body">
          <table className="table table-hover">
            <thead>
              <tr>
                <th>ID</th>
                <th>MVNO</th>
                <th>SIM Type</th>
                <th>Quantity</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-muted">No requests need approval</td>
                </tr>
              ) : (
                requests.map(request => (
                  <tr key={request.id}>
                    <td><small>{request.id.slice(0, 8)}</small></td>
                    <td>{getMvnoName(request.mvno_id)}</td>
                    <td>{request.sim_type}</td>
                    <td>{request.quantity}</td>
                    <td>{getStatusBadge(request.status)}</td>
                    <td><small>{new Date(request.created_at).toLocaleDateString()}</small></td>
                    <td>
                      <div className="d-flex gap-1">
                        {/* Level 1 Approval Button */}
                        {canApproveLevel1(request, currentUser) && (
                          <button
                            className="btn btn-sm btn-success"
                            onClick={() => openApprovalModal(request, 'approve')}
                            title="Approve Level 1"
                          >
                            <i className="bi bi-check-circle"></i> Approve L1
                          </button>
                        )}
                        
                        {/* Level 2 Approval Button */}
                        {canApproveLevel2(request, currentUser) && (
                          <button
                            className="btn btn-sm btn-success"
                            onClick={() => openApprovalModal(request, 'approve')}
                            title="Approve Level 2"
                          >
                            <i className="bi bi-check-circle-fill"></i> Approve L2
                          </button>
                        )}
                        
                        {/* Issue Stock Button */}
                        {canIssueStock(request, currentUser) && (
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => openApprovalModal(request, 'approve')}
                            title="Complete Issuance"
                          >
                            <i className="bi bi-box-seam"></i> Issue Stock
                          </button>
                        )}
                        
                        {/* View Details */}
                        <button
                          className="btn btn-sm btn-outline-secondary"
                          title="View Details"
                          onClick={() => {
                            setSelectedRequest(request);
                            setShowDetailsModal(true);
                          }}
                        >
                          <i className="bi bi-eye"></i>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Approval Modal */}
      {showApprovalModal && selectedRequest && (
        <div className="modal show d-block" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="modal-dialog">
            <div className="modal-content">
              <div className="modal-header bg-primary text-white">
                <h5 className="modal-title">
                  {actionType === 'approve' ? '✅ Approve Request' : '❌ Reject Request'}
                </h5>
                <button className="btn-close btn-close-white" onClick={() => setShowApprovalModal(false)}></button>
              </div>
              <div className="modal-body">
                <p><strong>Request ID:</strong> {selectedRequest.id.slice(0, 8)}</p>
                <p><strong>MVNO:</strong> {getMvnoName(selectedRequest.mvno_id)}</p>
                <p><strong>SIM Type:</strong> {selectedRequest.sim_type}</p>
                <p><strong>Quantity:</strong> {selectedRequest.quantity}</p>
                <p><strong>Current Status:</strong> {getStatusBadge(selectedRequest.status)}</p>
                <hr />
                <p>
                  <strong>Will change to:</strong>{' '}
                  {selectedRequest.status === StockStatus.READY_FOR_APPROVAL && <span className="badge bg-warning">LEVEL_1_APPROVED</span>}
                  {selectedRequest.status === StockStatus.LEVEL_1_APPROVED && <span className="badge bg-info">LEVEL_2_APPROVED</span>}
                  {selectedRequest.status === StockStatus.LEVEL_2_APPROVED && <span className="badge bg-success">STOCK_ISSUED</span>}
                </p>
                
                <div className="mb-3">
                  <label className="form-label">Notes (optional):</label>
                  <textarea
                    className="form-control"
                    rows={3}
                    value={approvalNotes}
                    onChange={(e) => setApprovalNotes(e.target.value)}
                    placeholder="Add approval notes..."
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowApprovalModal(false)}>
                  Cancel
                </button>
                {actionType === 'approve' ? (
                  <button className="btn btn-success" onClick={handleApprove} disabled={submitting}>
                    {submitting ? 'Approving...' : '✅ Confirm Approval'}
                  </button>
                ) : (
                  <button className="btn btn-danger" disabled={submitting}>
                    {submitting ? 'Rejecting...' : '❌ Confirm Rejection'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Details Modal */}
      {showDetailsModal && selectedRequest && (
        <div className="modal show d-block" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="modal-dialog modal-lg">
            <div className="modal-content">
              <div className="modal-header bg-info text-white">
                <h5 className="modal-title">📋 Request Details</h5>
                <button className="btn-close btn-close-white" onClick={() => setShowDetailsModal(false)}></button>
              </div>
              <div className="modal-body">
                <div className="row">
                  <div className="col-md-6">
                    <p><strong>Request ID:</strong><br /><small className="text-muted">{selectedRequest.id}</small></p>
                    <p><strong>MVNO:</strong> {mvnos.find(m => m.id === selectedRequest.mvno_id)?.name || 'Unknown'}</p>
                    <p><strong>SIM Type:</strong> {selectedRequest.sim_type}</p>
                    <p><strong>Quantity:</strong> {selectedRequest.quantity} SIMs</p>
                    <p><strong>Status:</strong> {getStatusBadge(selectedRequest.status)}</p>
                  </div>
                  <div className="col-md-6">
                    <p><strong>Created:</strong><br />{new Date(selectedRequest.created_at).toLocaleString()}</p>
                    <p><strong>Level 1 Approver:</strong><br />{selectedRequest.level_1_approver_email || 'Pending'}</p>
                    <p><strong>Level 2 Approver:</strong><br />{selectedRequest.level_2_approver_email || 'Pending'}</p>
                    <p><strong>Assigned Boxes:</strong><br />{(selectedRequest as any).assigned_box_ids?.length || 0}</p>
                    <p><strong>Assigned eSIMs:</strong><br />{(selectedRequest as any).assigned_esim_iccids?.length || 0}</p>
                  </div>
                </div>
                {selectedRequest.notes && (
                  <div className="mt-3">
                    <p><strong>Notes:</strong></p>
                    <p className="text-muted">{selectedRequest.notes}</p>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowDetailsModal(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
