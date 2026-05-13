import type { RequestStatus } from '../../types';

const CONFIG: Record<RequestStatus, { label: string; bg: string; color: string; pulse?: boolean }> = {
  PENDING:   { label: 'Pending',   bg: '#FEF3C7', color: '#92400E' },
  APPROVED:  { label: 'Approved',  bg: '#D1FAE5', color: '#065F46' },
  REJECTED:  { label: 'Rejected',  bg: '#FEE2E2', color: '#991B1B' },
  ESCALATED: { label: 'Escalated', bg: '#FFEDD5', color: '#9A3412', pulse: true },
  COMPLETED: { label: 'Completed', bg: '#F3F4F6', color: '#374151' },
};

export function StatusBadge({ status }: { status: RequestStatus }) {
  const cfg = CONFIG[status] || CONFIG.PENDING;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold"
      style={{ background: cfg.bg, color: cfg.color }}
    >
      {cfg.pulse && (
        <span className="relative flex h-2 w-2">
          <span
            className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
            style={{ background: cfg.color }}
          />
          <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: cfg.color }} />
        </span>
      )}
      {cfg.label}
    </span>
  );
}

export function SimTypeBadge({ type }: { type: 'PHYSICAL' | 'ESIM' }) {
  return type === 'ESIM' ? (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold"
      style={{ background: '#CCFBF1', color: '#0F766E' }}>eSIM</span>
  ) : (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold"
      style={{ background: '#DBEAFE', color: '#1D4ED8' }}>Physical</span>
  );
}
