import { useMemo, useState } from 'react';
import { PageWrapper } from '../components/layout/PageWrapper';
import { StatusBadge, SimTypeBadge } from '../components/ui/StatusBadge';
import { useSimRequests } from '../hooks/useSimRequests';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import type { SimRequest } from '../types';

const TABS: { label: string; value: string }[] = [
  { label: 'All',       value: '' },
  { label: 'Pending',   value: 'PENDING' },
  { label: 'Approved',  value: 'APPROVED' },
  { label: 'Rejected',  value: 'REJECTED' },
  { label: 'Escalated', value: 'ESCALATED' },
  { label: 'Completed', value: 'COMPLETED' },
];

function fmt(n: number) { return n.toLocaleString(); }

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-UG', { day: '2-digit', month: 'short', year: 'numeric' });
}

function ResponseTime({ mins }: { mins: number | null }) {
  if (mins === null) return <span className="text-xs text-gray-400">—</span>;
  const color = mins < 30 ? '#10B981' : mins < 60 ? '#F59E0B' : '#EF4444';
  const label = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return <span className="text-xs font-semibold" style={{ color }}>{label}</span>;
}

export function StockRequests() {
  const [page, setPage]       = useState(1);
  const LIMIT = 25;

  const [tab, setTab]         = useState('');
  const [searchInput, setSearchInput]   = useState('');
  const [simType, setSimType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]   = useState('');

  const search = useDebouncedValue(searchInput, 400);
  const params = useMemo(() => ({
    status: tab || undefined,
    search: search || undefined,
    sim_type: simType || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    page,
    limit: LIMIT,
  }), [tab, search, simType, dateFrom, dateTo, page]);

  const { data, isLoading, error } = useSimRequests(params);

  const rows: SimRequest[] = data?.rows || [];
  const total: number = data?.total || 0;

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  const exportCsv = () => {
    if (!rows.length) return;
    const headers = ['Request ID', 'Distributor', 'Contact', 'SIM Type', 'Quantity', 'Status', 'Date', 'Response Time'];
    const lines = rows.map((r) => [
      r.request_ref || r.id,
      r.distributor_name,
      r.contact_person || '',
      r.sim_type,
      r.quantity,
      r.status,
      fmtDate(r.created_at),
      r.response_minutes !== null ? `${r.response_minutes}m` : '',
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = [headers.join(','), ...lines].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'sim-requests.csv';
    a.click();
  };

  return (
    <PageWrapper title="PAXTEL ADMIN DASHBOARD (MVNO ADMIN)" subtitle="Stock Requests — all incoming requests from distributors">
      {/* ── Tabs ── */}
      <div className="flex gap-1 mb-4 bg-white rounded-card shadow-sm border border-gray-100 p-1 w-fit" style={{ borderRadius: 10 }}>
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => { setTab(t.value); setPage(1); }}
            className="px-4 py-1.5 rounded-btn text-sm font-medium transition-colors"
            style={tab === t.value
              ? { background: '#10B981', color: '#fff', borderRadius: 6 }
              : { color: '#6B7280' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Filters ── */}
      <div className="bg-white rounded-card shadow-sm border border-gray-100 p-4 mb-4 flex flex-wrap gap-3 items-end" style={{ borderRadius: 10 }}>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-semibold text-gray-500 mb-1">Search</label>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => { setSearchInput(e.target.value); setPage(1); }}
            placeholder="Request ID or distributor…"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-btn focus:outline-none"
            style={{ borderRadius: 6 }}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">SIM Type</label>
          <select
            value={simType}
            onChange={(e) => { setSimType(e.target.value); setPage(1); }}
            className="px-3 py-2 text-sm border border-gray-200 rounded-btn focus:outline-none"
            style={{ borderRadius: 6 }}
          >
            <option value="">All types</option>
            <option value="PHYSICAL">Physical</option>
            <option value="ESIM">eSIM</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">From</label>
          <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            className="px-3 py-2 text-sm border border-gray-200 rounded-btn focus:outline-none" style={{ borderRadius: 6 }} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">To</label>
          <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            className="px-3 py-2 text-sm border border-gray-200 rounded-btn focus:outline-none" style={{ borderRadius: 6 }} />
        </div>
        <button
          onClick={exportCsv}
          className="px-4 py-2 text-sm font-semibold rounded-btn border transition-colors"
          style={{ borderColor: '#10B981', color: '#10B981', borderRadius: 6 }}
        >
          ↓ Export CSV
        </button>
      </div>

      {error && <div className="mb-4 px-4 py-3 rounded-btn text-sm text-red-700 bg-red-50 border border-red-200">{(error as any)?.message || 'Failed to load requests'}</div>}

      {/* ── Table ── */}
      <div className="bg-white rounded-card shadow-sm border border-gray-100 overflow-hidden" style={{ borderRadius: 10 }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
                <th className="text-left px-5 py-3">Request ID</th>
                <th className="text-left px-4 py-3">Distributor</th>
                <th className="text-left px-4 py-3">Contact</th>
                <th className="text-left px-4 py-3">SIM Type</th>
                <th className="text-right px-4 py-3">Qty</th>
                <th className="text-left px-4 py-3">Date</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Response</th>
                <th className="text-left px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading && (
                <tr><td colSpan={9} className="px-5 py-8 text-center text-gray-400">Loading…</td></tr>
              )}
              {!isLoading && rows.length === 0 && (
                <tr><td colSpan={9} className="px-5 py-8 text-center text-gray-400">No requests found for current filters.</td></tr>
              )}
              {!isLoading && rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50/50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-gray-500">{r.request_ref || r.id.slice(0, 8)}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{r.distributor_name}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{r.contact_person || '—'}</td>
                  <td className="px-4 py-3"><SimTypeBadge type={r.sim_type} /></td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">{fmt(r.quantity)}</td>
                  <td className="px-4 py-3 text-xs text-gray-400">{fmtDate(r.created_at)}</td>
                  <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-3"><ResponseTime mins={r.response_minutes} /></td>
                  <td className="px-4 py-3">
                    <a
                      href={`/approve?id=${r.id}`}
                      className="text-xs font-medium px-2.5 py-1 rounded"
                      style={{ background: '#D1FAE5', color: '#065F46' }}
                    >
                      View
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
          <span className="text-xs text-gray-500">
            Showing {rows.length > 0 ? (page - 1) * LIMIT + 1 : 0}–{Math.min(page * LIMIT, total)} of {fmt(total)} requests
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1 text-xs font-medium rounded border border-gray-200 disabled:opacity-40"
            >
              ← Prev
            </button>
            <span className="px-3 py-1 text-xs text-gray-600">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1 text-xs font-medium rounded border border-gray-200 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      </div>
    </PageWrapper>
  );
}
