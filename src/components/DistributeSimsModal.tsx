import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { Distributor } from '../types/simcard';

interface DistributeSimsModalProps {
  distributor: Distributor;
  onSuccess: () => void;
  onCancel: () => void;
}

interface Carton {
  id: string;
  carton_number: string;
  mvno_id: string;
}

interface MvnoOption {
  id: string;
  name: string;
}

interface EsimItem {
  id: number;
  iccid: string;
  imsi: string;
  status: string;
}

interface BoxSelection {
  box_id: string;
  box_number: number;
  carton_number: string;
  remaining: number;
  selected: number;
}

// Helper component for MVNO selection with proper names
function MVVNOSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [mvnos, setMvnos] = useState<MvnoOption[]>([]);

  useEffect(() => {
    supabase
      .from('mvnos')
      .select('id, name')
      .order('name')
      .then(({ data }) => {
        if (data) setMvnos(data);
      });
  }, []);

  return (
    <div className="mb-3">
      <label className="form-label">Select MVNO</label>
      <select 
        className="form-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">-- Select MVNO --</option>
        {mvnos.map(m => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
    </div>
  );
}

export function DistributeSimsModal({ distributor, onSuccess, onCancel }: DistributeSimsModalProps) {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [mvnoId, setMvnoId] = useState<string>('');
  const [simType, setSimType] = useState<'ESIM' | 'PHYSICAL'>('PHYSICAL');
  
  // eSIM state
  const [esimSearch, setEsimSearch] = useState<string>('');
  const [availableEsims, setAvailableEsims] = useState<EsimItem[]>([]);
  const [selectedEsims, setSelectedEsims] = useState<EsimItem[]>([]);
  const [esimsLoading, setEsimsLoading] = useState(false);

  // Physical SIM state
  const [cartons, setCartons] = useState<Carton[]>([]);
  const [selectedCarton, setSelectedCarton] = useState<string>('');
  const [boxes, setBoxes] = useState<BoxSelection[]>([]);

  // Data fetching - fetch cartons when MVNO changes
  useEffect(() => {
    if (mvnoId && simType === 'PHYSICAL') {
      fetchCartons();
    }
  }, [mvnoId, simType]);

  // Fetch boxes when carton changes
  useEffect(() => {
    if (selectedCarton) {
      fetchBoxes();
    }
  }, [selectedCarton]);

  // Search eSIMs when search changes
  useEffect(() => {
    if (mvnoId && simType === 'ESIM' && esimSearch.length >= 3) {
      searchEsims();
    }
  }, [esimSearch, mvnoId, simType]);

  const fetchCartons = async () => {
    try {
      const { data, error } = await supabase
        .from('cartons')
        .select('id, carton_number, mvno_id')
        .eq('mvno_id', mvnoId)
        .order('carton_number');
      
      if (error) throw error;
      setCartons(data || []);
    } catch (err) {
      console.error('Error fetching cartons:', err);
    }
  };

  const fetchBoxes = async () => {
    try {
      const { data, error } = await supabase
        .from('boxes')
        .select('id, box_number, remaining_sims, total_sims, cartons!inner(carton_number)')
        .eq('cartons.mvno_id', mvnoId)
        .eq('cartons.id', selectedCarton)
        .gt('remaining_sims', 0)
        .order('box_number');
      
      if (error) throw error;
      
      const boxesWithCarton = (data || []).map((box: any) => ({
        box_id: box.id,
        box_number: box.box_number,
        carton_number: box.cartons?.carton_number || '',
        remaining: box.remaining_sims || 0,
        selected: 0
      }));
      setBoxes(boxesWithCarton);
    } catch (err) {
      console.error('Error fetching boxes:', err);
    }
  };

  const searchEsims = async () => {
    setEsimsLoading(true);
    try {
      // Get mvno name from mvnos table
      const { data: mvnoData } = await supabase
        .from('mvnos')
        .select('name')
        .eq('id', mvnoId)
        .single();
      
      const operator = mvnoData?.name || '';

      const { data, error } = await supabase
        .from('esim_stock')
        .select('id, iccid, imsi, status')
        .eq('operator', operator)
        .eq('status', 'IN_STOCK')
        .ilike('iccid', `%${esimSearch}%`)
        .limit(50);
      
      if (error) throw error;
      setAvailableEsims(data || []);
    } catch (err) {
      console.error('Error searching eSIMs:', err);
    } finally {
      setEsimsLoading(false);
    }
  };

  const handleBoxQuantityChange = (boxId: string, quantity: number) => {
    setBoxes(boxes.map(b => 
      b.box_id === boxId 
        ? { ...b, selected: Math.min(Math.max(0, quantity), b.remaining) }
        : b
    ));
  };

  const toggleEsimSelection = (esim: EsimItem) => {
    setSelectedEsims(prev => {
      const exists = prev.find(e => e.iccid === esim.iccid);
      if (exists) {
        return prev.filter(e => e.iccid !== esim.iccid);
      }
      return [...prev, esim];
    });
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      if (simType === 'ESIM') {
        if (selectedEsims.length === 0) {
          setError('Please select at least one eSIM');
          return;
        }

        const iccids = selectedEsims.map(e => e.iccid);
        
        const { data, error: rpcError } = await supabase.rpc('distribute_esims', {
          p_distributor_id: distributor.id,
          p_mvno_id: mvnoId,
          p_iccids: iccids,
          p_purpose: null
        });

        if (rpcError) throw rpcError;
        
        if (data && data[0]) {
          if (data[0].success) {
            setSuccess(data[0].message);
            setTimeout(() => onSuccess(), 1500);
          } else {
            setError(data[0].message);
          }
        }
      } else {
        // Physical SIMs
        const selectedBoxes = boxes.filter(b => b.selected > 0);
        
        if (selectedBoxes.length === 0) {
          setError('Please select at least one box with quantity');
          return;
        }

        // For single box distribution
        if (selectedBoxes.length === 1) {
          const box = selectedBoxes[0];
          const { data, error: rpcError } = await supabase.rpc('distribute_physical_box', {
            p_distributor_id: distributor.id,
            p_box_id: box.box_id,
            p_quantity: box.selected,
            p_purpose: null
          });

          if (rpcError) throw rpcError;
          
          if (data && data[0]) {
            if (data[0].success) {
              setSuccess(data[0].message);
              setTimeout(() => onSuccess(), 1500);
            } else {
              setError(data[0].message);
            }
          }
        } else {
          // Multiple boxes
          const boxQuantities = selectedBoxes.map(b => ({
            box_id: b.box_id,
            quantity: b.selected
          }));

          const { data, error: rpcError } = await supabase.rpc('distribute_physical_boxes', {
            p_distributor_id: distributor.id,
            p_box_quantities: boxQuantities,
            p_purpose: null
          });

          if (rpcError) throw rpcError;
          
          if (data && data[0]) {
            if (data[0].success) {
              setSuccess(data[0].message);
              setTimeout(() => onSuccess(), 1500);
            } else {
              setError(data[0].message);
            }
          }
        }
      }
    } catch (err: any) {
      setError(err.message || 'Failed to distribute SIMs');
    } finally {
      setSubmitting(false);
    }
  };

  const totalSelected = simType === 'ESIM' 
    ? selectedEsims.length 
    : boxes.reduce((sum, b) => sum + b.selected, 0);

  return (
    <div className="modal fade show d-block" tabIndex={-1} style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
      <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
        <div className="modal-content modal-custom">
          <div className="modal-header">
            <h5 className="modal-title">
              <i className="bi bi-box-seam me-2"></i>
              Distribute SIMs to {distributor.name}
            </h5>
            <button type="button" className="btn-close btn-close-white" onClick={onCancel}></button>
          </div>
          
          <div className="modal-body">
            {/* Distributor Info */}
            <div className="alert alert-custom bg-dark-custom border-secondary mb-4">
              <div className="d-flex align-items-center">
                <i className="bi bi-person-circle fs-4 me-3 text-accent"></i>
                <div>
                  <strong>{distributor.name}</strong>
                  <span className="mx-2">|</span>
                  <span className="text-muted-custom">{distributor.type.replace('_', ' ')}</span>
                  {distributor.location && (
                    <>
                      <span className="mx-2">|</span>
                      <span className="text-muted-custom">{distributor.location}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Error/Success Messages */}
            {error && (
              <div className="alert alert-danger py-2 mb-3">{error}</div>
            )}
            {success && (
              <div className="alert alert-success py-2 mb-3">{success}</div>
            )}

            {/* MVNO Selection */}
            <MVVNOSelect value={mvnoId} onChange={(id) => {
              setMvnoId(id);
              setSelectedCarton('');
              setBoxes([]);
              setSelectedEsims([]);
              setEsimSearch('');
            }} />

            {/* SIM Type Selection */}
            <div className="mb-3">
              <label className="form-label">SIM Type</label>
              <div className="btn-group w-100" role="group">
                <input 
                  type="radio" 
                  className="btn-check" 
                  name="simType" 
                  id="simTypePhysical" 
                  checked={simType === 'PHYSICAL'} 
                  onChange={() => setSimType('PHYSICAL')}
                />
                <label className="btn btn-outline-custom" htmlFor="simTypePhysical">
                  <i className="bi bi-sim me-1"></i> Physical SIM
                </label>
                
                <input 
                  type="radio" 
                  className="btn-check" 
                  name="simType" 
                  id="simTypeEsim" 
                  checked={simType === 'ESIM'} 
                  onChange={() => setSimType('ESIM')}
                />
                <label className="btn btn-outline-custom" htmlFor="simTypeEsim">
                  <i className="bi bi-phone me-1"></i> eSIM
                </label>
              </div>
            </div>

            {/* Physical SIM Selection */}
            {simType === 'PHYSICAL' && (
              <div className="physical-selection">
                <div className="mb-3">
                  <label className="form-label">Select Carton</label>
                  <select 
                    className="form-select"
                    value={selectedCarton}
                    onChange={(e) => setSelectedCarton(e.target.value)}
                  >
                    <option value="">-- Select Carton --</option>
                    {cartons.map(c => (
                      <option key={c.id} value={c.id}>{c.carton_number}</option>
                    ))}
                  </select>
                </div>

                {selectedCarton && (
                  <div className="mb-3">
                    <label className="form-label">Select Boxes (with remaining stock)</label>
                    <div className="table-responsive" style={{ maxHeight: '300px' }}>
                      <table className="table table-custom table-sm">
                        <thead>
                          <tr>
                            <th>Box</th>
                            <th>Remaining</th>
                            <th>Select Qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {boxes.map(box => (
                            <tr key={box.box_id}>
                              <td>Box {box.box_number}</td>
                              <td>
                                <span className="badge bg-success">{box.remaining}</span>
                              </td>
                              <td>
                                <input 
                                  type="number" 
                                  className="form-control form-control-sm"
                                  style={{ width: '80px' }}
                                  min="0"
                                  max={box.remaining}
                                  value={box.selected}
                                  onChange={(e) => handleBoxQuantityChange(box.box_id, parseInt(e.target.value) || 0)}
                                />
                              </td>
                            </tr>
                          ))}
                          {boxes.length === 0 && (
                            <tr>
                              <td colSpan={3} className="text-center text-muted">
                                No boxes with remaining stock
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* eSIM Selection */}
            {simType === 'ESIM' && (
              <div className="esim-selection">
                <div className="mb-3">
                  <label className="form-label">Search eSIM by ICCID</label>
                  <input 
                    type="text"
                    className="form-control"
                    placeholder="Enter at least 3 characters..."
                    value={esimSearch}
                    onChange={(e) => setEsimSearch(e.target.value)}
                  />
                  {esimsLoading && <small className="text-muted">Searching...</small>}
                </div>

                {availableEsims.length > 0 && (
                  <div className="mb-3">
                    <label className="form-label">
                      Available eSIMs ({availableEsims.length}) - Select to add
                    </label>
                    <div className="table-responsive" style={{ maxHeight: '300px' }}>
                      <table className="table table-custom table-sm">
                        <thead>
                          <tr>
                            <th>Select</th>
                            <th>ICCID</th>
                            <th>IMSI</th>
                          </tr>
                        </thead>
                        <tbody>
                          {availableEsims.map(esim => {
                            const isSelected = selectedEsims.some(e => e.iccid === esim.iccid);
                            return (
                              <tr key={esim.id} className={isSelected ? 'table-success' : ''}>
                                <td>
                                  <input 
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleEsimSelection(esim)}
                                  />
                                </td>
                                <td className="mono">{esim.iccid}</td>
                                <td className="mono">{esim.imsi}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {selectedEsims.length > 0 && (
                  <div className="alert alert-info">
                    <strong>{selectedEsims.length}</strong> eSIM(s) selected for distribution
                  </div>
                )}
              </div>
            )}
          </div>
          
          <div className="modal-footer">
            <div className="d-flex justify-content-between align-items-center w-100">
              <div>
                {totalSelected > 0 && (
                  <span className="badge bg-success fs-6">
                    {totalSelected} SIM(s) to distribute
                  </span>
                )}
              </div>
              <div>
                <button type="button" className="btn btn-secondary me-2" onClick={onCancel}>
                  Cancel
                </button>
                <button 
                  type="button" 
                  className="btn btn-accent"
                  onClick={handleSubmit}
                  disabled={submitting || totalSelected === 0}
                >
                  {submitting ? (
                    <>
                      <span className="spinner-border spinner-border-sm me-1" role="status"></span>
                      Distributing...
                    </>
                  ) : (
                    <>Distribute {totalSelected} SIM(s)</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
