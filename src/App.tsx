import { useState, useMemo } from 'react';
import { useSimcards } from './hooks/useSimcards';
import { SimcardForm } from './components/SimcardForm';
import { SimcardTable } from './components/SimcardTable';
import { SearchFilterBar } from './components/SearchFilterBar';
import { BulkImportModal } from './components/BulkImportModal';
import type { Simcard, SimcardInsert, SimcardStatus } from './types/simcard';
import './App.css';

function App() {
  const { simcards, loading, error, addSimcard, updateSimcard, deleteSimcard, bulkAddSimcards } = useSimcards();
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState<Simcard | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Simcard | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<SimcardStatus | ''>('');
  const [carrierFilter, setCarrierFilter] = useState('');

  const filteredSimcards = useMemo(() => {
    let list = simcards;
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) =>
          s.iccid.toLowerCase().includes(q) ||
          (s.phone_number?.toLowerCase().includes(q) ?? false)
      );
    }
    if (statusFilter) list = list.filter((s) => s.status === statusFilter);
    if (carrierFilter) list = list.filter((s) => s.carrier === carrierFilter);
    return list;
  }, [simcards, search, statusFilter, carrierFilter]);

  const carriers = useMemo(() => {
    const set = new Set<string>();
    simcards.forEach((s) => {
      if (s.carrier?.trim()) set.add(s.carrier.trim());
    });
    return Array.from(set).sort();
  }, [simcards]);

  const handleAdd = async (data: SimcardInsert) => {
    await addSimcard(data);
    setShowForm(false);
  };

  const handleUpdate = async (data: SimcardInsert) => {
    if (!editing) return;
    await updateSimcard(editing.id, {
      phone_number: data.phone_number,
      carrier: data.carrier,
      status: data.status,
      notes: data.notes,
    });
    setEditing(null);
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await deleteSimcard(deleteConfirm.id);
    setDeleteConfirm(null);
  };

  const handleBulkImport = async (rows: SimcardInsert[]) => {
    await bulkAddSimcards(rows);
    setShowImport(false);
  };

  const handleExportCsv = () => {
    const headers = ['ICCID', 'Phone', 'Carrier', 'Status', 'Notes', 'Created At'];
    const rows = filteredSimcards.map((s) =>
      [
        s.iccid,
        s.phone_number ?? '',
        s.carrier ?? '',
        s.status,
        s.notes ?? '',
        s.created_at,
      ].map((c) => (String(c).includes(',') ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `simcards-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const stats = useMemo(() => ({
    total: simcards.length,
    available: simcards.filter((s) => s.status === 'available').length,
    assigned: simcards.filter((s) => s.status === 'assigned').length,
    activated: simcards.filter((s) => s.status === 'activated').length,
    deactivated: simcards.filter((s) => s.status === 'deactivated').length,
  }), [simcards]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <h1>SIM Card Stock</h1>
          <p className="subtitle">Manage your SIM card inventory</p>
        </div>
      </header>

      <main className="app-main">
        <div className="dashboard">
          <div className="stats-bar">
            <div className="stat">
              <span className="stat-value">{stats.total}</span>
              <span className="stat-label">Total</span>
            </div>
            <div className="stat stat-success">
              <span className="stat-value">{stats.available}</span>
              <span className="stat-label">Available</span>
            </div>
            <div className="stat">
              <span className="stat-value">{stats.assigned}</span>
              <span className="stat-label">Assigned</span>
            </div>
            <div className="stat">
              <span className="stat-value">{stats.activated}</span>
              <span className="stat-label">Activated</span>
            </div>
            <div className="stat">
              <span className="stat-value">{stats.deactivated}</span>
              <span className="stat-label">Deactivated</span>
            </div>
            <div className="stats-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => setShowImport(true)}>
                Import
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleExportCsv}
                disabled={filteredSimcards.length === 0}
              >
                Export CSV
              </button>
              <button className="btn btn-primary" onClick={() => setShowForm(true)}>
                + Add SIM Card
              </button>
            </div>
          </div>

          <SearchFilterBar
            search={search}
            onSearchChange={setSearch}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            carrierFilter={carrierFilter}
            onCarrierFilterChange={setCarrierFilter}
            carriers={carriers}
          />

          {error && (
            <div className="error-banner">
              {error}
              <span className="hint">Check your Supabase connection and env vars.</span>
            </div>
          )}

          {loading ? (
            <div className="loading">Loading stock...</div>
          ) : (
            <SimcardTable
              simcards={filteredSimcards}
              onEdit={setEditing}
              onDelete={setDeleteConfirm}
              onStatusChange={(sim, status) => updateSimcard(sim.id, { status })}
            />
          )}
        </div>

        {(showForm || editing) && (
          <div className="modal-overlay" onClick={() => !editing && setShowForm(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <SimcardForm
                initial={editing}
                onSubmit={editing ? handleUpdate : handleAdd}
                onCancel={() => {
                  setShowForm(false);
                  setEditing(null);
                }}
              />
            </div>
          </div>
        )}

        {showImport && (
          <div className="modal-overlay" onClick={() => setShowImport(false)}>
            <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
              <BulkImportModal
                onImport={handleBulkImport}
                onCancel={() => setShowImport(false)}
              />
            </div>
          </div>
        )}

        {deleteConfirm && (
          <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
            <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
              <h3>Delete SIM Card?</h3>
              <p className="mono">{deleteConfirm.iccid}</p>
              <p className="text-secondary">This cannot be undone.</p>
              <div className="form-actions">
                <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>
                  Cancel
                </button>
                <button className="btn btn-danger" onClick={handleDelete}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
