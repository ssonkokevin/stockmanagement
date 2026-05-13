import { ReactNode } from 'react';

interface MetricCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon?: ReactNode;
  iconBg?: string;
  trend?: { value: string; up: boolean };
  progress?: { value: number; color?: string };
  alert?: boolean;
}

export function MetricCard({ label, value, sub, icon, iconBg, trend, progress, alert }: MetricCardProps) {
  return (
    <div
      className={`bg-white rounded-card p-5 shadow-sm border ${alert ? 'border-red-200' : 'border-gray-100'} flex flex-col gap-3`}
      style={{ borderRadius: 10 }}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
          {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
        </div>
        {icon && (
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: iconBg || '#D1FAE5' }}
          >
            {icon}
          </div>
        )}
      </div>

      {trend && (
        <div className="flex items-center gap-1">
          <span className={`text-xs font-semibold ${trend.up ? 'text-green-600' : 'text-red-500'}`}>
            {trend.up ? '↑' : '↓'} {trend.value}
          </span>
          <span className="text-xs text-gray-400">vs yesterday</span>
        </div>
      )}

      {progress && (
        <div>
          <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(100, Math.max(0, progress.value))}%`,
                background: progress.color || '#10B981',
              }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">{progress.value.toFixed(0)}% utilised</p>
        </div>
      )}
    </div>
  );
}
