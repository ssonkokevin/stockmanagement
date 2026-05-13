import { useMemo, useState } from 'react';
import { PageWrapper } from '../components/layout/PageWrapper';
import { StatusBadge, SimTypeBadge } from '../components/ui/StatusBadge';
import { useSimRequests } from '../hooks/useSimRequests';
import { useApproveRequest } from '../hooks/useApproveRequest';
import { useRejectRequest } from '../hooks/useRejectRequest';
import type { SimRequest } from '../types';

function fmt(n: number) { return n.toLocaleString(); }
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-UG', { day: '2-digit', month: 'short', year: 'numeric' });
}

interface ModalState {
  type: 'approve' | 'reject';
  request: SimRequest;
}

export function ApproveRequests() {
  const [modal, setModal]     = useState<ModalState | null>(null);
  const [notes, setNotes]     = useState('');
  const [reason, setReason]   = useState('');
  const approve = useApproveRequest();
  const reject = useRejectRequest();

  const params = useMemo(() => ({ status: 'PENDING,ESCALATED', page: 1, limit: 200 }), []);
  const { data, isLoading, error, refetch } = useSimRequests(params);
  const rows: SimRequest[] = data?.rows || [];

  const escalatedCount = rows.filter((r) => r.status === 'ESCALATED').length;

  const handleApprove = async () => {
    if (!modal) return;
    approve.mutate(
      { id: modal.request.id, notes: notes || undefined },
      {
        onSuccess: () => {
          setModal(null);
          setNotes('');
        },
      }
    );
  };

  const handleReject = async () => {
    if (!modal || !reason.trim()) return;
    reject.mutate(
      { id: modal.request.id, reason },
      {
        onSuccess: () => {
          setModal(null);
          setReason('');
        },
      }
    );
  };

  return (
    <PageWrapper title="PAXTEL ADMIN DASHBOARD (MVNO ADMIN)" subtitle="Approve Requests — pending and escalated requests needing action">
      {/* Escalation alert banner */}
      {escalatedCount > 0 && (
        <div className="mb-4 px-4 py-3 rounded-card border flex items-start gap-3"
          style={{ background: '#FFF7ED', borderColor: '#FED7AA', borderRadius: 10 }}>
          <span className="text-lg">🔴</span>
          <p className="text-sm text-orange-800">
            <strong>{escalatedCount} request{escalatedCount > 1 ? 's' : ''} escalated to Super Admin</strong> — these exceeded the 1-hour response window and have been flagged for Super Admin review.
          </p>
        </div>
      )}

      {error && <div className="mb-4 px-4 py-3 rounded-btn text-sm text-red-700 bg-red-50 border border-red-200">{(error as any)?.message || 'Failed to load requests'}</div>}

      {/* Table */}
      <div className="bg-white rounded-card shadow-sm border border-gray-100 overflow-hidden" style={{ borderRadius: 10 }}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">
            Pending & Escalated Requests
            <span className="ml-2 text-xs font-normal text-gray-400">({rows.length} total)</span>
          </h2>
          <button onClick={() => refetch()} className="text-xs font-medium px-3 py-1.5 rounded border border-gray-200 hover:bg-gray-50">
            ↻ Refresh
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
                <th className="text-left px-5 py-3">Request ID</th>
                <th className="text-left px-4 py-3">Distributor</th>
                <th className="text-left px-4 py-3">Contact</th>
                <th className="text-left px-4 py-3">SIM Type</th>
                <th className="text-right px-4 py-3">Qty</th>
                <th className="text-left px-4 py-3">Requested</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading && (
                <tr><td colSpan={8} className="px-5 py-8 text-center text-gray-400">Loading…</td></tr>
              )}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center">
                    <div className="text-3xl mb-2">✅</div>
                    <div className="font-medium text-gray-700">All clear!</div>
                    <div className="text-sm text-gray-400 mt-1">No pending or escalated requests.</div>
                  </td>
                </tr>
              )}
              {!isLoading && rows.map((r) => (
                <tr key={r.id} className={`hover:bg-gray-50/50 transition-colors ${r.status === 'ESCALATED' ? 'bg-orange-50/30' : ''}`}>
                  <td className="px-5 py-3 font-mono text-xs text-gray-500">{r.request_ref || r.id.slice(0, 8)}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{r.distributor_name}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{r.contact_person || '—'}</td>
                  <td className="px-4 py-3"><SimTypeBadge type={r.sim_type} /></td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">{fmt(r.quantity)}</td>
                  <td className="px-4 py-3 text-xs text-gray-400">{fmtDate(r.created_at)}</td>
                  <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setModal({ type: 'approve', request: r }); setNotes(''); }}
                        className="text-xs font-semibold px-3 py-1.5 rounded-btn text-white transition-opacity hover:opacity-90"
                        style={{ background: '#10B981', borderRadius: 6 }}
                      >
                        ✓ Approve
                      </button>
                      <button
                        onClick={() => { setModal({ type: 'reject', request: r }); setReason(''); }}
                        className="text-xs font-semibold px-3 py-1.5 rounded-btn border transition-colors hover:bg-red-50"
                        style={{ borderColor: '#EF4444', color: '#EF4444', borderRadius: 6 }}
                      >
                        ✗ Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Approve / Reject Modal */}
      {modal && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setModal(null)}
        >
          <div
            className="bg-white rounded-card shadow-2xl w-full max-w-md mx-4 p-6"
            style={{ borderRadius: 10 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-bold text-gray-900 text-lg mb-1">
              {modal.type === 'approve' ? '✓ Confirm Approval' : '✗ Confirm Rejection'}
            </h3>
            <p className="text-sm text-gray-500 mb-5">
              {modal.type === 'approve'
                ? 'Review the request details before approving.'
                : 'Provide a reason for rejecting this request.'}
            </p>

            {/* Request summary */}
            <div className="bg-gray-50 rounded-btn p-4 mb-4 space-y-2" style={{ borderRadius: 8 }}>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Distributor</span>
                <span className="font-medium text-gray-800">{modal.request.distributor_name}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">SIM Type</span>
                <SimTypeBadge type={modal.request.sim_type} />
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Quantity</span>
                <span className="font-bold text-gray-900">{fmt(modal.request.quantity)}</span>
              </div>
              {modal.request.notes && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Notes</span>
                  <span className="text-gray-700 max-w-[200px] text-right">{modal.request.notes}</span>
                </div>
              )}
            </div>

            {modal.type === 'approve' ? (
              <div className="mb-5">
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Notes (optional)</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Any notes for the distributor…"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-btn resize-none focus:outline-none"
                  style={{ borderRadius: 6 }}
                />
              </div>
            ) : (
              <div className="mb-5">
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Rejection reason <span className="text-red-500">*</span></label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="Explain why this request is being rejected…"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-btn resize-none focus:outline-none"
                  style={{ borderRadius: 6 }}
                  required
                />
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={modal.type === 'approve' ? handleApprove : handleReject}
                disabled={approve.isPending || reject.isPending || (modal.type === 'reject' && !reason.trim())}
                className="flex-1 py-2.5 text-sm font-semibold text-white rounded-btn transition-opacity disabled:opacity-50"
                style={{
                  background: modal.type === 'approve' ? '#10B981' : '#EF4444',
                  borderRadius: 6,
                }}
              >
                {(approve.isPending || reject.isPending) ? 'Processing…' : modal.type === 'approve' ? 'Confirm Approval' : 'Confirm Rejection'}
              </button>
              <button
                onClick={() => setModal(null)}
                className="px-4 py-2.5 text-sm font-medium text-gray-600 rounded-btn border border-gray-200 hover:bg-gray-50"
                style={{ borderRadius: 6 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </PageWrapper>
  );
}
