import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { Mvno, SimType } from '../types/simcard';

interface CartonInfo {
  cartonId: string;
  cartonNumber: string;
  totalBoxes: number;
  availableBoxes: number;
  totalSims: number;
  availableSims: number;
}

interface BoxInfo {
  boxId: string;
  cartonNumber: string;
  boxNumber: number;
  boxDisplay: string;
  remainingSims: number;
}

export function ExternalStockRequest() {
  // Get token and distributor from URL params
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  const distributorId = urlParams.get('distributor');
  
  const [loading, setLoading] = useState(true);
  const [validToken, setValidToken] = useState(false);
  const [distributor, setDistributor] = useState<any>(null);
  const [mvnos, setMvnos] = useState<Mvno[]>([]);
  const [cartons, setCartons] = useState<CartonInfo[]>([]);
  const [boxes, setBoxes] = useState<BoxInfo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Form state
  const [selectedMvno, setSelectedMvno] = useState('');
  const [simType, setSimType] = useState<SimType>('PHYSICAL');
  const [quantity, setQuantity] = useState(100);
  const [selectedCartonIds, setSelectedCartonIds] = useState<string[]>([]);
  const [allocatedBoxes, setAllocatedBoxes] = useState<{boxId: string; quantity: number}[]>([]);
  const [notes, setNotes] = useState('');
  const [stockWarning, setStockWarning] = useState<string | null>(null);

  useEffect(() => {
    if (token) {
      validateToken();
    } else if (distributorId) {
      loadDistributor(distributorId);
    } else {
      setLoading(false);
      setError('Invalid request link. Please check your link or contact administrator.');
    }
  }, [token, distributorId]);

  useEffect(() => {
    if (selectedMvno && simType) {
      loadCartonsAndBoxes();
    }
  }, [selectedMvno, simType]);

  // Reload stock and auto-allocate when quantity changes
  useEffect(() => {
    if (selectedMvno && simType && quantity > 0) {
      // Reload stock to get latest availability
      loadCartonsAndBoxes().then(() => {
        // Auto-allocation happens in the other useEffect
      });
    }
  }, [quantity, selectedMvno, simType]);

  const validateToken = async () => {
    try {
      setLoading(true);
      
      const { data: distData, error: distError } = await supabase
        .from('distributors')
        .select('*')
        .eq('request_token', token)
        .single();

      if (distError || !distData) {
        setError('Invalid or expired request link');
        setLoading(false);
        return;
      }

      if (distData.request_token_expires && new Date(distData.request_token_expires) < new Date()) {
        setError('This request link has expired. Please contact your administrator for a new link.');
        setLoading(false);
        return;
      }

      setDistributor(distData);
      setValidToken(true);
      
      if (distData.mvno_id) {
        setSelectedMvno(distData.mvno_id);
      }
      
      await loadMvnos();
      setLoading(false);
    } catch (err) {
      console.error('Error validating token:', err);
      setError('Failed to validate request link');
      setLoading(false);
    }
  };

  const loadDistributor = async (id: string) => {
    try {
      setLoading(true);
      
      const { data: distData, error: distError } = await supabase
        .from('distributors')
        .select('*')
        .eq('id', id)
        .single();

      if (distError || !distData) {
        setError('Distributor not found');
        setLoading(false);
        return;
      }

      setDistributor(distData);
      setValidToken(true);
      
      if (distData.mvno_id) {
        setSelectedMvno(distData.mvno_id);
      }
      
      await loadMvnos();
      setLoading(false);
    } catch (err) {
      console.error('Error loading distributor:', err);
      setError('Failed to load distributor');
      setLoading(false);
    }
  };

  const loadMvnos = async () => {
    const { data: mvnosData } = await supabase
      .from('mvnos')
      .select('*')
      .order('name');
    
    if (mvnosData) {
      setMvnos(mvnosData);
    }
  };

  const loadCartonsAndBoxes = async () => {
    try {
      if (!selectedMvno) return;

      // Determine owner type based on distributor assignment
      // If distributor has mvno_id → boxes owned by that MVNO
      // If distributor has no mvno_id → boxes owned by HAMILTON (Superadmin pool)
      const ownerType = distributor?.mvno_id ? 'MVNO' : 'HAMILTON';
      const ownerId = distributor?.mvno_id || selectedMvno;

      // First try: Fetch boxes using ownership columns (source of truth)
      let { data: boxesData, error } = await supabase
        .from('boxes')
        .select(`
          *,
          cartons(carton_number, mvno_id)
        `)
        .eq('owner_type', ownerType)
        .eq('owner_id', ownerId)
        .gt('remaining_sims', 0);

      // Fallback: If no ownership-based results, check carton.mvno_id
      if (!boxesData || boxesData.length === 0) {
        console.log('No ownership-based boxes found, checking carton.mvno_id...');
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('boxes')
          .select(`
            *,
            cartons(carton_number, mvno_id)
          `)
          .eq('cartons.mvno_id', selectedMvno)
          .gt('remaining_sims', 0);
        
        boxesData = fallbackData;
        error = fallbackError;
      }

      if (error) {
        console.error('Error loading boxes:', error);
      }

      // Group boxes by carton_number
      const boxesByCarton: Record<string, BoxInfo[]> = {};
      const cartonStats: Record<string, { count: number; sims: number }> = {};
      
      (boxesData || []).forEach((b: any) => {
        const cartonNum = b.cartons?.carton_number || 'Unknown';
        if (!boxesByCarton[cartonNum]) {
          boxesByCarton[cartonNum] = [];
          cartonStats[cartonNum] = { count: 0, sims: 0 };
        }
        boxesByCarton[cartonNum].push({
          boxId: b.id,
          cartonNumber: cartonNum,
          boxNumber: b.box_number || 0,
          boxDisplay: b.box_display || `Box ${b.box_number}`,
          remainingSims: b.remaining_sims || 0
        });
        cartonStats[cartonNum].count++;
        cartonStats[cartonNum].sims += b.remaining_sims || 0;
      });

      // Create carton list from grouped data
      const cartonList: CartonInfo[] = Object.keys(boxesByCarton).map(cartonNum => {
        // Sort boxes in this carton by box number
        boxesByCarton[cartonNum].sort((a, b) => a.boxNumber - b.boxNumber);
        
        return {
          cartonId: cartonNum, // Use carton number as ID since no cartons table
          cartonNumber: cartonNum,
          totalBoxes: cartonStats[cartonNum].count,
          availableBoxes: cartonStats[cartonNum].count,
          totalSims: cartonStats[cartonNum].sims,
          availableSims: cartonStats[cartonNum].sims
        };
      });

      // Sort cartons by number (extract numeric part)
      cartonList.sort((a, b) => {
        const aNum = parseInt(a.cartonNumber.replace(/\D/g, '')) || 0;
        const bNum = parseInt(b.cartonNumber.replace(/\D/g, '')) || 0;
        return aNum - bNum;
      });

      setCartons(cartonList.filter(c => c.availableBoxes > 0));
      
      // Flatten all boxes for reference
      const allBoxes: BoxInfo[] = [];
      Object.values(boxesByCarton).forEach(cartonBoxes => {
        allBoxes.push(...cartonBoxes);
      });
      setBoxes(allBoxes);
    } catch (err) {
      console.error('Error loading stock:', err);
    }
  };

  // Auto-allocate boxes based on quantity
  const autoAllocateBoxes = () => {
    if (boxes.length === 0 || quantity <= 0) {
      setAllocatedBoxes([]);
      setSelectedCartonIds([]);
      return;
    }

    let remaining = quantity;
    const allocation: {boxId: string; quantity: number}[] = [];
    const selectedCartons: string[] = [];

    // Sort boxes by carton number then box number (sequential order)
    const sortedBoxes = [...boxes].sort((a, b) => {
      const aNum = parseInt(a.cartonNumber.replace(/\D/g, '')) || 0;
      const bNum = parseInt(b.cartonNumber.replace(/\D/g, '')) || 0;
      if (aNum !== bNum) return aNum - bNum;
      return a.boxNumber - b.boxNumber;
    });

    for (const box of sortedBoxes) {
      if (remaining <= 0) break;
      if (box.remainingSims > 0) {
        const toAllocate = Math.min(box.remainingSims, remaining);
        allocation.push({ boxId: box.boxId, quantity: toAllocate });
        if (!selectedCartons.includes(box.cartonNumber)) {
          selectedCartons.push(box.cartonNumber);
        }
        remaining -= toAllocate;
      }
    }

    setAllocatedBoxes(allocation);
    setSelectedCartonIds(selectedCartons);
    
    // Show warning if requested quantity exceeds available
    const totalAvailable = boxes.reduce((sum, b) => sum + b.remainingSims, 0);
    if (quantity > totalAvailable) {
      setStockWarning(`Warning: Requested quantity (${quantity}) exceeds available stock (${totalAvailable}). Your request may be partially fulfilled.`);
    } else {
      setStockWarning(null);
    }
  };

  // Auto-allocate when quantity or boxes change
  useEffect(() => {
    autoAllocateBoxes();
  }, [quantity, boxes]);

  const getSelectedBoxes = () => {
    const selectedCartons = cartons.filter(c => selectedCartonIds.includes(c.cartonId));
    const selectedCartonNumbers = selectedCartons.map(c => c.cartonNumber);
    return boxes.filter(b => selectedCartonNumbers.includes(b.cartonNumber));
  };

  const toggleCartonSelection = (cartonId: string) => {
    setSelectedCartonIds(prev => 
      prev.includes(cartonId) 
        ? prev.filter(id => id !== cartonId)
        : [...prev, cartonId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!selectedMvno || quantity <= 0) {
      setError('Please select an MVNO and quantity');
      return;
    }

    if (selectedCartonIds.length === 0) {
      setError('No available stock for the selected criteria');
      return;
    }

    try {
      setSubmitting(true);
      setError(null);

      // Get the box IDs from selected cartons
      const selectedCartons = cartons.filter(c => selectedCartonIds.includes(c.cartonId));
      const selectedCartonNumbers = selectedCartons.map(c => c.cartonNumber);
      const selectedBoxIds = boxes
        .filter(b => selectedCartonNumbers.includes(b.cartonNumber))
        .map(b => b.boxId);

      const requestData = {
        distributor_id: distributor?.id,
        mvno_id: selectedMvno,
        sim_type: simType,
        quantity: quantity,
        assigned_box_ids: selectedBoxIds,
        notes: notes,
        status: 'PENDING'
      };

      // Determine which table to insert based on request_target field
      // request_target: 'stock_issuance' → Superadmin, 'stock_request' → MVNO
      const requestTarget = distributor?.request_target || 'stock_issuance';
      const isDirectDistribution = requestTarget === 'stock_issuance' || !distributor?.mvno_id;
      
      let insertData;
      if (isDirectDistribution) {
        // For Superadmin direct distribution - use stock_issuance_requests schema
        insertData = {
          mvno_id: selectedMvno,
          requester_id: distributor?.id,
          sim_type: simType,
          quantity: quantity,
          status: 'PENDING',
          notes: notes
        };
      } else {
        // For MVNO distribution - use stock_requests schema
        insertData = {
          distributor_id: distributor?.id,
          mvno_id: selectedMvno,
          sim_type: simType,
          quantity: quantity,
          assigned_box_ids: selectedBoxIds,
          notes: notes,
          status: 'PENDING'
        };
      }

      const targetTable = isDirectDistribution ? 'stock_issuance_requests' : 'stock_requests';

      console.log('Submitting to table:', targetTable);
      console.log('Insert data:', insertData);
      console.log('Distributor request_target:', requestTarget);
      console.log('Distributor mvno_id:', distributor?.mvno_id);

      const { error: insertError } = await supabase
        .from(targetTable)
        .insert(insertData);

      if (insertError) {
        console.error('Insert error:', insertError);
        throw insertError;
      }

      console.log('Insert successful!');

      // Create notification based on whether distributor has MVNO assigned
      if (distributor?.mvno_id) {
        // Notify MVNO admin
        const { data: mvnoAdmins } = await supabase
          .from('platform_users')
          .select('id')
          .eq('mvno_id', distributor.mvno_id)
          .eq('role', 'MVNO_ADMIN');

        if (mvnoAdmins && mvnoAdmins.length > 0) {
          const notifications = mvnoAdmins.map(admin => ({
            user_id: admin.id,
            title: 'New Stock Request',
            message: `New stock request from ${distributor.name}: ${quantity} ${simType} SIMs`,
            type: 'WARNING',
            link: '/distributor-requests'
          }));

          // Try to send notification (ignore errors if table doesn't exist)
          try {
            await supabase.from('notifications').insert(notifications);
          } catch (notifErr) {
            console.warn('Notification failed (table may not exist):', notifErr);
          }
        }
      } else {
        // Notify Superadmin (Hamilton) - distributor not assigned to any MVNO
        const { data: superAdmins } = await supabase
          .from('platform_users')
          .select('id')
          .eq('role', 'SUPER_ADMIN');

        if (superAdmins && superAdmins.length > 0) {
          const notifications = superAdmins.map(admin => ({
            user_id: admin.id,
            title: 'New Stock Request',
            message: `New stock request from ${distributor?.name || 'Distributor'}: ${quantity} ${simType} SIMs`,
            type: 'WARNING',
            link: '/stock-requests'
          }));

          // Try to send notification (ignore errors if table doesn't exist)
          try {
            await supabase.from('notifications').insert(notifications);
          } catch (notifErr) {
            console.warn('Notification failed (table may not exist):', notifErr);
          }
        }
      }

      setSuccess(true);
    } catch (err: any) {
      console.error('Error submitting request:', err);
      setError(err.message || 'Failed to submit request');
    } finally {
      setSubmitting(false);
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="min-vh-100 d-flex align-items-center justify-content-center" 
           style={{ background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' }}>
        <div className="text-center text-white">
          <div className="spinner-border spinner-border-lg mb-3" role="status"></div>
          <p>Validating request link...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !validToken) {
    return (
      <div className="min-vh-100 d-flex align-items-center justify-content-center" 
           style={{ background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' }}>
        <div className="card border-0 shadow-lg" style={{ borderRadius: '20px', maxWidth: '500px' }}>
          <div className="card-body p-5 text-center">
            <i className="bi bi-exclamation-triangle display-1 text-danger"></i>
            <h3 className="mt-4 text-dark">Invalid Request Link</h3>
            <p className="text-muted">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  // Success state
  if (success) {
    return (
      <div className="min-vh-100 d-flex align-items-center justify-content-center" 
           style={{ background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' }}>
        <div className="card border-0 shadow-lg" style={{ borderRadius: '20px', maxWidth: '500px' }}>
          <div className="card-body p-5 text-center">
            <i className="bi bi-check-circle display-1 text-success"></i>
            <h3 className="mt-4 text-dark">Request Submitted!</h3>
            <p className="text-muted">Your stock request has been submitted successfully.</p>
            <div className="alert alert-info mt-4">
              <strong>Request Details:</strong><br/>
              MVNO: {mvnos.find(m => m.id === selectedMvno)?.name}<br/>
              SIM Type: {simType}<br/>
              Quantity: {quantity}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const selectedBoxes = getSelectedBoxes();
  const totalSelectedSims = selectedBoxes.reduce((sum, b) => sum + b.remainingSims, 0);

  return (
    <div className="min-vh-100 d-flex align-items-center justify-content-center py-5" 
         style={{ background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' }}>
      <div className="container">
        <div className="row justify-content-center">
          <div className="col-12 col-lg-8">
            <div className="card border-0 shadow-lg" style={{ borderRadius: '20px', overflow: 'hidden' }}>
              <div className="bg-dark text-white p-4">
                <div className="text-center">
                  <i className="bi bi-box-seam display-4"></i>
                  <h2 className="mt-3 fw-bold">Stock Request Form</h2>
                  <p className="text-white-50 mb-0">
                    {distributor ? <>Requesting as: <strong>{distributor.name}</strong></> : 'External Stock Request'}
                  </p>
                </div>
              </div>

              <div className="p-4 bg-light">
                <form onSubmit={handleSubmit}>
                  {stockWarning && (
                    <div className="alert alert-warning mb-4">
                      <i className="bi bi-exclamation-triangle me-2"></i>
                      {stockWarning}
                    </div>
                  )}

                  {error && (
                    <div className="alert alert-danger mb-4">
                      <i className="bi bi-exclamation-circle me-2"></i>
                      {error}
                    </div>
                  )}

                  <div className="mb-4">
                    <label className="form-label fw-bold">Select MVNO *</label>
                    <select
                      className="form-select form-select-lg"
                      value={selectedMvno}
                      onChange={(e) => setSelectedMvno(e.target.value)}
                      required
                    >
                      <option value="">-- Select MVNO --</option>
                      {mvnos.map(mvno => (
                        <option key={mvno.id} value={mvno.id}>{mvno.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="mb-4">
                    <label className="form-label fw-bold">SIM Type *</label>
                    <div className="d-flex gap-3">
                      <div className="form-check">
                        <input
                          className="form-check-input"
                          type="radio"
                          name="simType"
                          id="simPhysical"
                          value="PHYSICAL"
                          checked={simType === 'PHYSICAL'}
                          onChange={(e) => setSimType(e.target.value as SimType)}
                        />
                        <label className="form-check-label" htmlFor="simPhysical">
                          <i className="bi bi-sim me-1"></i> Physical SIM
                        </label>
                      </div>
                      <div className="form-check">
                        <input
                          className="form-check-input"
                          type="radio"
                          name="simType"
                          id="simEsim"
                          value="ESIM"
                          checked={simType === 'ESIM'}
                          onChange={(e) => setSimType(e.target.value as SimType)}
                        />
                        <label className="form-check-label" htmlFor="simEsim">
                          <i className="bi bi-phone me-1"></i> eSIM
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="mb-4">
                    <label className="form-label fw-bold">Quantity *</label>
                    <div className="input-group input-group-lg">
                      <span className="input-group-text"><i className="bi bi-hash"></i></span>
                      <input
                        type="number"
                        className="form-control"
                        value={quantity}
                        onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 0))}
                        min={1}
                        max={10000}
                        required
                      />
                    </div>
                    <small className="text-muted">
                      Enter the number of SIM cards you need. The admin will assign available stock during approval.
                    </small>
                  </div>

                  <div className="mb-4">
                    <label className="form-label fw-bold">Notes (Optional)</label>
                    <textarea
                      className="form-control"
                      rows={3}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Add any additional notes..."
                    />
                  </div>

                  <div className="d-grid gap-2">
                    <button
                      type="submit"
                      className="btn btn-dark btn-lg"
                      disabled={submitting || !selectedMvno || quantity <= 0}
                    >
                      {submitting ? (
                        <>
                          <span className="spinner-border spinner-border-sm me-2" role="status"></span>
                          Submitting Request...
                        </>
                      ) : (
                        <>
                          <i className="bi bi-send me-2"></i>
                          Submit Stock Request
                        </>
                      )}
                    </button>
                    {selectedCartonIds.length === 0 && quantity > 0 && (
                      <small className="text-muted text-center">
                        <i className="bi bi-info-circle me-1"></i>
                        No cartons available - admin will allocate stock during approval
                      </small>
                    )}
                  </div>
                </form>
              </div>

              <div className="bg-dark text-white-50 p-3 text-center">
                <small>Powered by Hamilton Telecom SIM Stock Management</small>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ExternalStockRequest;
