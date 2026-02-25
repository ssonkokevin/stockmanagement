import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { StockIssuanceRequest, Mvno, SimType } from '../types/simcard';

interface StockIssuanceRequestsProps {
  mvnoId?: string | undefined;
  showAll?: boolean;
}

export function StockIssuanceRequests({ mvnoId, showAll = false }: StockIssuanceRequestsProps) {
  const [requests, setRequests] = useState<StockIssuanceRequest[]>([]);
  const [mvnos, setMvnos] = useState<Mvno[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    mvno_id: mvnoId || '',
    sim_type: 'PHYSICAL' as SimType,
    quantity: 100,
    notes: '',
  });

  useEffect(() => {
    loadData();
  }, [mvnoId, showAll]);

  const loadData = async () => {
    try {
      setLoading(true);

      // Fetch MVNOs
      const { data: mvnosData } = await supabase
        .from('mvnos')
        .select('*')
        .order('name');

      if (mvnosData) {
        setMvnos(mvnosData);
      }

      // Fetch requests
      let query = supabase
        .from('stock_issuance_requests')
        .select('*')
        .order('created_at', { ascending: false });

      if (!showAll && mvnoId) {
        query = query.eq('mvno_id', mvnoId);
      }

      const { data: requestsData } = await query.limit(50);

      if (requestsData) {
        setRequests(requestsData);
      }
    } catch (error) {
      console.error('Error loading requests:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateRequest = async () => {
    try {
      setSubmitting(true);

      // Get current user from localStorage (demo)
      const storedUser = localStorage.getItem('platform_user');
      const user = storedUser ? JSON.parse(storedUser) : null;

      if (!user) {
        alert('Please log in first');
        return;
      }

      const { data, error } = await supabase.rpc('create_stock_issuance_request', {
        p_mvno_id: formData.mvno_id,
        p_requester_id: user.id,
        p_sim_type: formData.sim_type,
        p_quantity: formData.quantity,
        p_notes: formData.notes || null,
      });

      if (error) {
        console.error('Error creating request:', error);
        alert('Failed to create request: ' + error.message);
        return;
      }

      // Refresh list
      loadData();
      setShowCreateModal(false);
      setFormData({
        mvno_id: mvnoId || '',
        sim_type: 'PHYSICAL',
        quantity: 100,
        notes: '',
      });

      alert('Stock request created successfully! Level 1 approval will be notified.');
    } catch (error) {
      console.error('Error:', error);
      alert('An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'PENDING':
        return <span className="badge bg-warning">Pending</span>;
      case 'LEVEL_1_APPROVED':
        return <span className="badge bg-info">Level 1 Approved</span>;
      case 'LEVEL_2_APPROVED':
        return <span className="badge bg-primary">Level 2 Approved</span>;
      case 'COMPLETED':
        return <span className="badge bg-success">Completed</span>;
      case 'REJECTED':
        return <span className="badge bg-danger">Rejected</span>;
      default:
        return <span className="badge bg-secondary">{status}</span>;
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  if (loading) {
    return (
      <div className="text-center py-5">
        <div className="spinner-border spinner-custom" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="stock-issuance-requests">
      {/* Header */}
      <div className="d-flex justify-content-between align-items-center mb-4">
        <h4 className="mb-0">Stock Issuance Requests</h4>
        <button 
          className="btn btn-accent"
          onClick={() => setShowCreateModal(true)}
        >
          <i className="bi bi-plus-lg me-2"></i>
          New Request
        </button>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="modal d-block" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content card card-custom">
              <div className="modal-header card-header card-header-custom">
                <h5 className="modal-title">Request Stock from Hamilton</h5>
                <button 
                  type="button" 
                  className="btn-close btn-close-white"
                  onClick={() => setShowCreateModal(false)}
                ></button>
              </div>
              <div className="modal-body">
                <div className="mb-3">
                  <label className="form-label">MVNO</label>
                  <select
                    className="form-select form-select-custom"
                    value={formData.mvno_id}
                    onChange={(e) => setFormData({ ...formData, mvno_id: e.target.value })}
                    disabled={!!mvnoId}
                  >
                    <option value="">Select MVNO</option>
                    {mvnos.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>

                <div className="mb-3">
                  <label className="form-label">SIM Type</label>
                  <select
                    className="form-select form-select-custom"
                    value={formData.sim_type}
                    onChange={(e) => setFormData({ ...formData, sim_type: e.target.value as SimType })}
                  >
                    <option value="PHYSICAL">Physical SIM</option>
                    <option value="ESIM">eSIM</option>
                  </select>
                </div>

                <div className="mb-3">
                  <label className="form-label">Quantity</label>
                  <input
                    type="number"
                    className="form-control form-control-custom"
                    value={formData.quantity}
                    onChange={(e) => setFormData({ ...formData, quantity: parseInt(e.target.value) || 0 })}
                    min={1}
                    max={10000}
                  />
                </div>

                <div className="mb-3">
                  <label className="form-label">Notes (Optional)</label>
                  <textarea
                    className="form-control form-control-custom"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={3}
                    placeholder="Add any notes for the approvers..."
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button 
                  type="button" 
                  className="btn btn-outline-custom"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button 
                  type="button" 
                  className="btn btn-accent"
                  onClick={handleCreateRequest}
                  disabled={submitting || !formData.mvno_id || formData.quantity <= 0}
                >
                  {submitting ? 'Submitting...' : 'Submit Request'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Requests List */}
      {requests.length === 0 ? (
        <div className="card card-custom">
          <div className="card-body text-center py-5">
            <i className="bi bi-inbox fs-1 text-muted-custom"></i>
            <p className="mt-2">No stock requests found</p>
          </div>
        </div>
      ) : (
        <div className="card card-custom">
          <div className="card-body p-0">
            <div className="table-responsive">
              <table className="table table-custom mb-0">
                <thead>
                  <tr>
                    <th>Date</th>
                    {showAll && <th>MVNO</th>}
                    <th>SIM Type</th>
                    <th className="text-end">Quantity</th>
                    <th>Status</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => (
                    <tr key={request.id}>
                      <td>
                        <small>{formatDate(request.created_at)}</small>
                      </td>
                      {showAll && (
                        <td>
                          <span className="badge" style={{ backgroundColor: 'var(--brand-primary)' }}>
                            {mvnos.find(m => m.id === request.mvno_id)?.name || 'Unknown'}
                          </span>
                        </td>
                      )}
                      <td>{request.sim_type}</td>
                      <td className="text-end fw-bold">{request.quantity}</td>
                      <td>{getStatusBadge(request.status)}</td>
                      <td>
                        <small className="text-muted-custom">
                          {request.notes || '-'}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Workflow Info */}
      <div className="mt-4 p-3 bg-dark-subtle rounded">
        <h6 className="mb-3">
          <i className="bi bi-info-circle me-2"></i>
          Approval Workflow
        </h6>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <span className="badge bg-secondary">PENDING</span>
          <i className="bi bi-arrow-right"></i>
          <span className="badge bg-info">LEVEL 1 APPROVED</span>
          <i className="bi bi-arrow-right"></i>
          <span className="badge bg-primary">LEVEL 2 APPROVED</span>
          <i className="bi bi-arrow-right"></i>
          <span className="badge bg-success">COMPLETED</span>
        </div>
        <small className="text-muted-custom mt-2 d-block">
          Stock transfers from Hamilton to MVNO require dual approval from two authorized managers.
        </small>
      </div>
    </div>
  );
}
