import { useState } from 'react';
import type { DistributorPickHistory, Distributor } from '../types/simcard';
import { useExport, ExportFilters } from '../hooks/useExport';

interface DistributorHistoryProps {
  history: DistributorPickHistory[];
  loading: boolean;
  distributors?: Distributor[];
  onUpdate?: (recordId: string, updates: { sims_picked?: number; iccid_start?: string; iccid_end?: string; distributor_id?: string }) => Promise<{ success: boolean; message: string }>;
  onRefresh?: () => void;
}

export function DistributorHistory({ history, loading, distributors = [], onUpdate, onRefresh }: DistributorHistoryProps) {
  const { exporting, exportData, downloadBlob, canExport, setUserRole, getUserInfo } = useExport();
  
  const [editingRecord, setEditingRecord] = useState<DistributorPickHistory | null>(null);
  const [editForm, setEditForm] = useState({
    sims_picked: 0,
    iccid_start: '',
    iccid_end: '',
    distributor_id: ''
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  
  // Export state
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [exportFilters, setExportFilters] = useState<ExportFilters>({});
  const [exportMessage, setExportMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showRoleSelector, setShowRoleSelector] = useState(false);
  const [selectedRole, setSelectedRole] = useState(getUserInfo().role);
  
  // Handle role change
  const handleRoleChange = (role: string) => {
    setSelectedRole(role);
    setUserRole(role, `${role.toLowerCase()}@example.com`, '');
    setShowRoleSelector(false);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatIccid = (iccid: string) => {
    if (!iccid) return '-';
    return iccid;
  };

  const handleEdit = (record: DistributorPickHistory) => {
    setEditingRecord(record);
    setEditForm({
      sims_picked: record.sims_picked,
      iccid_start: record.iccid_start || '',
      iccid_end: record.iccid_end || '',
      distributor_id: ''
    });
    setSaveError(null);
  };

  const handleSave = async () => {
    if (!editingRecord?.id || !onUpdate) return;
    
    setSaving(true);
    setSaveError(null);
    
    try {
      // Only include distributor_id if it has a valid value (non-empty string)
      const updateData: {
        sims_picked: number;
        iccid_start: string;
        iccid_end: string;
        distributor_id?: string;
      } = {
        sims_picked: editForm.sims_picked,
        iccid_start: editForm.iccid_start,
        iccid_end: editForm.iccid_end
      };
      
      // Only add distributor_id if it's not empty
      if (editForm.distributor_id && editForm.distributor_id.trim() !== '') {
        updateData.distributor_id = editForm.distributor_id;
      }
      
      const result = await onUpdate(editingRecord.id, updateData);
      if (result.success) {
        setEditingRecord(null);
        onRefresh?.();
      } else {
        setSaveError(result.message);
      }
    } catch (err) {
      setSaveError('Failed to update record');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditingRecord(null);
    setSaveError(null);
  };

  if (loading) {
    return (
      <div className="text-center py-5">
        <div className="spinner-border spinner-custom" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
        <p className="mt-2 text-muted-custom">Loading history...</p>
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="card card-custom">
        <div className="card-body text-center py-5">
          <i className="bi bi-clock-history fs-1 text-muted-custom"></i>
          <h5 className="mt-3">No Distribution History</h5>
          <p className="text-muted-custom">
            Distributions will appear here once you start distributing SIM cards to distributors.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="row">
        <div className="col-12">
          <div className="card card-custom mb-3">
            {/* Export Panel */}
            {showExportPanel && (
              <div className="card-body bg-dark-custom border-bottom">
                <h6 className="mb-3"><i className="bi bi-funnel me-2"></i>Export Filters</h6>
                <div className="row g-3">
                  <div className="col-md-3">
                    <label className="form-label">MVNO</label>
                    <select 
                      className="form-select"
                      value={exportFilters.mvno_id || ''}
                      onChange={(e) => setExportFilters({ ...exportFilters, mvno_id: e.target.value || undefined })}
                    >
                      <option value="">All MVNOs</option>
                      <option value="PAXTEL">PAXTEL</option>
                      <option value="SALAMTEL">SALAMTEL</option>
                      <option value="AGROTEL">AGROTEL</option>
                    </select>
                  </div>
                  <div className="col-md-3">
                    <label className="form-label">Distributor</label>
                    <select 
                      className="form-select"
                      value={exportFilters.distributor_id || ''}
                      onChange={(e) => setExportFilters({ ...exportFilters, distributor_id: e.target.value || undefined })}
                    >
                      <option value="">All Distributors</option>
                      {distributors.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-md-2">
                    <label className="form-label">Date From</label>
                    <input 
                      type="date" 
                      className="form-control"
                      value={exportFilters.date_from || ''}
                      onChange={(e) => setExportFilters({ ...exportFilters, date_from: e.target.value || undefined })}
                    />
                  </div>
                  <div className="col-md-2">
                    <label className="form-label">Date To</label>
                    <input 
                      type="date" 
                      className="form-control"
                      value={exportFilters.date_to || ''}
                      onChange={(e) => setExportFilters({ ...exportFilters, date_to: e.target.value || undefined })}
                    />
                  </div>
                  <div className="col-md-2 d-flex align-items-end gap-2">
                    <button 
                      className="btn btn-success"
                      onClick={async () => {
                        const result = await exportData(exportFilters, { format: 'csv' });
                        if (result.success && result.blob) {
                          downloadBlob(result.blob, `distribution_export_${new Date().toISOString().split('T')[0]}.csv`);
                          setExportMessage({ type: 'success', text: result.message });
                        } else {
                          setExportMessage({ type: 'error', text: result.message });
                        }
                      }}
                      disabled={exporting || !canExport()}
                    >
                      <i className="bi bi-file-earmark-spreadsheet me-1"></i> CSV
                    </button>
                    <button 
                      className="btn btn-success"
                      onClick={async () => {
                        const result = await exportData(exportFilters, { format: 'excel' });
                        if (result.success && result.blob) {
                          downloadBlob(result.blob, `distribution_export_${new Date().toISOString().split('T')[0]}.xls`);
                          setExportMessage({ type: 'success', text: result.message });
                        } else {
                          setExportMessage({ type: 'error', text: result.message });
                        }
                      }}
                      disabled={exporting || !canExport()}
                    >
                      <i className="bi bi-file-earmark-excel me-1"></i> Excel
                    </button>
                  </div>
                </div>
                {exportMessage && (
                  <div className={`alert mt-2 py-2 ${exportMessage.type === 'success' ? 'alert-success' : 'alert-danger'}`}>
                    {exportMessage.text}
                  </div>
                )}
                {!canExport() && (
                  <div className="alert alert-warning mt-2 py-2">
                    <i className="bi bi-exclamation-triangle me-2"></i>
                    Export is only available for Admin and Management roles.
                    <button 
                      className="btn btn-sm btn-link ms-2"
                      onClick={() => setShowRoleSelector(!showRoleSelector)}
                    >
                      Change Role
                    </button>
                  </div>
                )}
                {showRoleSelector && (
                  <div className="mt-2 p-2 border rounded">
                    <label className="form-label">Select Role (Demo)</label>
                    <select 
                      className="form-select"
                      value={selectedRole}
                      onChange={(e) => handleRoleChange(e.target.value)}
                    >
                      <option value="EMPLOYEE">Employee</option>
                      <option value="AGENT">Agent</option>
                      <option value="DISTRIBUTOR">Distributor</option>
                      <option value="MANAGEMENT">Management</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  </div>
                )}
              </div>
            )}
            {/* Header */}
            <div className="card-header card-header-custom d-flex justify-content-between align-items-center">
              <h5 className="mb-0">
                <i className="bi bi-clock-history me-2"></i>
                Distribution History
              </h5>
              <div className="d-flex gap-2 align-items-center">
                <button 
                  className={`btn btn-sm ${showExportPanel ? 'btn-accent' : 'btn-outline-secondary'}`}
                  onClick={() => setShowExportPanel(!showExportPanel)}
                >
                  <i className="bi bi-download me-1"></i> Export
                </button>
                <span className="badge bg-secondary">{history.length} records</span>
              </div>
            </div>
            <div className="card-body p-0">
              <div className="table-responsive">
                <table className="table table-custom table-hover mb-0">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Distributor</th>
                      <th>Type</th>
                      <th>MVNO</th>
                      <th>Carton</th>
                      <th>Box</th>
                      <th>SIMs Picked</th>
                      <th>ICCID Range</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((item, idx) => (
                      <tr key={`${item.pick_date}-${idx}`}>
                        <td>
                          <small>{formatDate(item.pick_date)}</small>
                        </td>
                        <td>
                          <div className="fw-bold">{item.distributor_name}</div>
                        </td>
                        <td>
                          <span className={`badge badge-${(item.distributor_type || 'other').toLowerCase().replace('_', '-')}`}>
                            {(item.distributor_type || 'Unknown').replace('_', ' ')}
                          </span>
                        </td>
                        <td>
                          <span className="badge bg-primary">{item.mvno}</span>
                        </td>
                        <td className="mono">{item.carton_number}</td>
                        <td className="fw-bold">{item.box_display || item.box_number}</td>
                        <td>
                          <span className="badge bg-success">{item.sims_picked}</span>
                        </td>
                        <td className="mono">
                          <small>
                            {formatIccid(item.iccid_start)} - {formatIccid(item.iccid_end)}
                          </small>
                        </td>
                        <td>
                          {item.id && onUpdate && (
                            <button
                              className="btn btn-sm btn-outline-primary"
                              onClick={() => handleEdit(item)}
                              title="Edit record"
                            >
                              <i className="bi bi-pencil"></i>
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
        </div>
      </div>

      {/* Edit Modal */}
      {editingRecord && (
        <div className="modal show d-block" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content card-custom">
              <div className="modal-header card-header-custom">
                <h5 className="modal-title">
                  <i className="bi bi-pencil-square me-2"></i>
                  Edit Distribution Record
                </h5>
                <button type="button" className="btn-close btn-close-white" onClick={handleCancel}></button>
              </div>
              <div className="modal-body">
                <div className="mb-3">
                  <label className="form-label">Distributor</label>
                  <select
                    className="form-select"
                    value={editForm.distributor_id}
                    onChange={(e) => setEditForm({ ...editForm, distributor_id: e.target.value })}
                  >
                    <option value="">{editingRecord.distributor_name}</option>
                    {distributors.map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
                <div className="mb-3">
                  <label className="form-label">SIMs Picked</label>
                  <input
                    type="number"
                    className="form-control"
                    value={editForm.sims_picked}
                    onChange={(e) => setEditForm({ ...editForm, sims_picked: parseInt(e.target.value) || 0 })}
                    min="1"
                  />
                </div>
                <div className="mb-3">
                  <label className="form-label">ICCID Start</label>
                  <input
                    type="text"
                    className="form-control"
                    value={editForm.iccid_start}
                    onChange={(e) => setEditForm({ ...editForm, iccid_start: e.target.value })}
                    placeholder="Enter ICCID start"
                  />
                </div>
                <div className="mb-3">
                  <label className="form-label">ICCID End</label>
                  <input
                    type="text"
                    className="form-control"
                    value={editForm.iccid_end}
                    onChange={(e) => setEditForm({ ...editForm, iccid_end: e.target.value })}
                    placeholder="Enter ICCID end"
                  />
                </div>
                {saveError && (
                  <div className="alert alert-danger py-2">{saveError}</div>
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={handleCancel}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? (
                    <>
                      <span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>
                      Saving...
                    </>
                  ) : (
                    'Save Changes'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
