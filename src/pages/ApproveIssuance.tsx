import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

interface StockIssuanceRequest {
  id: string;
  mvno_id: string;
  requester_id: string | null;
  sim_type: string;
  quantity: number;
  status: string;
  notes: string;
  level_1_approver_email: string | null;
  level_2_approver_email: string | null;
  level_1_approval_token: string | null;
  level_2_approval_token: string | null;
  assigned_box_quantities: any[] | null;
  assigned_esim_iccids: string[] | null;
  created_at: string;
  mvno?: {
    name: string;
  };
}

export default function ApproveIssuance() {
  const urlParams = new URLSearchParams(window.location.search);
  const requestId = urlParams.get('id');
  const token = urlParams.get('token');
  
  const [request, setRequest] = useState<StockIssuanceRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [approvalRecord, setApprovalRecord] = useState<any>(null);
  
  // For manual token entry
  const [manualToken, setManualToken] = useState('');

  useEffect(() => {
    if (requestId) {
      loadRequest();
    } else {
      setError('Invalid approval link');
      setLoading(false);
    }
  }, [requestId]);

  const loadRequest = async () => {
    try {
      const { data, error } = await supabase
        .from('stock_issuance_requests')
        .select(`
          *,
          mvno:mvnos(name)
        `)
        .eq('id', requestId)
        .single();

      if (error) throw error;
      setRequest(data);
      
      // Auto-approve if token matches
      if (token) {
        handleApprove(token);
      }
    } catch (err: any) {
      setError('Request not found');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (approvalToken: string) => {
    if (!request || !approvalToken) return;
    
    try {
      setApproving(true);
      
      // Determine which level to approve based on current status and token
      let approvalLevel = 0;
      if ((request.status === 'PENDING' || request.status === 'READY_FOR_APPROVAL' || request.status === 'PENDING_LEVEL_1_APPROVAL') && request.level_1_approval_token === approvalToken) {
        approvalLevel = 1;
      } else if ((request.status === 'LEVEL_1_APPROVED' || request.status === 'PENDING_LEVEL_2_APPROVAL') && request.level_2_approval_token === approvalToken) {
        approvalLevel = 2;
      } else {
        setError('Invalid or expired approval token');
        setApproving(false);
        return;
      }

      // Call the approval function
      const { data, error } = await supabase.rpc('approve_issuance_request', {
        p_request_id: request.id,
        p_approver_id: null, // Will be set from token in production
        p_token: approvalToken,
        p_level: approvalLevel
      });

      if (error) throw error;

      // Generate approval record
      const record = await generateApprovalRecord(request, approvalLevel);
      setApprovalRecord(record);
      setApproved(true);

      // If Level 2 approval, also deduct stock
      if (approvalLevel === 2) {
        await deductStock(request);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to approve request');
      console.error(err);
    } finally {
      setApproving(false);
    }
  };

  const generateApprovalRecord = async (req: StockIssuanceRequest, level: number) => {
    // Get box details for the record
    let boxDetails: any[] = [];
    let esimDetails: string[] = [];
    
    if (req.assigned_box_quantities && req.assigned_box_quantities.length > 0) {
      const boxIds = req.assigned_box_quantities.map((b: any) => b.box_id);
      const { data: boxes } = await supabase
        .from('boxes')
        .select('*')
        .in('id', boxIds);
      boxDetails = boxes || [];
    }
    
    if (req.assigned_esim_iccids && req.assigned_esim_iccids.length > 0) {
      esimDetails = req.assigned_esim_iccids;
    }

    // Get requester info
    const { data: requesterData } = await supabase
      .from('distributors')
      .select('name')
      .eq('id', req.requester_id)
      .single();

    return {
      requestId: req.id,
      mvnoName: req.mvno?.name || 'Unknown MVNO',
      simType: req.sim_type,
      quantity: req.quantity,
      approvalLevel: level,
      approvedAt: new Date().toISOString(),
      boxes: boxDetails,
      boxQuantities: req.assigned_box_quantities || [],
      esims: esimDetails,
      notes: req.notes,
      requesterName: requesterData?.name || 'Unknown',
      level1Approver: req.level_1_approver_email,
      level2Approver: req.level_2_approver_email
    };
  };

  const deductStock = async (req: StockIssuanceRequest) => {
    try {
      // Get MVNO name
      const { data: mvnoData } = await supabase
        .from('mvnos')
        .select('name')
        .eq('id', req.mvno_id)
        .single();
      
      const mvnoName = mvnoData?.name || 'Unknown';
      
      // Deduct from boxes for physical SIMs and add to pick history
      if (req.assigned_box_quantities && req.assigned_box_quantities.length > 0) {
        for (const boxQty of req.assigned_box_quantities) {
          const { data: box } = await supabase
            .from('boxes')
            .select('*')
            .eq('id', boxQty.box_id)
            .single();
          
          if (box) {
            const newRemaining = Math.max(0, box.remaining_sims - boxQty.quantity);
            await supabase
              .from('boxes')
              .update({ remaining_sims: newRemaining })
              .eq('id', boxQty.box_id);
            
            // Add to pick history
            await supabase.from('box_pick_records').insert({
              box_id: boxQty.box_id,
              distributor_id: req.requester_id || null,
              sims_picked: boxQty.quantity,
              iccid_start: boxQty.iccid_start,
              iccid_end: boxQty.iccid_end,
              purpose: `Stock Issuance to ${mvnoName} - Level 2 Approved`,
              picked_by: null // Will be set from approver
            });
          }
        }
      }

      // Update eSIM status and add pick records
      if (req.assigned_esim_iccids && req.assigned_esim_iccids.length > 0) {
        await supabase
          .from('esim_stock')
          .update({ status: 'ISSUED', issued_at: new Date().toISOString() })
          .in('iccid', req.assigned_esim_iccids);
        
        // Add pick record for eSIMs
        await supabase.from('box_pick_records').insert({
          box_id: null,
          distributor_id: req.requester_id || null,
          sims_picked: req.assigned_esim_iccids.length,
          iccid_start: req.assigned_esim_iccids[0] || '',
          iccid_end: req.assigned_esim_iccids[req.assigned_esim_iccids.length - 1] || '',
          purpose: `eSIM Stock Issuance to ${mvnoName} - Level 2 Approved`,
          picked_by: null
        });
      }
    } catch (err) {
      console.error('Error deducting stock:', err);
    }
  };

  const printApproval = () => {
    window.print();
  };

  const goHome = () => {
    window.location.href = '/';
  };

  if (loading) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="text-center">
            <div className="spinner-border text-primary" role="status">
              <span className="visually-hidden">Loading...</span>
            </div>
            <p className="mt-3">Loading approval request...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error && !request) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="alert alert-danger">{error}</div>
          <button className="btn btn-primary" onClick={goHome}>
            Go to Home
          </button>
        </div>
      </div>
    );
  }

  // Show approval record (printable)
  if (approved && approvalRecord) {
    return (
      <div className="auth-container">
        <div className="auth-card approval-record" id="approvalRecord">
          <div className="text-center mb-4">
            <h4>Stock Issuance Form</h4>
            <span className="badge bg-success">APPROVED</span>
            <p className="text-muted mt-2">This form serves as authorization for stock release</p>
          </div>

          <div className="approval-details">
            <div className="row mb-3">
              <div className="col-6">
                <strong>Request ID:</strong>
                <p>{approvalRecord.requestId.slice(0, 8)}...</p>
              </div>
              <div className="col-6">
                <strong>Approval Level:</strong>
                <p>Level {approvalRecord.approvalLevel}</p>
              </div>
            </div>

            <div className="row mb-3">
              <div className="col-6">
                <strong>MVNO (Recipient):</strong>
                <p>{approvalRecord.mvnoName}</p>
              </div>
              <div className="col-6">
                <strong>SIM Type:</strong>
                <p>{approvalRecord.simType}</p>
              </div>
            </div>

            <div className="row mb-3">
              <div className="col-6">
                <strong>Quantity Issued:</strong>
                <p className="fw-bold">{approvalRecord.quantity}</p>
              </div>
              <div className="col-6">
                <strong>Approved At:</strong>
                <p>{new Date(approvalRecord.approvedAt).toLocaleString()}</p>
              </div>
            </div>

            {approvalRecord.requesterName && (
              <div className="row mb-3">
                <div className="col-12">
                  <strong>Requested By:</strong>
                  <p>{approvalRecord.requesterName}</p>
                </div>
              </div>
            )}

            <div className="row mb-3">
              <div className="col-6">
                <strong>Level 1 Approver:</strong>
                <p>{approvalRecord.level1Approver || 'N/A'}</p>
              </div>
              <div className="col-6">
                <strong>Level 2 Approver:</strong>
                <p>{approvalRecord.level2Approver || 'N/A'}</p>
              </div>
            </div>

            {approvalRecord.boxes && approvalRecord.boxes.length > 0 && (
              <div className="mb-3">
                <strong>Physical SIM Stock Taken:</strong>
                <table className="table table-sm mt-2 table-bordered">
                  <thead>
                    <tr>
                      <th>Box #</th>
                      <th>ICCID Start</th>
                      <th>ICCID End</th>
                      <th>Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {approvalRecord.boxQuantities.map((bq: any, idx: number) => (
                      <tr key={idx}>
                        <td>{approvalRecord.boxes[idx]?.box_number || idx + 1}</td>
                        <td><small>{bq.iccid_start}</small></td>
                        <td><small>{bq.iccid_end}</small></td>
                        <td className="fw-bold">{bq.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th colSpan={3}>Total</th>
                      <th>{approvalRecord.boxQuantities.reduce((sum: number, bq: any) => sum + bq.quantity, 0)}</th>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {approvalRecord.esims && approvalRecord.esims.length > 0 && (
              <div className="mb-3">
                <strong>eSIM ICCIDs ({approvalRecord.esims.length}):</strong>
                <p className="small">{approvalRecord.esims.slice(0, 10).join(', ')}...</p>
                <p className="text-muted"><small>Total: {approvalRecord.esims.length} eSIMs</small></p>
              </div>
            )}

            {approvalRecord.notes && (
              <div className="mb-3">
                <strong>Notes:</strong>
                <p>{approvalRecord.notes}</p>
              </div>
            )}
            
            <div className="alert alert-success mt-3">
              <i className="bi bi-check-circle me-2"></i>
              <strong>Stock Released:</strong> The above stock has been deducted from Hamilton's inventory and assigned to {approvalRecord.mvnoName}.
            </div>
          </div>

          <div className="text-center mt-4 no-print">
            <button className="btn btn-primary me-2" onClick={printApproval}>
              <i className="bi bi-printer me-2"></i>
              Print Issuance Form
            </button>
            <button className="btn btn-outline-secondary" onClick={goHome}>
              Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Show approval form
  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="text-center mb-4">
          <h3>Stock Issuance Approval</h3>
        </div>

        {error && <div className="alert alert-danger">{error}</div>}

        {request && (
          <>
            <div className="mb-3">
              <label className="form-label">MVNO</label>
              <input
                type="text"
                className="form-control"
                value={request.mvno?.name || 'Unknown'}
                disabled
              />
            </div>

            <div className="mb-3">
              <label className="form-label">SIM Type</label>
              <input
                type="text"
                className="form-control"
                value={request.sim_type}
                disabled
              />
            </div>

            <div className="mb-3">
              <label className="form-label">Quantity</label>
              <input
                type="text"
                className="form-control"
                value={request.quantity}
                disabled
              />
            </div>

            <div className="mb-3">
              <label className="form-label">Current Status</label>
              <input
                type="text"
                className="form-control"
                value={request.status}
                disabled
              />
            </div>

            {request.status === 'PENDING' || request.status === 'READY_FOR_APPROVAL' || request.status === 'PENDING_LEVEL_1_APPROVAL' && (
              <div className="alert alert-info">
                You are the Level 1 approver for this request.
              </div>
            )}
            {(request.status === 'LEVEL_1_APPROVED' || request.status === 'PENDING_LEVEL_2_APPROVAL') && (
              <div className="alert alert-info">
                You are the Level 2 approver for this request.
              </div>
            )}

            <div className="mb-3">
              <label className="form-label">Approval Token</label>
              <input
                type="text"
                className="form-control"
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                placeholder="Enter your approval token"
              />
              <div className="form-text">
                Enter the token from your email to approve this request.
              </div>
            </div>

            <button
              className="btn btn-success w-100"
              onClick={() => handleApprove(manualToken)}
              disabled={approving || !manualToken}
            >
              {approving ? 'Approving...' : 'Approve Request'}
            </button>
          </>
        )}

        <div className="text-center mt-3">
          <button className="btn btn-link" onClick={goHome}>
            Go to Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
