import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { BoxStockSummary, Mvno, CurrentStock, Distributor } from '../types/simcard';
import { DistributorMap } from './DistributorMap';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Bar, Doughnut } from 'react-chartjs-2';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface StockDashboardProps {
  stats: {
    total: number;
    remaining: number;
    issued: number;
    availableBoxes: number;
    totalBoxes: number;
  };
  mvnos: Mvno[];
  boxes: BoxStockSummary[];
  distributors?: Distributor[];
}

interface EsimStats {
  total: number;
  available: number;
  assigned: number;
  activated: number;
}

interface EsimByOperator {
  operator: string;
  total_esims: number;
  available: number;
  assigned: number;
  activated: number;
}

export function StockDashboard({ stats, mvnos, boxes }: StockDashboardProps) {
  const [currentStockView, setCurrentStockView] = useState<CurrentStock[]>([]);
  const [loadingStock, setLoadingStock] = useState(true);
  const [distributors, setDistributors] = useState<Distributor[]>([]);
  const [selectedMvno, setSelectedMvno] = useState<string>('ALL');
  const [esimStats, setEsimStats] = useState<EsimStats>({ total: 0, available: 0, assigned: 0, activated: 0 });
  const [esimByOperator, setEsimByOperator] = useState<EsimByOperator[]>([]);

  useEffect(() => {
    fetchCurrentStockView();
    fetchDistributors();
    fetchEsimStats();
  }, []);

  const fetchDistributors = async () => {
    try {
      const { data, error } = await supabase
        .from('distributors')
        .select('*')
        .eq('is_active', true)
        .order('name');

      if (!error && data) {
        setDistributors(data);
      }
    } catch (err) {
      console.error('Error fetching distributors:', err);
    }
  };

  const fetchEsimStats = async () => {
    try {
      // Fetch total eSIM stats
      const { data: totalData, error: totalError } = await supabase
        .from('total_esim_stock')
        .select('*')
        .single();

      if (!totalError && totalData) {
        setEsimStats({
          total: totalData.total_esims || 0,
          available: totalData.total_available || 0,
          assigned: totalData.total_assigned || 0,
          activated: totalData.total_activated || 0,
        });
      } else {
        // Fallback: query esim_stock directly
        const { count } = await supabase
          .from('esim_stock')
          .select('*', { count: 'exact', head: true });
        
        const { count: availableCount } = await supabase
          .from('esim_stock')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'available');

        setEsimStats({
          total: count || 0,
          available: availableCount || 0,
          assigned: 0,
          activated: 0,
        });
      }

      // Fetch eSIM by operator
      const { data: byOpData, error: byOpError } = await supabase
        .from('esim_stock_by_operator')
        .select('*');

      if (!byOpError && byOpData) {
        // Normalize operator names to uppercase for case-insensitive lookup
        const normalizedData = byOpData.map(e => ({
          ...e,
          operator: e.operator.toUpperCase()
        }));
        setEsimByOperator(normalizedData);
      } else {
        // Fallback: query esim_stock directly grouped by operator
        const { data: rawData } = await supabase
          .from('esim_stock')
          .select('operator');
        
        if (rawData) {
          const grouped: Record<string, number> = {};
          rawData.forEach((row: any) => {
            const op = (row.operator || 'Unknown').toUpperCase();
            grouped[op] = (grouped[op] || 0) + 1;
          });
          setEsimByOperator(
            Object.entries(grouped).map(([op, count]) => ({
              operator: op,
              total_esims: count,
              available: count,
              assigned: 0,
              activated: 0,
            }))
          );
        }
      }
    } catch (err) {
      console.error('Error fetching eSIM stats:', err);
    }
  };

  const fetchCurrentStockView = async () => {
    try {
      setLoadingStock(true);
      const { data, error } = await supabase
        .from('current_stock_view')
        .select('*');

      console.log('StockDashboard - current_stock_view data:', data);
      console.log('StockDashboard - current_stock_view error:', error);
      
      if (error) {
        console.error('Error fetching current_stock_view:', error);
      } else {
        setCurrentStockView(data || []);
      }
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setLoadingStock(false);
    }
  };

  // Get TOTAL row from current_stock_view
  const getTotalStock = (simType: string): CurrentStock | undefined => {
    return currentStockView.find(s => s.mvno === 'TOTAL' && s.sim_type === simType);
  };

  // Get stock by MVNO (case-insensitive)
  const getStockByMvno = (mvnoName: string, simType: string): CurrentStock | undefined => {
    const stock = currentStockView.find(s => 
      s.mvno.toUpperCase() === mvnoName.toUpperCase() && s.sim_type === simType
    );
    console.log('getStockByMvno:', mvnoName, simType, '->', stock);
    return stock;
  };

  // Calculate overall stats from TOTAL row
  const totalPhysicalStock = useMemo(() => {
    const total = getTotalStock('PHYSICAL');
    if (total) {
      return {
        total: total.total_stock,
        remaining: total.in_store,
        issued: total.issued
      };
    }
    return {
      total: stats.total,
      remaining: stats.remaining,
      issued: stats.issued
    };
  }, [currentStockView, stats]);

  const totalEsimStock = useMemo(() => {
    // First try from current_stock_view
    const total = getTotalStock('ESIM');
    if (total && total.total_stock > 0) {
      return total;
    }
    // Fallback to direct esim_stock query
    return { 
      total_stock: esimStats.total, 
      in_store: esimStats.available, 
      issued: esimStats.assigned,
      activated: esimStats.activated,
      sold: 0,
      failed: 0,
      mvno: 'TOTAL',
      sim_type: 'ESIM'
    };
  }, [currentStockView, esimStats]);

  // Get available boxes count
  const availableBoxesCount = useMemo(() => {
    return boxes.filter(b => b.remaining_sims > 0).length;
  }, [boxes]);

  // Calculate stock utilization percentage
  const stockUtilization = useMemo(() => {
    if (totalPhysicalStock.total === 0) return 0;
    return Math.round((totalPhysicalStock.issued / totalPhysicalStock.total) * 100);
  }, [totalPhysicalStock]);

  // Chart colors - Hamilton Telecom Brand
  const chartColors = {
    primary: '#3F7F6F',      // Brand Green - Healthy stock
    primaryLight: '#5A9E8F',
    primaryDark: '#2F5F52',
    success: '#3F7F6F',     // Alias for primary - Healthy stock
    accent: '#F0A326',      // Accent Orange - Low stock
    accentLight: '#F5BD4D',
    warning: '#F0A326',     // Low stock - Orange
    danger: '#DC3545',      // Critical - Red
    info: '#0EA5E9',        // Info blue (kept for contrast)
    purple: '#8B5CF6',
    neutral: '#6B6966',
  };

  // Stock by MVNO data for bar chart
  const stockByMvnoData = useMemo(() => {
    const labels: string[] = [];
    const physicalData: number[] = [];
    const esimData: number[] = [];

    currentStockView
      .filter(s => s.mvno !== 'TOTAL' && s.sim_type === 'PHYSICAL')
      .forEach(s => {
        labels.push(s.mvno);
        physicalData.push(s.total_stock);
        
        // Try current_stock_view first, then fallback to esimByOperator (case-insensitive)
        const esim = getStockByMvno(s.mvno, 'ESIM');
        const esimOp = esimByOperator.find(e => e.operator.toUpperCase() === s.mvno.toUpperCase());
        esimData.push(esim?.total_stock || esimOp?.total_esims || 0);
      });

    return {
      labels,
      datasets: [
        {
          label: 'Physical SIMs',
          data: physicalData,
          backgroundColor: chartColors.primary,
          borderRadius: 6,
        },
        {
          label: 'eSIMs',
          data: esimData,
          backgroundColor: chartColors.purple,
          borderRadius: 6,
        },
      ],
    };
  }, [currentStockView, esimByOperator]);

  // Stock status doughnut data
  const stockStatusData = useMemo(() => {
    return {
      labels: ['In Store', 'Issued', 'Activated', 'Failed'],
      datasets: [
        {
          data: [
            totalPhysicalStock.remaining,
            totalPhysicalStock.issued,
            0,
            0
          ],
          backgroundColor: [
            chartColors.success,
            chartColors.primary,
            chartColors.warning,
            chartColors.danger,
          ],
          borderWidth: 0,
        },
      ],
    };
  }, [totalPhysicalStock]);

  // Physical vs eSIM doughnut
  const physicalVsEsimData = useMemo(() => {
    return {
      labels: ['Physical SIMs', 'eSIMs'],
      datasets: [
        {
          data: [totalPhysicalStock.total, totalEsimStock.total_stock],
          backgroundColor: [chartColors.primary, chartColors.success],
          borderWidth: 0,
        },
      ],
    };
  }, [totalPhysicalStock, totalEsimStock]);

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom' as const,
        labels: {
          color: '#6B6966',
          padding: 20,
          usePointStyle: true,
        },
      },
    },
    scales: {
      x: {
        grid: { color: '#E0DDD9' },
        ticks: { color: '#6B6966' },
      },
      y: {
        grid: { color: '#E0DDD9' },
        ticks: { color: '#6B6966' },
      },
    },
  };

  const doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'right' as const,
        labels: {
          color: '#6B6966',
          padding: 15,
          usePointStyle: true,
        },
      },
    },
    cutout: '65%',
  };

  const getStockStatus = (remaining: number, total: number) => {
    const percent = total > 0 ? (remaining / total) * 100 : 0;
    if (percent > 50) return { status: 'Healthy', color: 'success', icon: '●' };
    if (percent > 20) return { status: 'Medium', color: 'warning', icon: '●' };
    return { status: 'Critical', color: 'danger', icon: '●' };
  };

  return (
    <div className="row g-4">
      {/* ============================================ */}
      {/* KPI ROW - Modern Tabler-style Cards */}
      {/* ============================================ */}
      <div className="col-12">
        <div className="row g-3">
          {/* Total Physical SIMs */}
          <div className="col-6 col-lg-3">
            <div className="stat-card" style={{ borderLeft: `4px solid ${chartColors.primary}` }}>
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <div className="stat-value" style={{ fontSize: '1.75rem' }}>
                    {totalPhysicalStock.total.toLocaleString()}
                  </div>
                  <div className="stat-label">Total Physical SIMs</div>
                </div>
                <div className="stat-icon" style={{ backgroundColor: `${chartColors.primary}20`, color: chartColors.primary }}>
                  <i className="bi bi-sim"></i>
                </div>
              </div>
              <div className="mt-2">
                <span className="badge bg-success">+12% from boxes</span>
              </div>
            </div>
          </div>

          {/* Physical Remaining */}
          <div className="col-6 col-lg-3">
            <div className="stat-card" style={{ borderLeft: `4px solid ${chartColors.success}` }}>
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <div className="stat-value" style={{ fontSize: '1.75rem', color: chartColors.success }}>
                    {totalPhysicalStock.remaining.toLocaleString()}
                  </div>
                  <div className="stat-label">Physical Remaining</div>
                </div>
                <div className="stat-icon" style={{ backgroundColor: `${chartColors.success}20`, color: chartColors.success }}>
                  <i className="bi bi-box-seam"></i>
                </div>
              </div>
              <div className="mt-2">
                <div className="progress" style={{ height: '6px' }}>
                  <div 
                    className="progress-bar bg-success" 
                    style={{ width: `${stockUtilization}%` }}
                  ></div>
                </div>
                <small className="text-muted">{100 - stockUtilization}% utilized</small>
              </div>
            </div>
          </div>

          {/* Physical Issued */}
          <div className="col-6 col-lg-3">
            <div className="stat-card" style={{ borderLeft: `4px solid ${chartColors.warning}` }}>
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <div className="stat-value" style={{ fontSize: '1.75rem', color: chartColors.warning }}>
                    {totalPhysicalStock.issued.toLocaleString()}
                  </div>
                  <div className="stat-label">Physical Issued</div>
                </div>
                <div className="stat-icon" style={{ backgroundColor: `${chartColors.warning}20`, color: chartColors.warning }}>
                  <i className="bi bi-arrow-up-circle"></i>
                </div>
              </div>
              <div className="mt-2">
                <span className="badge bg-warning text-dark">{stockUtilization}% of stock</span>
              </div>
            </div>
          </div>

          {/* Total eSIMs */}
          <div className="col-6 col-lg-3">
            <div className="stat-card" style={{ borderLeft: `4px solid ${chartColors.purple}` }}>
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <div className="stat-value" style={{ fontSize: '1.75rem', color: chartColors.purple }}>
                    {esimStats.total.toLocaleString()}
                  </div>
                  <div className="stat-label">Total eSIMs</div>
                </div>
                <div className="stat-icon" style={{ backgroundColor: `${chartColors.purple}20`, color: chartColors.purple }}>
                  <i className="bi bi-phone"></i>
                </div>
              </div>
              <div className="mt-2">
                <span className="badge" style={{ backgroundColor: chartColors.purple }}>
                  {esimStats.available.toLocaleString()} available
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ============================================ */}
      {/* CHARTS ROW */}
      {/* ============================================ */}
      <div className="col-12">
        <div className="row g-4">
          {/* Stock by MVNO Bar Chart */}
          <div className="col-lg-8">
            <div className="card card-custom h-100">
              <div className="card-header card-header-custom">
                <div className="d-flex justify-content-between align-items-center">
                  <h5 className="mb-0">
                    <i className="bi bi-bar-chart me-2"></i>
                    Stock by MVNO
                  </h5>
                  <select 
                    className="form-select form-select-sm form-select-custom"
                    value={selectedMvno}
                    onChange={(e) => setSelectedMvno(e.target.value)}
                    style={{ width: '150px' }}
                  >
                    <option value="ALL">All MVNOs</option>
                    {mvnos.map(m => (
                      <option key={m.id} value={m.name}>{m.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="card-body">
                <div style={{ height: '280px' }}>
                  <Bar data={stockByMvnoData} options={chartOptions} />
                </div>
              </div>
            </div>
          </div>

          {/* Physical vs eSIM Doughnut */}
          <div className="col-lg-4">
            <div className="card card-custom h-100">
              <div className="card-header card-header-custom">
                <h5 className="mb-0">
                  <i className="bi bi-pie-chart me-2"></i>
                  Physical vs eSIM
                </h5>
              </div>
              <div className="card-body">
                <div style={{ height: '220px' }}>
                  <Doughnut data={physicalVsEsimData} options={doughnutOptions} />
                </div>
                <div className="text-center mt-3">
                  <span className="badge bg-primary fs-6 me-2">
                    Physical: {totalPhysicalStock.total.toLocaleString()}
                  </span>
                  <span className="badge bg-success fs-6">
                    eSIM: {totalEsimStock.total_stock.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ============================================ */}
      {/* MVNO CARDS GRID */}
      {/* ============================================ */}
      <div className="col-12">
        <div className="card card-custom">
          <div className="card-header card-header-custom">
            <h5 className="mb-0">
              <i className="bi bi-collection me-2"></i>
              Stock by MVNO
            </h5>
          </div>
          <div className="card-body">
            <div className="row g-4">
              {mvnos.map(mvno => {
                const physical = getStockByMvno(mvno.name, 'PHYSICAL');
                const esim = getStockByMvno(mvno.name, 'ESIM');
                const physicalTotal = physical?.total_stock || 0;
                const physicalRemaining = physical?.in_store || 0;
                // Use esimByOperator as fallback for eSIM data
                const esimOp = esimByOperator.find(e => e.operator === mvno.name);
                const esimTotal = esim?.total_stock || esimOp?.total_esims || 0;
                const total = physicalTotal + esimTotal;
                
                const status = getStockStatus(physicalRemaining, physicalTotal);
                
                return (
                  <div key={mvno.name} className="col-md-6 col-lg-3">
                    <div className="p-3 rounded" style={{ backgroundColor: 'var(--bg-tertiary)', border: `2px solid var(--border)` }}>
                      <div className="d-flex justify-content-between align-items-center mb-3">
                        <h5 className="mb-0">
                          <span className="badge" style={{ backgroundColor: chartColors.primary }}>{mvno.name}</span>
                        </h5>
                        <span className={`badge bg-${status.color}`}>
                          {status.icon} {status.status}
                        </span>
                      </div>

                      {/* Physical SIM */}
                      <div className="mb-3 pb-2 border-bottom border-secondary">
                        <div className="d-flex align-items-center gap-2 mb-2">
                          <span className="sim-type-badge sim-type-physical">PHYSICAL</span>
                        </div>
                        <div className="d-flex justify-content-between mb-1">
                          <small>Stock</small>
                          <small className="fw-bold">{physicalTotal.toLocaleString()}</small>
                        </div>
                        <div className="progress" style={{ height: '8px' }}>
                          <div 
                            className="progress-bar bg-primary" 
                            style={{ width: physicalTotal > 0 ? '100%' : '0%' }}
                          ></div>
                        </div>
                        <div className="d-flex justify-content-between mt-1">
                          <small className="text-success">Avail: {physicalRemaining.toLocaleString()}</small>
                          <small className="text-warning">Issued: {(physicalTotal - physicalRemaining).toLocaleString()}</small>
                        </div>
                      </div>

                      {/* eSIM */}
                      <div>
                        <div className="d-flex align-items-center gap-2 mb-2">
                          <span className="sim-type-badge sim-type-esim">eSIM</span>
                        </div>
                        <div className="d-flex justify-content-between mb-1">
                          <small>Stock</small>
                          <small className="fw-bold">{esimTotal.toLocaleString()}</small>
                        </div>
                        <div className="progress" style={{ height: '8px' }}>
                          <div 
                            className="progress-bar bg-success" 
                            style={{ width: esimTotal > 0 ? '100%' : '0%' }}
                          ></div>
                        </div>
                      </div>

                      {/* Grand Total */}
                      <div className="mt-3 pt-2 border-top border-secondary">
                        <div className="d-flex justify-content-between align-items-center">
                          <span className="fw-bold">Total</span>
                          <span className="badge bg-secondary fs-6">
                            {total.toLocaleString()} SIMs
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ============================================ */}
      {/* MAP ROW */}
      {/* ============================================ */}
      <div className="col-12">
        <DistributorMap distributors={distributors} />
      </div>

      {/* ============================================ */}
      {/* BOX STATUS OVERVIEW */}
      {/* ============================================ */}
      <div className="col-12 col-lg-8">
        <div className="card card-custom">
          <div className="card-header card-header-custom d-flex justify-content-between align-items-center">
            <h5 className="mb-0">
              <i className="bi bi-grid me-2"></i>
              Box Status Overview
            </h5>
            <span className="badge bg-secondary">{boxes.length} boxes</span>
          </div>
          <div className="card-body p-0">
            <div className="table-responsive">
              <table className="table table-custom">
                <thead>
                  <tr>
                    <th>MVNO</th>
                    <th>Carton</th>
                    <th>Box</th>
                    <th>ICCID Range</th>
                    <th>Remaining</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {boxes.map((box, idx) => (
                    <tr key={`${box.box_id}-${idx}`}>
                      <td>
                        <span className="badge bg-primary">{box.mvno}</span>
                      </td>
                      <td className="mono">{box.carton_number}</td>
                      <td className="fw-bold">
                        Box {box.box_display || box.box_number}
                        <span className="text-muted ms-1">
                          ({box.mvno} total: {boxes.filter(b => b.mvno === box.mvno).length})
                        </span>
                      </td>
                      <td className="mono">
                        <small>
                          {box.iccid_start.substring(0, 10)}...{box.iccid_end.substring(15)}
                        </small>
                      </td>
                      <td>
                        <div className="d-flex align-items-center gap-2">
                          <span className={`fw-bold ${box.remaining_sims > 0 ? 'text-success' : 'text-danger'}`}>
                            {box.remaining_sims}
                          </span>
                          <div className="progress progress-custom" style={{ width: '50px', height: '4px' }}>
                            <div 
                              className={`progress-bar ${box.remaining_percent > 50 ? 'bg-success' : box.remaining_percent > 20 ? 'bg-warning' : 'bg-danger'}`}
                              style={{ width: `${box.remaining_percent}%` }}
                            ></div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`badge badge-${box.status.toLowerCase().replace('_', '-')}`}>
                          {box.status.replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* ============================================ */}
      {/* QUICK INFO */}
      {/* ============================================ */}
      <div className="col-12 col-lg-4">
        <div className="card card-custom h-100">
          <div className="card-header card-header-custom">
            <h5 className="mb-0">
              <i className="bi bi-info-circle me-2"></i>
              Quick Info
            </h5>
          </div>
          <div className="card-body">
            <div className="mb-4">
              <h6>SIM Type Legend</h6>
              <div className="d-flex flex-wrap gap-2 mb-2">
                <span className="sim-type-badge sim-type-physical">PHYSICAL</span>
                <span className="sim-type-badge sim-type-esim">eSIM</span>
              </div>
            </div>
            
            <div className="mb-4">
              <h6>Status Legend</h6>
              <div className="d-flex flex-wrap gap-2">
                <span className="badge bg-success">IN_STORE</span>
                <span className="badge bg-primary">ISSUED</span>
                <span className="badge bg-warning">ACTIVATED</span>
                <span className="badge bg-info">SOLD</span>
                <span className="badge bg-danger">FAILED</span>
              </div>
            </div>
            
            <div className="mb-4">
              <h6>How It Works</h6>
              <ol className="text-muted-custom small">
                <li className="mb-2">SIMs come in cartons (10 cartons = 200 boxes for 50K)</li>
                <li className="mb-2">Each box contains 250 SIMs with unique ICCID ranges</li>
                <li className="mb-2">Distribute SIMs by selecting a box and choosing a distributor</li>
                <li className="mb-2">Track remaining SIMs per box in real-time</li>
              </ol>
            </div>

            <div>
              <h6>ICCID Format</h6>
              <p className="text-muted-custom small mb-0">
                ICCIDs are 20 digits starting with 892562 for PAXTEL/AGROTEL/SALAMTEL SIMs.
                Each box has a unique range of ICCIDs.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
