import { useState, useMemo } from 'react';
import type { Mvno, SimStatus } from '../types/simcard';

export interface InventoryFilters {
  search: string;
  cartonNumber: string;
  boxNumber: string;
  boxDisplay: string;
  iccidFrom: string;
  iccidTo: string;
  mvno: string;
  status: SimStatus | '';
}

interface InventoryFilterPanelProps {
  mvnos: Mvno[];
  onFilterChange: (filters: InventoryFilters) => void;
  onSearch: () => void;
  onClear: () => void;
  loading?: boolean;
  resultCount?: number;
  totalCount?: number;
  showIccidRange?: boolean;
  showBoxFilters?: boolean;  // For eSIM, hide carton/box filters
  iccidMode?: 'range' | 'single';  // For eSIM, show single ICCID field
  statusOptions?: { value: string; label: string }[];
}

const STATUS_OPTIONS = [
  { value: '', label: 'All Status' },
  { value: 'IN_STORE', label: 'In Store' },
  { value: 'ISSUED', label: 'Issued' },
  { value: 'ACTIVATED', label: 'Activated' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'available', label: 'Available' },
  { value: 'assigned', label: 'Assigned' },
];

export function InventoryFilterPanel({
  mvnos,
  onFilterChange,
  onSearch,
  onClear,
  loading = false,
  resultCount = 0,
  totalCount = 0,
  showIccidRange = true,
  showBoxFilters = true,
  iccidMode = 'range',
  statusOptions,
}: InventoryFilterPanelProps) {
  // Use custom status options if provided, otherwise use default
  const displayStatusOptions = statusOptions || STATUS_OPTIONS;

  const [filters, setFilters] = useState<InventoryFilters>({
    search: '',
    cartonNumber: '',
    boxNumber: '',
    boxDisplay: '',
    iccidFrom: '',
    iccidTo: '',
    mvno: '',
    status: '',
  });

  const handleFilterChange = (key: keyof InventoryFilters, value: string) => {
    const newFilters = { ...filters, [key]: value };
    setFilters(newFilters);
    onFilterChange(newFilters);
  };

  const handleSearch = () => {
    onSearch();
  };

  const handleClear = () => {
    const clearedFilters: InventoryFilters = {
      search: '',
      cartonNumber: '',
      boxNumber: '',
      boxDisplay: '',
      iccidFrom: '',
      iccidTo: '',
      mvno: '',
      status: '',
    };
    setFilters(clearedFilters);
    onFilterChange(clearedFilters);
    onClear();
  };

  const hasActiveFilters = useMemo(() => {
    return (
      filters.search !== '' ||
      filters.cartonNumber !== '' ||
      filters.boxNumber !== '' ||
      filters.iccidFrom !== '' ||
      filters.iccidTo !== '' ||
      filters.mvno !== '' ||
      filters.status !== ''
    );
  }, [filters]);

  return (
    <div className="card card-custom mb-4">
      <div className="card-header card-header-custom">
        <div className="d-flex justify-content-between align-items-center">
          <h5 className="mb-0">
            <i className="bi bi-funnel me-2"></i>
            Advanced Filters
          </h5>
          {hasActiveFilters && resultCount > -1 && (
            <span className="badge bg-success">
              {resultCount.toLocaleString()} {resultCount === 1 ? 'result' : 'results'}
              {totalCount > 0 && ` of ${totalCount.toLocaleString()}`}
            </span>
          )}
        </div>
      </div>
      <div className="card-body">
        {/* Main Filter Grid */}
        <div className="row g-3">
          {/* Row 1: MVNO, Carton Number, Box Number */}
          <div className="col-md-4">
            <label className="form-label small text-muted-custom mb-1">MVNO</label>
            <select
              className="form-select form-select-custom"
              value={filters.mvno}
              onChange={(e) => handleFilterChange('mvno', e.target.value)}
            >
              <option value="">All MVNOs</option>
              {mvnos.map((m) => (
                <option key={m.id} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          {/* Carton and Box filters - only show for physical SIMs */}
          {showBoxFilters && (
            <>
              <div className="col-md-4">
                <label className="form-label small text-muted-custom mb-1">Carton Number</label>
                <input
                  type="text"
                  className="form-control form-control-custom"
                  placeholder="e.g., PAX-1/10"
                  value={filters.cartonNumber}
                  onChange={(e) => handleFilterChange('cartonNumber', e.target.value)}
                />
              </div>

              <div className="col-md-4">
                <label className="form-label small text-muted-custom mb-1">Box Number</label>
                <input
                  type="text"
                  className="form-control form-control-custom"
                  placeholder="e.g., 1-800"
                  value={filters.boxNumber}
                  onChange={(e) => handleFilterChange('boxNumber', e.target.value)}
                />
              </div>
            </>
          )}

          {/* Row 2: ICCID Range */}
          {showIccidRange && (
            <>
              {/* Single ICCID field for eSIM, Range for physical */}
              {iccidMode === 'single' ? (
                <div className="col-md-4">
                  <label className="form-label small text-muted-custom mb-1">ICCID</label>
                  <input
                    type="text"
                    className="form-control form-control-custom"
                    placeholder="Search ICCID (20 digits)"
                    value={filters.iccidFrom}
                    onChange={(e) => handleFilterChange('iccidFrom', e.target.value)}
                    maxLength={20}
                  />
                </div>
              ) : (
                <>
                  <div className="col-md-4">
                    <label className="form-label small text-muted-custom mb-1">ICCID From</label>
                    <input
                      type="text"
                      className="form-control form-control-custom"
                      placeholder="Start ICCID (20 digits)"
                      value={filters.iccidFrom}
                      onChange={(e) => handleFilterChange('iccidFrom', e.target.value)}
                      maxLength={20}
                    />
                  </div>

                  <div className="col-md-4">
                    <label className="form-label small text-muted-custom mb-1">ICCID To</label>
                    <input
                      type="text"
                      className="form-control form-control-custom"
                      placeholder="End ICCID (20 digits)"
                      value={filters.iccidTo}
                      onChange={(e) => handleFilterChange('iccidTo', e.target.value)}
                      maxLength={20}
                    />
                  </div>
                </>
              )}

              <div className="col-md-4">
                <label className="form-label small text-muted-custom mb-1">Status</label>
                <select
                  className="form-select form-select-custom"
                  value={filters.status}
                  onChange={(e) => handleFilterChange('status', e.target.value)}
                >
                  {displayStatusOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* Row 3: General Search (always visible) */}
          <div className={showIccidRange ? 'col-12' : 'col-md-8'}>
            <label className="form-label small text-muted-custom mb-1">General Search</label>
            <input
              type="text"
              className="form-control form-control-custom"
              placeholder="Search by ICCID, IMSI, or any identifier..."
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
            />
          </div>

          {!showIccidRange && (
            <div className="col-md-4">
              <label className="form-label small text-muted-custom mb-1">Status</label>
              <select
                className="form-select form-select-custom"
                value={filters.status}
                onChange={(e) => handleFilterChange('status', e.target.value)}
              >
                {displayStatusOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="row mt-3">
          <div className="col-12 d-flex justify-content-end gap-2">
            <button
              type="button"
              className="btn btn-outline-custom"
              onClick={handleClear}
              disabled={loading}
            >
              <i className="bi bi-x-circle me-1"></i>
              Clear Filters
            </button>
            <button
              type="button"
              className="btn btn-primary-custom"
              onClick={handleSearch}
              disabled={loading}
            >
              {loading ? (
                <>
                  <span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>
                  Searching...
                </>
              ) : (
                <>
                  <i className="bi bi-search me-1"></i>
                  Search
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
