import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { Mvno, SimStatus, CurrentStock } from '../types/simcard';
import { InventoryFilterPanel, InventoryFilters } from './InventoryFilterPanel';
import { useEsimStock, EsimFilters } from '../hooks/useSimcards';

interface EsimStockViewProps {
  mvnos: Mvno[];
}

const PAGE_SIZE = 50;

export function EsimStockView({ mvnos }: EsimStockViewProps) {
  const [currentStockView, setCurrentStockView] = useState<CurrentStock[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [filters, setFilters] = useState<EsimFilters>({
    search: '',
    cartonNumber: '',
    boxNumber: '',
    iccidFrom: '',
    iccidTo: '',
    mvno: '',
    status: '',
  });

  const { esimStock, loading, error, totalCount, refetch } = useEsimStock(filters);

  useEffect(() => {
    fetchCurrentStockView();
  }, []);

  const fetchCurrentStockView = async () => {
    try {
      // First try to get data from current_stock_view (more reliable)
      const { data: stockView, error: stockError } = await supabase
        .from('current_stock_view')
        .select('*')
        .eq('sim_type', 'ESIM');
      
      console.log('stockView from view:', stockView, 'error:', stockError);
      
      if (!stockError && stockView && stockView.length > 0) {
        // Use data from view - it's already correctly formatted
        setCurrentStockView(stockView);
        return;
      }
      
      // Fallback: query esim_stock directly
      console.log('Falling back to esim_stock table query...');
      const { count: totalCount } = await supabase
        .from('esim_stock')
        .select('*', { count: 'exact', head: true });
      
      const { count: availableCount } = await supabase
        .from('esim_stock')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'available');
        
      const { count: assignedCount } = await supabase
        .from('esim_stock')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'assigned');
        
      const { count: activatedCount } = await supabase
        .from('esim_stock')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'activated');
      
      // Get all eSIMs with operator info for per-operator stats
      const { data: allEsims, error: esimError } = await supabase
        .from('esim_stock')
        .select('operator, status');
      
      console.log('allEsims:', allEsims?.length, 'error:', esimError);
      
      // Aggregate by operator (normalize to uppercase)
      const operatorStats: Record<string, { total: number; available: number; assigned: number; activated: number }> = {};
      if (allEsims) {
        allEsims.forEach((esim: any) => {
          const op = (esim.operator || 'Unknown').toUpperCase();
          if (!operatorStats[op]) {
            operatorStats[op] = { total: 0, available: 0, assigned: 0, activated: 0 };
          }
          operatorStats[op].total++;
          if (esim.status === 'available') operatorStats[op].available++;
          else if (esim.status === 'assigned') operatorStats[op].assigned++;
          else if (esim.status === 'activated') operatorStats[op].activated++;
        });
      }
      
      // Build stock data: TOTAL row + individual operator rows
      const stockData: CurrentStock[] = [{
        mvno: 'TOTAL',
        sim_type: 'ESIM',
        total_stock: totalCount || 0,
        in_store: availableCount || 0,
        issued: (assignedCount || 0) + (activatedCount || 0),
        activated: activatedCount || 0,
        sold: 0,
        failed: 0
      }];
      
      // Add individual operator rows
      Object.entries(operatorStats).forEach(([operator, data]) => {
        stockData.push({
          mvno: operator,
          sim_type: 'ESIM',
          total_stock: data.total,
          in_store: data.available,
          issued: data.assigned + data.activated,
          activated: data.activated,
          sold: 0,
          failed: 0
        });
      });
      
      setCurrentStockView(stockData);
    } catch (err) {
      console.error('Error fetching eSIM stats:', err);
      // Set empty stats on error
      setCurrentStockView([{
        mvno: 'TOTAL',
        sim_type: 'ESIM',
        total_stock: 0,
        in_store: 0,
        issued: 0,
        activated: 0,
        sold: 0,
        failed: 0
      }]);
    }
  };

  // Get eSIM stats from current_stock_view
  const esimStats = useMemo(() => {
    const stats: Record<string, { total: number; inStore: number; issued: number }> = {};
    
    console.log('currentStockView:', currentStockView);
    
    currentStockView.forEach(s => {
      if (s.mvno === 'TOTAL') return;
      // Store with uppercase key for case-insensitive lookup
      const key = s.mvno.toUpperCase();
      stats[key] = {
        total: s.total_stock,
        inStore: s.in_store,
        issued: s.issued
      };
    });
    
    console.log('esimStats:', stats);
    
    return stats;
  }, [currentStockView]);

  // Get total from current_stock_view
  const totalFromView = useMemo(() => {
    const total = currentStockView.find(s => s.mvno === 'TOTAL' && s.sim_type === 'ESIM');
    return total || { total_stock: 0, in_store: 0, issued: 0 };
  }, [currentStockView]);

  // Handle filter changes
  const handleFilterChange = (newFilters: InventoryFilters) => {
    setFilters({
      search: newFilters.search,
      cartonNumber: newFilters.cartonNumber,
      boxNumber: newFilters.boxNumber,
      iccidFrom: newFilters.iccidFrom,
      iccidTo: newFilters.iccidTo,
      mvno: newFilters.mvno,
      status: newFilters.status,
    });
    setCurrentPage(1);
  };

  const handleSearch = () => {
    refetch();
  };

  const handleClear = () => {
    setFilters({
      search: '',
      cartonNumber: '',
      boxNumber: '',
      iccidFrom: '',
      iccidTo: '',
      mvno: '',
      status: '',
    });
    setCurrentPage(1);
  };

  // Paginate
  const paginatedEsims = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return esimStock.slice(start, start + PAGE_SIZE);
  }, [esimStock, currentPage]);

  const totalPages = Math.ceil(esimStock.length / PAGE_SIZE);

  const getStatusBadgeClass = (status: string) => {
    switch (status.toLowerCase()) {
      case 'available':
        return 'bg-success';
      case 'assigned':
        return 'bg-warning';
      case 'activated':
        return 'bg-info';
      case 'failed':
        return 'bg-danger';
      default:
        return 'bg-secondary';
    }
  };

  return (
    <div className="row g-4">
      {/* Stats Cards - from current_stock_view */}
      <div className="col-12">
        <div className="row g-3">
          {/* TOTAL eSIMs */}
          <div className="col-6 col-lg-3">
            <div className="stat-card">
              <div className="stat-value">{totalFromView.total_stock.toLocaleString()}</div>
              <div className="stat-label">Total eSIMs (All)</div>
            </div>
          </div>
          <div className="col-6 col-lg-3">
            <div className="stat-card">
              <div className="stat-value text-success">{totalFromView.in_store.toLocaleString()}</div>
              <div className="stat-label">In Store</div>
            </div>
          </div>
          <div className="col-6 col-lg-3">
            <div className="stat-card">
              <div className="stat-value text-warning">{totalFromView.issued.toLocaleString()}</div>
              <div className="stat-label">Issued</div>
            </div>
          </div>
          
          {/* By MVNO */}
          {mvnos.filter(m => m.name !== 'BCC').map(mvno => {
            const stat = esimStats[mvno.name.toUpperCase()] || { total: 0, inStore: 0, issued: 0 };
            
            console.log('Looking up mvno:', mvno.name, 'in esimStats:', esimStats);
            return (
              <div key={mvno.name} className="col-6 col-lg-3">
                <div className="stat-card">
                  <div className="stat-value" style={{ fontSize: '1.25rem' }}>{stat.total.toLocaleString()}</div>
                  <div className="stat-label">{mvno.name} eSIMs</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Advanced Filter Panel */}
      <div className="col-12">
        <InventoryFilterPanel
          mvnos={mvnos}
          onFilterChange={handleFilterChange}
          onSearch={handleSearch}
          onClear={handleClear}
          loading={loading}
          resultCount={esimStock.length}
          totalCount={totalCount}
          showIccidRange={true}
          showBoxFilters={false}
          iccidMode="single"
          statusOptions={[
            { value: '', label: 'All Status' },
            { value: 'available', label: 'Available' },
            { value: 'assigned', label: 'Assigned' },
            { value: 'activated', label: 'Activated' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
      </div>

      {/* eSIM Table */}
      <div className="col-12">
        <div className="card card-custom">
          <div className="card-header card-header-custom">
            <h5 className="mb-0">
              <i className="bi bi-sim me-2"></i>
              eSIM Stock Inventory
            </h5>
          </div>
          <div className="card-body p-0">
            {loading ? (
              <div className="text-center py-5">
                <div className="spinner-border spinner-custom" role="status">
                  <span className="visually-hidden">Loading...</span>
                </div>
                <p className="mt-2 text-muted-custom">Loading eSIM stock...</p>
              </div>
            ) : error ? (
              <div className="text-center py-5">
                <div className="alert alert-danger">
                  <i className="bi bi-exclamation-triangle me-2"></i>
                  Error: {error}
                </div>
              </div>
            ) : esimStock.length === 0 ? (
              <div className="empty-state">
                <i className="bi bi-sim fs-1"></i>
                <p className="mt-2">No eSIMs found</p>
              </div>
            ) : (
              <>
                <div className="table-responsive">
                  <table className="table table-custom">
                    <thead>
                      <tr>
                        <th>ICCID</th>
                        <th>IMSI</th>
                        <th>MVNO</th>
                        <th>Carton</th>
                        <th>Box</th>
                        <th>Status</th>
                        <th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedEsims.map((esim) => (
                        <tr key={esim.id}>
                          <td className="mono">{esim.iccid}</td>
                          <td className="mono">{esim.imsi}</td>
                          <td>
                            <span className="badge bg-primary">{esim.operator}</span>
                          </td>
                          <td>{esim.carton_number || '-'}</td>
                          <td>{esim.box_number || '-'}</td>
                          <td>
                            <span className={`badge ${getStatusBadgeClass(esim.status)}`}>
                              {esim.status}
                            </span>
                          </td>
                          <td>{new Date(esim.created_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="p-3 border-top border-secondary">
                    <div className="d-flex justify-content-between align-items-center">
                      <button
                        className="btn btn-outline-custom btn-sm"
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                      >
                        ← Previous
                      </button>
                      <span className="text-muted-custom">
                        Page {currentPage} of {totalPages} ({esimStock.length.toLocaleString()} results)
                      </span>
                      <button
                        className="btn btn-outline-custom btn-sm"
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                      >
                        Next →
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
