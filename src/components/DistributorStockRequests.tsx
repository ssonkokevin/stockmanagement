import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { StockRequest, Distributor, Mvno } from '../types/simcard';

interface DistributorStockRequestsProps {
  mvnoId?: string;
  showAll?: boolean;
}

interface BoxAllocation {
  boxId: string;
  boxDisplay: string;
  cartonNumber: string;
  quantity: number;
  available: number;
}

interface CartonAllocation {
  cartonNumber: string;
  boxes: BoxAllocation[];
  totalAllocated: number;
}

export function DistributorStockRequests({ mvnoId, showAll = false }: DistributorStockRequestsProps) {
  const [requests, setRequests] = useState<StockRequest[]>([]);
  const [distributors, setDistributors] = useState<Distributor[]>([]);
  const [mvnos, setMvnos] = useState<Mvno[]>([]);
  const [availableBoxes, setAvailableBoxes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRequest, setSelectedRequest] = useState<StockRequest | null>(null);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionType, setActionType] = useState<'approve' | 'reject'>('approve');
  const [rejectionReason, setRejectionReason] = useState('');
  
  // Auto-allocation state
  const [allocations, setAllocations] = useState<BoxAllocation[]>([]);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, [mvnoId, showAll]);

  const loadData = async () => {
    try {
      setLoading(true);

      const { data: mvnosData } = await supabase
        .from('mvnos')
        .select('*')
        .order('name');
      if (mvnosData) setMvnos(mvnosData);

      const { data: distData } = await supabase
        .from('distributors')
        .select('*')
        .order('name');
      if (distData) setDistributors(distData);

      let query = supabase
        .from('stock_requests')
        .select('*')
        .order('created_at', { ascending: false });

      if (!showAll && mvnoId) {
        query = query.eq('mvno_id', mvnoId);
      }

      const { data: requestsData } = await query;
      if (requestsData) setRequests(requestsData);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Auto-allocate boxes based on requested quantity
  const autoAllocateBoxes = (requestedQty: number, boxes: any[]): BoxAllocation[] => {
    const result: BoxAllocation[] = [];
    let remaining = requestedQty;

    // Sort boxes by carton number then box number (sequential order)
    const sortedBoxes = [...boxes].sort((a, b) => {
      const aCarton = parseInt((a.cartons?.carton_number || '0').replace(/\D/g, '')) || 0;
      const bCarton = parseInt((b.cartons?.carton_number || '0').replace(/\D/g, '')) || 0;
      if (aCarton !== bCarton) return aCarton - bCarton;
      return (a.box_number || 0) - (b.box_number || 0);
    });

    for (const box of sortedBoxes) {
      if (remaining <= 0) break;

      const available = box.remaining_sims || 0;
      if (available <= 0) continue;

      const toTake = Math.min(available, remaining);

      result.push({
        boxId: box.id,
        boxDisplay: box.box_display || `Box ${box.box_number}`,
        cartonNumber: box.cartons?.carton_number || 'Unknown',
        quantity: toTake,
        available: available
      });

      remaining -= toTake;
    }

    return result;
  };

  const loadAvailableBoxes = async (mvnoId: string) => {
    try {
      // First try: Fetch boxes using ownership columns
      let { data: boxesData, error } = await supabase
        .from('boxes')
        .select(`
          id,
          box_number,
          box_display,
          remaining_sims,
          owner_type,
          owner_id,
          status,
          cartons(carton_number, mvno_id)
        `)
        .eq('owner_type', 'MVNO')
        .eq('owner_id', mvnoId)
        .gt('remaining_sims', 0);

      // Fallback: If no ownership-based results, check carton.mvno_id
      if (!boxesData || boxesData.length === 0) {
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('boxes')
          .select(`
            id,
            box_number,
            box_display,
            remaining_sims,
            owner_type,
            owner_id,
            status,
            cartons(carton_number, mvno_id)
          `)
          .eq('cartons.mvno_id', mvnoId)
          .gt('remaining_sims', 0);
        
        boxesData = fallbackData;
        error = fallbackError;
      }

      setAvailableBoxes(boxesData || []);
      return boxesData || [];
    } catch (error) {
      console.error('Error loading boxes:', error);
      return [];
    }
  };

  const handleViewRequest = async (request: StockRequest) => {
    setSelectedRequest(request);
    setActionType('approve');
    setRejectionReason('');
    setWarning(null);
    
    // Load available boxes and auto-allocate
    const boxes = await loadAvailableBoxes(request.mvno_id);
    const allocated = autoAllocateBoxes(request.quantity, boxes);
    setAllocations(allocated);

    // Check if we have enough stock
    const totalAvailable = boxes.reduce((sum, b) => sum + (b.remaining_sims || 0), 0);
    if (totalAvailable < request.quantity) {
      setWarning(`⚠️ Insufficient stock! Requested: ${request.quantity}, Available: ${totalAvailable}`);
    }

    setShowApprovalModal(true);
  };

  const handleRecalculate = () => {
    if (!selectedRequest) return;
    const allocated = autoAllocateBoxes(selectedRequest.quantity, availableBoxes);
    setAllocations(allocated);
  };

  const handleApprove = async () => {
    if (!selectedRequest) return;

    try {
      setSubmitting(true);

      // Prepare allocations in the format expected by the RPC function
      const allocationData = allocations.map(a => ({
        box_id: a.boxId,
        quantity: a.quantity
      }));

      // Call the atomic allocation function
      const { data, error } = await supabase.rpc('allocate_stock', {
        p_request_id: selectedRequest.id,
        p_distributor_id: selectedRequest.distributor_id,
        p_mvno_id: selectedRequest.mvno_id,
        p_sim_type: selectedRequest.sim_type,
        p_quantity: selectedRequest.quantity,
        p_allocations: JSON.stringify(allocationData)
      });

      if (error) {
        console.error('Error allocating stock:', error);
        alert(`Failed to allocate stock: ${error.message}`);
        return;
      }

      alert('Request approved successfully! Stock has been allocated.');
      setShowApprovalModal(false);
      loadData();
    } catch (error: any) {
      console.error('Error approving request:', error);
      alert(`Failed to approve request: ${error.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!selectedRequest) return;

    try {
      setSubmitting(true);

      const { error } = await supabase
        .from('stock_requests')
        .update({
          status: 'REJECTED',
          notes: rejectionReason
        })
        .eq('id', selectedRequest.id);

      if (error) throw error;

      alert('Request rejected');
      setShowApprovalModal(false);
      setRejectionReason('');
      loadData();
    } catch (error) {
      console.error('Error rejecting request:', error);
      alert('Failed to reject request');
    } finally {
      setSubmitting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'PENDING':
        return <span className="badge bg-warning">Pending</span>;
      case 'APPROVED':
        return <span className="badge bg-success">Approved</span>;
      case 'REJECTED':
        return <span className="badge bg-danger">Rejected</span>;
      default:
        return <span className="badge bg-secondary">{status}</span>;
    }
  };

  const getDistributorName = (id: string | null) => {
    if (!id) return 'Unknown';
    const dist = distributors.find(d => d.id === id);
    return dist?.name || 'Unknown';
  };

  const getMvnoName = (id: string) => {
    const mvno = mvnos.find(m => m.id === id);
    return mvno?.name || 'Unknown';
  };

  // Group allocations by carton
  const groupedAllocations = allocations.reduce((acc, alloc) => {
    if (!acc[alloc.cartonNumber]) {
      acc[alloc.cartonNumber] = [];
    }
    acc[alloc.cartonNumber].push(alloc);
    return acc;
  }, {} as Record<string, BoxAllocation[]>);

  const totalAllocated = allocations.reduce((sum, a) => sum + a.quantity, 0);

  if (loading) {
    return (
      <div className="text-center py-5">
        <div className="spinner-border spinner-custom" role="status"></div>
        <p className="mt-2 text-muted-custom">Loading requests...</p>
      </div>
    );
  }

  return (
    <div className="distributor-stock-requests">
      <div className="d-flex justify-content-between align-items-center mb-4">
        <h4 className="mb-0">
          <i className="bi bi-box-arrow-in-down me-2"></i>
          Distributor Stock Requests
        </h4>
        <button className="btn btn-sm btn-outline-custom" onClick={loadData}>
          <i className="bi bi-arrow-clockwise me-1"></i>
          Refresh
        </button>
      </div>

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
                    <th>Distributor</th>
                    <th>SIM Type</th>
                    <th className="text-end">Quantity</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map(request => (
                    <tr key={request.id}>
                      <td><small>{new Date(request.created_at).toLocaleDateString()}</small></td>
                      {showAll && (
                        <td><span className="badge bg-primary">{getMvnoName(request.mvno_id)}</span></td>
                      )}
                      <td>{getDistributorName(request.distributor_id)}</td>
                      <td>{request.sim_type}</td>
                      <td className="text-end fw-bold">{request.quantity}</td>
                      <td>{getStatusBadge(request.status)}</td>
                      <td>
                        {request.status === 'PENDING' && (
                          <button className="btn btn-sm btn-accent" onClick={() => handleViewRequest(request)}>
                            <i className="bi bi-eye me-1"></i>
                            Review
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {showApprovalModal && selectedRequest && (
        <div className="modal d-block" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
          <div className="modal-dialog modal-dialog-centered modal-lg">
            <div className="modal-content card card-custom">
              <div className="modal-header card-header card-header-custom">
                <h5 className="modal-title">
                  <i className="bi bi-clipboard-check me-2"></i>
                  Review Stock Request
                </h5>
                <button 
                  type="button" 
                  className="btn-close btn-close-white"
                  onClick={() => setShowApprovalModal(false)}
                ></button>
              </div>
              <div className="modal-body">
                {/* Request Details */}
                <div className="alert alert-info mb-4">
                  <div className="row">
                    <div className="col-md-6">
                      <strong>Distributor:</strong> {getDistributorName(selectedRequest.distributor_id)}<br/>
                      <strong>MVNO:</strong> {getMvnoName(selectedRequest.mvno_id)}
                    </div>
                    <div className="col-md-6">
                      <strong>SIM Type:</strong> {selectedRequest.sim_type}<br/>
                      <strong>Requested Quantity:</strong> {selectedRequest.quantity}<br/>
                      <strong>Requested:</strong> {new Date(selectedRequest.created_at).toLocaleString()}
                    </div>
                  </div>
                </div>

                {/* Warning if insufficient stock */}
                {warning && (
                  <div className="alert alert-warning mb-4">
                    {warning}
                  </div>
                )}

                {/* Auto-allocated Stock Display */}
                <div className="mb-4">
                  <div className="d-flex justify-content-between align-items-center mb-3">
                    <label className="form-label fw-bold mb-0">
                      <i className="bi bi-calculator me-2"></i>
                      System Allocation
                      <span className="badge bg-info ms-2">
                        {totalAllocated} / {selectedRequest.quantity} SIMs
                      </span>
                    </label>
                    <button 
                      className="btn btn-sm btn-outline-primary"
                      onClick={handleRecalculate}
                    >
                      <i className="bi bi-arrow-clockwise me-1"></i>
                      Recalculate
                    </button>
                  </div>

                  <div className="card bg-dark-subtle">
                    <div className="card-body" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                      {allocations.length === 0 ? (
                        <p className="text-muted text-center py-3">No available stock to allocate</p>
                      ) : (
                        <div className="table-responsive">
                          <table className="table table-sm mb-0">
                            <thead className="table-light">
                              <tr>
                                <th>Carton</th>
                                <th>Box</th>
                                <th className="text-end">Available</th>
                                <th className="text-end">Allocated</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Object.entries(groupedAllocations).map(([cartonNumber, boxAllocations]) => (
                                <>{boxAllocations.map((alloc, idx) => (
                                  <tr key={alloc.boxId} className={idx === 0 ? 'table-success' : ''}>
                                    {idx === 0 && (
                                      <td rowSpan={boxAllocations.length} className="align-middle">
                                        <strong>Carton {cartonNumber}</strong>
                                      </td>
                                    )}
                                    <td>{alloc.boxDisplay}</td>
                                    <td className="text-end">{alloc.available}</td>
                                    <td className="text-end">
                                      <input
                                        type="number"
                                        className="form-control form-control-sm text-end"
                                        style={{ width: '80px', display: 'inline' }}
                                        value={alloc.quantity}
                                        min={0}
                                        max={alloc.available}
                                        onChange={(e) => {
                                          const newQty = parseInt(e.target.value) || 0;
                                          setAllocations(prev => prev.map(a => 
                                            a.boxId === alloc.boxId 
                                              ? { ...a, quantity: Math.min(newQty, a.available) }
                                              : a
                                          ));
                                        }}
                                      />
                                    </td>
                                  </tr>
                                ))}</>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr className="table-primary">
                                <td colSpan={3} className="text-end fw-bold">Total Allocated:</td>
                                <td className="text-end fw-bold">{totalAllocated}</td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Rejection Reason (shown when rejecting) */}
                {actionType === 'reject' && (
                  <div className="mb-4">
                    <label className="form-label fw-bold">Rejection Reason</label>
                    <textarea
                      className="form-control"
                      rows={3}
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      placeholder="Enter reason for rejection..."
                    />
                  </div>
                )}
              </div>

              <div className="modal-footer">
                {actionType === 'approve' ? (
                  <>
                    <button 
                      className="btn btn-outline-danger"
                      onClick={() => setActionType('reject')}
                    >
                      <i className="bi bi-x-circle me-2"></i>
                      Reject
                    </button>
                    <button 
                      className="btn btn-success"
                      onClick={handleApprove}
                      disabled={submitting || totalAllocated !== selectedRequest.quantity}
                    >
                      {submitting ? (
                        <>
                          <span className="spinner-border spinner-border-sm me-2" role="status"></span>
                          Processing...
                        </>
                      ) : (
                        <>
                          <i className="bi bi-check-circle me-2"></i>
                          Approve & Allocate Stock
                        </>
                      )}
                    </button>
                  </>
                ) : (
                  <>
                    <button 
                      className="btn btn-outline-secondary"
                      onClick={() => setActionType('approve')}
                    >
                      Cancel
                    </button>
                    <button 
                      className="btn btn-danger"
                      onClick={handleReject}
                      disabled={submitting || !rejectionReason.trim()}
                    >
                      {submitting ? 'Processing...' : 'Confirm Rejection'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DistributorStockRequests;
