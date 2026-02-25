import { useState, useMemo } from 'react';
import type { BoxStockSummary, Distributor } from '../types/simcard';

interface BoxSelectionModalProps {
  distributor: Distributor;
  boxes: BoxStockSummary[];
  onPick: (
    boxId: string, 
    distributorId: string, 
    quantity: number,
    purpose?: string
  ) => Promise<{ success: boolean; message: string }>;
  loading: boolean;
  onSuccess: () => void;
  onCancel: () => void;
}

export function BoxSelectionModal({
  distributor,
  boxes,
  onPick,
  loading,
  onSuccess,
  onCancel
}: BoxSelectionModalProps) {
  const [selectedBox, setSelectedBox] = useState<BoxStockSummary | null>(null);
  const [quantity, setQuantity] = useState<number>(1);
  const [purpose, setPurpose] = useState<string>('');
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  // Group boxes by MVNO
  const boxesByMvno = useMemo(() => {
    const grouped: Record<string, BoxStockSummary[]> = {};
    boxes.forEach(box => {
      if (!grouped[box.mvno]) {
        grouped[box.mvno] = [];
      }
      grouped[box.mvno].push(box);
    });
    return grouped;
  }, [boxes]);

  // Filter boxes by selected MVNO
  const filteredBoxes = useMemo(() => {
    if (!selectedBox) return [];
    return boxes.filter(b => b.mvno === selectedBox.mvno);
  }, [boxes, selectedBox]);

  const handlePick = async () => {
    if (!selectedBox) return;

    const pickResult = await onPick(
      selectedBox.box_id,
      distributor.id,
      quantity,
      purpose || undefined
    );

    setResult(pickResult);

    if (pickResult.success) {
      setTimeout(() => {
        onSuccess();
      }, 1500);
    }
  };

  const formatIccid = (iccid: string) => {
    return iccid;
  };

  const maxQuantity = selectedBox?.remaining_sims ?? 250;

  return (
    <div className="modal fade show d-block" tabIndex={-1} style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
      <div className="modal-dialog modal-lg modal-dialog-centered">
        <div className="modal-content modal-custom">
          <div className="modal-header">
            <h5 className="modal-title">
              <i className="bi bi-box-seam me-2"></i>
              Distribute SIMs to {distributor.name}
            </h5>
            <button 
              type="button" 
              className="btn-close btn-close-white"
              onClick={onCancel}
            ></button>
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

            {/* Result Alert */}
            {result && (
              <div className={`alert ${result.success ? 'alert-success-custom' : 'alert-danger-custom'} alert-dismissible fade show`} role="alert">
                <i className={`bi ${result.success ? 'bi-check-circle' : 'bi-exclamation-triangle'} me-2`}></i>
                {result.message}
                <button type="button" className="btn-close" onClick={() => setResult(null)}></button>
              </div>
            )}

            {/* Box Selection */}
            {!selectedBox ? (
              <div>
                <h6 className="mb-3">Select a Box</h6>
                {Object.keys(boxesByMvno).length === 0 ? (
                  <div className="text-center py-4 text-muted-custom">
                    <i className="bi bi-inbox fs-1"></i>
                    <p className="mt-2">No boxes with remaining SIMs available</p>
                  </div>
                ) : (
                  <div className="row g-3">
                    {Object.entries(boxesByMvno).map(([mvno, mvnoBoxes]) => (
                      <div key={mvno} className="col-12">
                        <h6 className="text-muted-custom mb-2">
                          <span className="badge bg-primary me-2">{mvno}</span>
                          {mvnoBoxes.length} boxes available
                        </h6>
                        <div className="row g-2">
                          {mvnoBoxes.slice(0, 6).map(box => (
                            <div key={box.box_id} className="col-6 col-md-4">
                              <button
                                className="btn btn-outline-custom w-100 text-start p-2"
                                onClick={() => setSelectedBox(box)}
                              >
                                <div className="d-flex justify-content-between align-items-center">
                                  <span className="fw-bold">Box {box.box_display || box.box_number}</span>
                                  <span className="badge bg-success">{box.remaining_sims} left</span>
                                </div>
                                <small className="text-muted-custom d-block mt-1">
                                  {formatIccid(box.iccid_start).substring(0, 15)}...
                                </small>
                              </button>
                            </div>
                          ))}
                          {mvnoBoxes.length > 6 && (
                            <div className="col-12">
                              <small className="text-muted-custom">
                                +{mvnoBoxes.length - 6} more {mvno} boxes
                              </small>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div>
                {/* Selected Box Info */}
                <div className="card card-custom mb-4">
                  <div className="card-body">
                    <div className="d-flex justify-content-between align-items-start">
                      <div>
                        <h6 className="mb-1">
                          <span className="badge bg-primary me-2">{selectedBox.mvno}</span>
                          Carton {selectedBox.carton_number} - Box {selectedBox.box_display || selectedBox.box_number}
                        </h6>
                        <div className="mt-2">
                          <small className="text-muted-custom d-block">
                            <strong>ICCID Range:</strong>
                          </small>
                          <code className="mono">{formatIccid(selectedBox.iccid_start)}</code>
                          <span className="mx-2">to</span>
                          <code className="mono">{formatIccid(selectedBox.iccid_end)}</code>
                        </div>
                      </div>
                      <button 
                        className="btn btn-sm btn-outline-custom"
                        onClick={() => setSelectedBox(null)}
                      >
                        Change
                      </button>
                    </div>
                    
                    <div className="row mt-3">
                      <div className="col-4">
                        <div className="text-center p-2 bg-dark rounded">
                          <div className="fs-4 fw-bold">{selectedBox.total_sims}</div>
                          <small className="text-muted-custom">Total</small>
                        </div>
                      </div>
                      <div className="col-4">
                        <div className="text-center p-2 bg-dark rounded">
                          <div className="fs-4 fw-bold text-success">{selectedBox.remaining_sims}</div>
                          <small className="text-muted-custom">Remaining</small>
                        </div>
                      </div>
                      <div className="col-4">
                        <div className="text-center p-2 bg-dark rounded">
                          <div className="fs-4 fw-bold text-warning">{selectedBox.issued_sims}</div>
                          <small className="text-muted-custom">Issued</small>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Quantity Input */}
                <div className="mb-3">
                  <label className="form-label">Number of SIMs to Distribute</label>
                  <div className="d-flex align-items-center gap-3">
                    <button 
                      className="btn btn-outline-custom"
                      onClick={() => setQuantity(Math.max(1, quantity - 10))}
                      disabled={quantity <= 1}
                    >
                      -10
                    </button>
                    <button 
                      className="btn btn-outline-custom"
                      onClick={() => setQuantity(Math.max(1, quantity - 1))}
                      disabled={quantity <= 1}
                    >
                      -1
                    </button>
                    <input
                      type="number"
                      className="form-control form-control-custom text-center"
                      value={quantity}
                      onChange={(e) => setQuantity(Math.min(maxQuantity, Math.max(1, parseInt(e.target.value) || 1)))}
                      min={1}
                      max={maxQuantity}
                      style={{ width: '100px' }}
                    />
                    <button 
                      className="btn btn-outline-custom"
                      onClick={() => setQuantity(Math.min(maxQuantity, quantity + 1))}
                      disabled={quantity >= maxQuantity}
                    >
                      +1
                    </button>
                    <button 
                      className="btn btn-outline-custom"
                      onClick={() => setQuantity(Math.min(maxQuantity, quantity + 10))}
                      disabled={quantity >= maxQuantity}
                    >
                      +10
                    </button>
                    <button 
                      className="btn btn-outline-custom"
                      onClick={() => setQuantity(maxQuantity)}
                      disabled={quantity >= maxQuantity}
                    >
                      All ({maxQuantity})
                    </button>
                  </div>
                  <small className="text-muted-custom mt-1 d-block">
                    Maximum {maxQuantity} SIMs available in this box
                  </small>
                </div>

                {/* Purpose */}
                <div className="mb-3">
                  <label className="form-label">Purpose (Optional)</label>
                  <input
                    type="text"
                    className="form-control form-control-custom"
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    placeholder="e.g., Stock replenishment, New agent"
                  />
                </div>

                {/* Summary */}
                <div className="alert alert-custom bg-dark-custom border-secondary">
                  <h6 className="mb-2">Distribution Summary</h6>
                  <div className="row">
                    <div className="col-6">
                      <small className="text-muted-custom">Distributor:</small>
                      <div className="fw-bold">{distributor.name}</div>
                    </div>
                    <div className="col-6">
                      <small className="text-muted-custom">Source Box:</small>
                      <div className="fw-bold">{selectedBox.mvno} - Box {selectedBox.box_display || selectedBox.box_number}</div>
                    </div>
                  </div>
                  <div className="row mt-2">
                    <div className="col-6">
                      <small className="text-muted-custom">SIMs to Distribute:</small>
                      <div className="fw-bold text-success">{quantity}</div>
                    </div>
                    <div className="col-6">
                      <small className="text-muted-custom">Remaining After:</small>
                      <div className="fw-bold">{maxQuantity - quantity}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button 
              type="button" 
              className="btn btn-outline-custom" 
              onClick={selectedBox ? () => setSelectedBox(null) : onCancel}
            >
              {selectedBox ? 'Back' : 'Cancel'}
            </button>
            {selectedBox && (
              <button 
                className="btn btn-accent" 
                onClick={handlePick}
                disabled={loading || quantity < 1 || quantity > maxQuantity}
              >
                {loading ? (
                  <>
                    <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
                    Processing...
                  </>
                ) : (
                  <>
                    <i className="bi bi-check-circle me-2"></i>
                    Distribute {quantity} SIM{quantity > 1 ? 's' : ''}
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
