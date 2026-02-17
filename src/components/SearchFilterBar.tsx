import type { SimcardStatus } from '../types/simcard';

const STATUS_OPTIONS: SimcardStatus[] = ['available', 'assigned', 'activated', 'deactivated'];

interface SearchFilterBarProps {
  search: string;
  onSearchChange: (v: string) => void;
  statusFilter: SimcardStatus | '';
  onStatusFilterChange: (v: SimcardStatus | '') => void;
  carrierFilter: string;
  onCarrierFilterChange: (v: string) => void;
  carriers: string[];
}

export function SearchFilterBar({
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  carrierFilter,
  onCarrierFilterChange,
  carriers,
}: SearchFilterBarProps) {
  return (
    <div className="search-filter-bar">
      <input
        type="search"
        className="search-input"
        placeholder="Search ICCID or phone..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      <select
        className="filter-select"
        value={statusFilter}
        onChange={(e) => onStatusFilterChange((e.target.value || '') as SimcardStatus | '')}
      >
        <option value="">All statuses</option>
        {STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <select
        className="filter-select"
        value={carrierFilter}
        onChange={(e) => onCarrierFilterChange(e.target.value)}
      >
        <option value="">All carriers</option>
        {carriers.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );
}
