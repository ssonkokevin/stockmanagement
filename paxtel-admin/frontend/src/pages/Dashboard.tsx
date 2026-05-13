import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { PageWrapper } from '../components/layout/PageWrapper';
import { MetricCard } from '../components/ui/MetricCard';
import { StatusBadge, SimTypeBadge } from '../components/ui/StatusBadge';
import { Skeleton } from '../components/ui/Skeleton';
import { ErrorState } from '../components/ui/ErrorState';
import { useDashboardStats } from '../hooks/useDashboardStats';
import { useAppStore } from '../store/useAppStore';
import type { SimRequest } from '../types';

const PIE_COLORS: Record<string, string> = {
  pending:   '#F59E0B',
  approved:  '#10B981',
  rejected:  '#EF4444',
  escalated: '#F97316',
  completed: '#9CA3AF',
};

function fmt(n: number) { return n.toLocaleString(); }

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-UG', { day: '2-digit', month: 'short', year: 'numeric' });
}

function responseColor(mins: number | null) {
  if (mins === null) return '#9CA3AF';
  if (mins < 30) return '#10B981';
  if (mins < 60) return '#F59E0B';
  return '#EF4444';
}

export function Dashboard() {
  const user = useAppStore((s) => s.currentUser);
  const { data: stats, isLoading, error } = useDashboardStats();

  const greeting = `Welcome, ${user?.name?.split(' ')[0] || 'Paxtel Admin'} 👋`;

  const pieData = stats ? [
    { name: 'Pending',   value: stats.requests_overview.pending   },
    { name: 'Approved',  value: stats.requests_overview.approved  },
    { name: 'Rejected',  value: stats.requests_overview.rejected  },
    { name: 'Escalated', value: stats.requests_overview.escalated },
    { name: 'Completed', value: stats.requests_overview.completed },
  ] : [];

  const physPct = stats
    ? Math.round((stats.distributed_physical / (stats.total_physical_stock || 1)) * 100)
    : 0;
  const esimPct = stats
    ? Math.round((stats.distributed_esim / (stats.total_esim_stock || 1)) * 100)
    : 0;

  return (
    <PageWrapper
      title="PAXTEL ADMIN DASHBOARD (MVNO ADMIN)"
      subtitle={`${greeting} — Here's what's happening with your SIM management today.`}
    >
      {isLoading && (
        <>
          <div className="grid grid-cols-5 gap-4 mb-4">
            <Skeleton className="h-[92px]" />
            <Skeleton className="h-[92px]" />
            <Skeleton className="h-[92px]" />
            <Skeleton className="h-[92px]" />
            <Skeleton className="h-[92px]" />
          </div>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <Skeleton className="h-[92px]" />
            <Skeleton className="h-[92px]" />
          </div>
          <div className="grid grid-cols-5 gap-4">
            <Skeleton className="col-span-3 h-[380px]" />
            <div className="col-span-2 flex flex-col gap-4">
              <Skeleton className="h-[250px]" />
              <Skeleton className="h-[190px]" />
              <Skeleton className="h-[120px]" />
            </div>
          </div>
        </>
      )}

      {error && <ErrorState message={(error as any)?.message || 'Failed to load stats'} />}

      {stats && !isLoading && (
        <>
          {/* ── Row 1: Request KPI cards ──────────────────────────────── */}
          <div className="grid grid-cols-5 gap-4 mb-4">
            <MetricCard
              label="Total Requests"
              value={fmt(stats.total_requests)}
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#10B981" strokeWidth={2}><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>}
              iconBg="#D1FAE5"
            />
            <MetricCard
              label="Pending"
              value={fmt(stats.pending_requests)}
              sub="⚠ Awaiting action"
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#F59E0B" strokeWidth={2}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>}
              iconBg="#FEF3C7"
            />
            <MetricCard
              label="Approved Today"
              value={fmt(stats.approved_today)}
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#10B981" strokeWidth={2}><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>}
              iconBg="#D1FAE5"
            />
            <MetricCard
              label="Rejected Today"
              value={fmt(stats.rejected_today)}
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#EF4444" strokeWidth={2}><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>}
              iconBg="#FEE2E2"
            />
            <MetricCard
              label="Escalated to Super Admin"
              value={fmt(stats.escalated_count)}
              sub="🔴 No response > 1 hour"
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#F97316" strokeWidth={2}><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>}
              iconBg="#FFEDD5"
              alert={stats.escalated_count > 0}
            />
          </div>

          {/* ── Row 2: Stock cards ────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <MetricCard
              label="Physical SIM Stock (Paxtel)"
              value={fmt(stats.available_physical_stock)}
              sub={`Distributed: ${fmt(stats.distributed_physical)} · Total: ${fmt(stats.total_physical_stock)}`}
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#10B981" strokeWidth={2}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 3H8L6 7h12l-2-4z"/></svg>}
              iconBg="#D1FAE5"
              progress={{ value: physPct, color: '#10B981' }}
            />
            <MetricCard
              label="eSIM Stock (Paxtel)"
              value={fmt(stats.available_esim_stock)}
              sub={`Activated: ${fmt(stats.distributed_esim)} · Total: ${fmt(stats.total_esim_stock)}`}
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#0D9488" strokeWidth={2}><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>}
              iconBg="#CCFBF1"
              progress={{ value: esimPct, color: '#0D9488' }}
            />
          </div>

          {/* ── Row 3: Table + Charts ─────────────────────────────────── */}
          <div className="grid grid-cols-5 gap-4">
            {/* Recent Requests table — 3/5 width */}
            <div className="col-span-3 bg-white rounded-card shadow-sm border border-gray-100" style={{ borderRadius: 10 }}>
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="font-semibold text-gray-800">Recent SIM Requests</h2>
                <a href="/requests" className="text-xs font-medium" style={{ color: '#10B981' }}>View all →</a>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      <th className="text-left px-5 py-3">Request ID</th>
                      <th className="text-left px-4 py-3">Distributor</th>
                      <th className="text-left px-4 py-3">Type</th>
                      <th className="text-right px-4 py-3">Qty</th>
                      <th className="text-left px-4 py-3">Status</th>
                      <th className="text-left px-4 py-3">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {stats.recent_requests.map((r: SimRequest) => (
                      <tr key={r.id} className="hover:bg-gray-50/50 transition-colors">
                        <td className="px-5 py-3 font-mono text-xs text-gray-500">{r.request_ref || r.id.slice(0, 8)}</td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-800">{r.distributor_name}</div>
                          {r.contact_person && <div className="text-xs text-gray-400">{r.contact_person}</div>}
                        </td>
                        <td className="px-4 py-3"><SimTypeBadge type={r.sim_type} /></td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-800">{fmt(r.quantity)}</td>
                        <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                        <td className="px-4 py-3 text-xs text-gray-400">{fmtDate(r.created_at)}</td>
                      </tr>
                    ))}
                    {stats.recent_requests.length === 0 && (
                      <tr><td colSpan={6} className="px-5 py-8 text-center text-gray-400 text-sm">No recent requests</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Charts — 2/5 width */}
            <div className="col-span-2 flex flex-col gap-4">
              {/* Donut chart */}
              <div className="bg-white rounded-card shadow-sm border border-gray-100 p-5" style={{ borderRadius: 10 }}>
                <h3 className="font-semibold text-gray-800 mb-4">Requests Overview</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {pieData.map((entry) => (
                        <Cell key={entry.name} fill={PIE_COLORS[entry.name.toLowerCase()] || '#9CA3AF'} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: number) => [fmt(v), '']} />
                  </PieChart>
                </ResponsiveContainer>
                {/* Legend */}
                <div className="grid grid-cols-2 gap-1 mt-2">
                  {pieData.map((entry) => (
                    <div key={entry.name} className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{ background: PIE_COLORS[entry.name.toLowerCase()] }} />
                      <span className="text-xs text-gray-600">{entry.name}</span>
                      <span className="text-xs font-semibold text-gray-800 ml-auto">
                        {stats.requests_overview.total > 0
                          ? Math.round((entry.value / stats.requests_overview.total) * 100)
                          : 0}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Trend line chart */}
              <div className="bg-white rounded-card shadow-sm border border-gray-100 p-5" style={{ borderRadius: 10 }}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-gray-800">Request Trend</h3>
                  <span className="text-xs text-gray-400">Last 7 days</span>
                </div>
                <ResponsiveContainer width="100%" height={140}>
                  <LineChart data={stats.distribution_trend} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9CA3AF' }} />
                    <YAxis tick={{ fontSize: 10, fill: '#9CA3AF' }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="physical" stroke="#10B981" strokeWidth={2} dot={false} name="Physical" />
                    <Line type="monotone" dataKey="esim" stroke="#0D9488" strokeWidth={2} strokeDasharray="4 2" dot={false} name="eSIM" />
                  </LineChart>
                </ResponsiveContainer>
                <div className="flex gap-4 mt-2">
                  <span className="flex items-center gap-1 text-xs text-gray-500">
                    <span className="w-3 h-0.5 bg-green-500 inline-block rounded" />Physical
                  </span>
                  <span className="flex items-center gap-1 text-xs text-gray-500">
                    <span className="w-3 h-0.5 inline-block rounded" style={{ background: '#0D9488' }} />eSIM
                  </span>
                </div>
              </div>

              {/* Response time legend */}
              <div className="bg-white rounded-card shadow-sm border border-gray-100 p-4" style={{ borderRadius: 10 }}>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Response Time Guide</h3>
                {[
                  { label: '< 30 min', color: '#10B981' },
                  { label: '30–60 min', color: '#F59E0B' },
                  { label: '> 60 min', color: '#EF4444', note: 'Escalation threshold' },
                ].map((g) => (
                  <div key={g.label} className="flex items-center gap-2 mb-1.5">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.color }} />
                    <span className="text-xs text-gray-600">{g.label}</span>
                    {g.note && <span className="text-xs text-gray-400 ml-auto">{g.note}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </PageWrapper>
  );
}
