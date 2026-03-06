import { useState, useMemo, useEffect } from 'react';
import { useSimcards, useUpdatePickRecord, useFilteredBoxes, BoxFilters } from './hooks/useSimcards';
import { usePlatformAuth } from './hooks/usePlatformAuth';
import { DistributorForm } from './components/DistributorForm';
import { DistributeSimsModal } from './components/DistributeSimsModal';
import { StockDashboard } from './components/StockDashboard';
import { DistributorHistory } from './components/DistributorHistory';
import { EsimStockView } from './components/EsimStockView';
import { InventoryFilterPanel, InventoryFilters } from './components/InventoryFilterPanel';
import { SuperAdminDashboard } from './components/SuperAdminDashboard';
import { MVNOAdminDashboard } from './components/MVNOAdminDashboard';
import { StockIssuanceRequests } from './components/StockIssuanceRequests';
import { LoginModal } from './components/LoginModal';
import { RequestLinkGenerator } from './components/RequestLinkGenerator';
import { DistributorStockRequests } from './components/DistributorStockRequests';
import { ApproveStock } from './components/ApproveStock';
import type { SimStatus, BoxStockSummary, Distributor, Mvno } from './types/simcard';

type TabType = 'dashboard' | 'distribute' | 'history' | 'distributors' | 'esim' | 'superadmin' | 'stockrequests' | 'distributorrequests' | 'approvestock';

function App() {
  // Platform auth - for MVNE multi-tenant features
  const { 
    user: platformUser, 
    isAuthenticated: isPlatformAuthenticated,
    isSuperAdmin,
    role: platformRole,
    login,
    logout,
    isLoading: authLoading
  } = usePlatformAuth();

  // Auto-show login modal when not authenticated (after auth check completes)
  useEffect(() => {
    if (!authLoading && !isPlatformAuthenticated) {
      setShowLogin(true);
    }
  }, [authLoading, isPlatformAuthenticated]);

  // Role-based redirect after login
  useEffect(() => {
    if (isPlatformAuthenticated && platformUser) {
      if (isSuperAdmin) {
        // Superadmin goes to Stock Requests
        setActiveTab('stockrequests');
      } else if (platformRole === 'MVNO_ADMIN' || platformRole === 'MANAGEMENT') {
        // MVNO admin goes to Distributor Requests
        setActiveTab('distributorrequests');
      } else if (platformRole === 'DISTRIBUTOR') {
        // Distributor goes to their dashboard (could be external)
        // For now, stay on dashboard
      }
    }
  }, [isPlatformAuthenticated, platformUser, isSuperAdmin, platformRole]);

  const { 
    boxes, 
    distributors, 
    mvnos, 
    stats, 
    history, 
    loading, 
    error, 
    pickSims, 
    pickingLoading,
    refetch 
  } = useSimcards();
  
  const { updatePickRecord } = useUpdatePickRecord();
  
  const [activeTab, setActiveTab] = useState<TabType>('dashboard');
  const [showDistributorForm, setShowDistributorForm] = useState(false);
  const [editingDistributor, setEditingDistributor] = useState<Distributor | null>(null);
  const [showBoxSelection, setShowBoxSelection] = useState(false);
  const [selectedDistributor, setSelectedDistributor] = useState<Distributor | null>(null);
  const [search, setSearch] = useState('');
  const [mvnoFilter, setMvnoFilter] = useState<string>('');
  const [distributorMvnoFilter, setDistributorMvnoFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<SimStatus | ''>('');
  const [showLogin, setShowLogin] = useState(false);
  const [showLinkGenerator, setShowLinkGenerator] = useState(false);
  const [linkGeneratorDistributor, setLinkGeneratorDistributor] = useState<Distributor | null>(null);

  // Filter state for advanced filter panel
  const [boxFilters, setBoxFilters] = useState<BoxFilters>({
    search: '',
    cartonNumber: '',
    boxNumber: '',
    boxDisplay: '',
    iccidFrom: '',
    iccidTo: '',
    mvno: '',
    status: '',
  });

  // Use the filtered boxes hook
  const { boxes: filteredBoxes, loading: boxesLoading, totalCount: totalBoxesCount } = useFilteredBoxes(boxFilters);

  // Legacy filter (kept for backward compatibility)
  const legacyFilteredBoxes = useMemo(() => {
    let list = boxes;
    const q = search.trim().toLowerCase();
    
    if (q) {
      list = list.filter(
        (b) =>
          b.carton_number.toLowerCase().includes(q) ||
          b.iccid_start.toLowerCase().includes(q) ||
          b.iccid_end.toLowerCase().includes(q) ||
          b.box_display.toLowerCase().includes(q)
      );
    }
    
    if (mvnoFilter) {
      list = list.filter((b) => b.mvno === mvnoFilter);
    }
    
    if (statusFilter) {
      list = list.filter((b) => b.status === statusFilter);
    }
    
    return list;
  }, [boxes, search, mvnoFilter, statusFilter]);

  // For display, use either filtered boxes or legacy filtered boxes
  const displayBoxes = boxFilters.search || boxFilters.cartonNumber || boxFilters.boxNumber || boxFilters.mvno || boxFilters.status || boxFilters.iccidFrom || boxFilters.iccidTo
    ? filteredBoxes 
    : legacyFilteredBoxes;

  // Calculate overall stats
  const overallStats = useMemo(() => {
    const total = boxes.reduce((acc, b) => acc + b.total_sims, 0);
    const remaining = boxes.reduce((acc, b) => acc + b.remaining_sims, 0);
    const issued = boxes.reduce((acc, b) => acc + b.issued_sims, 0);
    
    return {
      total,
      remaining,
      issued,
      availableBoxes: boxes.filter(b => b.remaining_sims > 0).length,
      totalBoxes: boxes.length
    };
  }, [boxes]);

  // Add MVNO name to distributors and filter by MVNO
  const distributorsWithMvno = useMemo(() => {
    return distributors.map(d => ({
      ...d,
      mvno_name: d.mvno_id ? mvnos.find(m => m.id === d.mvno_id)?.name ?? null : null
    }));
  }, [distributors, mvnos]);

  const filteredDistributors = useMemo(() => {
    let list = distributorsWithMvno;
    
    // For MVNO admins, automatically filter to their MVNO
    if (!isSuperAdmin && platformUser?.mvno_id) {
      list = list.filter(d => d.mvno_id === platformUser.mvno_id);
    } else if (distributorMvnoFilter) {
      list = list.filter(d => d.mvno_id === distributorMvnoFilter);
    }
    return list;
  }, [distributorsWithMvno, distributorMvnoFilter, isSuperAdmin, platformUser]);

  // Filter history for MVNO admins
  const filteredHistory = useMemo(() => {
    if (isSuperAdmin || !platformUser?.mvno_id) {
      return history;
    }
    // For MVNO admins, filter history by their MVNO
    const mvnoName = mvnos.find(m => m.id === platformUser.mvno_id)?.name;
    if (!mvnoName) return [];
    return history.filter(h => h.mvno === mvnoName);
  }, [history, isSuperAdmin, platformUser, mvnos]);

  // Calculate distributor count per MVNO
  const distributorCountByMvno = useMemo(() => {
    const counts: Record<string, number> = {};
    distributorsWithMvno.forEach(d => {
      if (d.mvno_id) {
        const mvnoName = d.mvno_name || 'Unknown';
        counts[mvnoName] = (counts[mvnoName] || 0) + 1;
      }
    });
    return counts;
  }, [distributorsWithMvno]);

  // Handle filter changes from the filter panel
  const handleBoxFilterChange = (filters: InventoryFilters) => {
    setBoxFilters({
      search: filters.search,
      cartonNumber: filters.cartonNumber,
      boxNumber: filters.boxNumber,
      boxDisplay: filters.boxDisplay,
      iccidFrom: filters.iccidFrom,
      iccidTo: filters.iccidTo,
      mvno: filters.mvno,
      status: filters.status,
    });
  };

  const handleBoxSearch = () => {
    // The hook will automatically refetch when boxFilters change
  };

  const handleBoxClear = () => {
    setBoxFilters({
      search: '',
      cartonNumber: '',
      boxNumber: '',
      boxDisplay: '',
      iccidFrom: '',
      iccidTo: '',
      mvno: '',
      status: '',
    });
  };

  // Handle SIM distribution
  const handleDistribute = (distributor: Distributor) => {
    setSelectedDistributor(distributor);
    setShowBoxSelection(true);
  };

  // Handle successful pick
  const handlePickSuccess = () => {
    setShowBoxSelection(false);
    setSelectedDistributor(null);
    refetch();
  };

  // Format ICCID for display - no spaces between digits
  const formatIccid = (iccid: string) => {
    // Return as-is without any spacing
    return iccid;
  };

  return (
    <div className="app d-flex">
      {/* Sidebar */}
      <nav className="sidebar d-none d-md-flex flex-column p-3" style={{ width: '260px', minHeight: '100vh' }}>
        <div className="mb-4">
          <h4 className="text-white fw-bold">
            <i className="bi bi-sim me-2"></i>
            Hamilton Telecom
          </h4>
          <small className="text-muted-custom">SIM Inventory Management</small>
        </div>
        
        <ul className="nav nav-pills flex-column">
          {/* Common tabs for unauthenticated or basic users */}
          {!isSuperAdmin && platformRole !== 'MVNO_ADMIN' && platformRole !== 'MANAGEMENT' && (
            <>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'dashboard' ? 'active' : ''}`}
                  onClick={() => setActiveTab('dashboard')}
                >
                  <i className="bi bi-grid me-2"></i>
                  Dashboard
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'distribute' ? 'active' : ''}`}
                  onClick={() => setActiveTab('distribute')}
                >
                  <i className="bi bi-box-seam me-2"></i>
                  Distribute SIMs
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'history' ? 'active' : ''}`}
                  onClick={() => setActiveTab('history')}
                >
                  <i className="bi bi-clock-history me-2"></i>
                  Pick History
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'history' ? 'active' : ''}`}
                  onClick={() => setActiveTab('history')}
                >
                  <i className="bi bi-clock-history me-2"></i>
                  Pick History
                </button>
              </li>
            </>
          )}

          {/* Superadmin tabs */}
          {isSuperAdmin && (
            <>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'superadmin' ? 'active' : ''}`}
                  onClick={() => setActiveTab('superadmin')}
                >
                  <i className="bi bi-grid me-2"></i>
                  Dashboard
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'stockrequests' ? 'active' : ''}`}
                  onClick={() => setActiveTab('stockrequests')}
                >
                  <i className="bi bi-file-earmark-plus me-2"></i>
                  Stock Requests
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'approvestock' ? 'active' : ''}`}
                  onClick={() => setActiveTab('approvestock')}
                >
                  <i className="bi bi-check2-square me-2"></i>
                  Approve Stock
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'distributors' ? 'active' : ''}`}
                  onClick={() => setActiveTab('distributors')}
                >
                  <i className="bi bi-people me-2"></i>
                  Distributors
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'history' ? 'active' : ''}`}
                  onClick={() => setActiveTab('history')}
                >
                  <i className="bi bi-clock-history me-2"></i>
                  Pick History
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'distribute' ? 'active' : ''}`}
                  onClick={() => setActiveTab('distribute')}
                >
                  <i className="bi bi-box-seam me-2"></i>
                  Distribute SIMs
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'esim' ? 'active' : ''}`}
                  onClick={() => setActiveTab('esim')}
                >
                  <i className="bi bi-sim me-2"></i>
                  eSIM Stock
                </button>
              </li>
            </>
          )}

          {/* MVNO Admin tabs */}
          {(platformRole === 'MVNO_ADMIN' || platformRole === 'MANAGEMENT') && (
            <>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'superadmin' ? 'active' : ''}`}
                  onClick={() => setActiveTab('superadmin')}
                >
                  <i className="bi bi-grid me-2"></i>
                  Dashboard
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'distributorrequests' ? 'active' : ''}`}
                  onClick={() => setActiveTab('distributorrequests')}
                >
                  <i className="bi bi-person-down me-2"></i>
                  Distributor Requests
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'distributors' ? 'active' : ''}`}
                  onClick={() => setActiveTab('distributors')}
                >
                  <i className="bi bi-people me-2"></i>
                  My Distributors
                </button>
              </li>
              <li className="nav-item">
                <button 
                  className={`nav-link sidebar-link ${activeTab === 'history' ? 'active' : ''}`}
                  onClick={() => setActiveTab('history')}
                >
                  <i className="bi bi-clock-history me-2"></i>
                  Pick History
                </button>
              </li>
            </>
          )}
        </ul>

        <div className="mt-auto pt-3 border-top border-secondary">
          <small className="text-muted-custom">
            <i className="bi bi-database me-1"></i>
            Stock Database Connected
          </small>
          
          {/* Login/Logout Button */}
          <div className="mt-3">
            {isPlatformAuthenticated ? (
              <div>
                <div className="d-flex align-items-center gap-2 mb-2">
                  <i className="bi bi-person-circle text-white"></i>
                  <small className="text-white">{platformUser?.full_name || platformUser?.email}</small>
                </div>
                <button 
                  className="btn btn-sm btn-outline-light w-100"
                  onClick={logout}
                >
                  <i className="bi bi-box-arrow-right me-1"></i>
                  Logout
                </button>
              </div>
            ) : (
              <button 
                className="btn btn-sm btn-accent w-100"
                onClick={() => setShowLogin(true)}
              >
                <i className="bi bi-box-arrow-in-right me-1"></i>
                Login
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-grow-1 p-4" style={{ backgroundColor: 'var(--bg-primary)' }}>
        {/* Header */}
        <header className="d-flex justify-content-between align-items-center mb-4 pb-3 border-bottom border-secondary">
          <div>
            <h2 className="fw-bold mb-0">
              {activeTab === 'dashboard' && 'Stock Dashboard'}
              {activeTab === 'distribute' && 'Distribute SIM Cards'}
              {activeTab === 'history' && 'Distribution History'}
              {activeTab === 'distributors' && 'Distributor Management'}
              {activeTab === 'esim' && 'eSIM Stock Inventory'}
              {activeTab === 'superadmin' && 'Super Admin Dashboard'}
              {activeTab === 'stockrequests' && 'Stock Issuance Requests'}
              {activeTab === 'distributorrequests' && 'Distributor Stock Requests'}
            </h2>
            <small className="text-muted-custom">
              {activeTab === 'dashboard' && 'Overview of SIM card inventory across all MVNOs'}
              {activeTab === 'distribute' && 'Select boxes and distribute SIMs to distributors'}
              {activeTab === 'history' && 'Track SIM distributions and picks'}
              {activeTab === 'distributors' && 'Manage distributor accounts'}
              {activeTab === 'esim' && 'View and manage eSIM inventory for PAXTEL, AGROTEL, SALAMTEL'}
              {activeTab === 'superadmin' && 'Cross-MVNO stock overview and management'}
              {activeTab === 'stockrequests' && 'Request stock from Hamilton with dual approval'}
              {activeTab === 'distributorrequests' && 'Review and approve distributor stock requests'}
            </small>
          </div>
          <button 
            className="btn btn-accent"
            onClick={() => refetch()}
          >
            <i className="bi bi-arrow-clockwise me-2"></i>
            Refresh
          </button>
        </header>

        {/* Error Alert */}
        {error && (
          <div className="alert alert-danger-custom alert-dismissible fade show" role="alert">
            <i className="bi bi-exclamation-triangle me-2"></i>
            {error}
            <button type="button" className="btn-close" onClick={() => {}}></button>
          </div>
        )}

        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <StockDashboard stats={overallStats} mvnos={mvnos} boxes={boxes} />
        )}

        {/* Distribute Tab */}
        {activeTab === 'distribute' && (
          <div className="row">
            <div className="col-12">
              {/* Advanced Filter Panel */}
              <InventoryFilterPanel
                mvnos={mvnos}
                onFilterChange={handleBoxFilterChange}
                onSearch={handleBoxSearch}
                onClear={handleBoxClear}
                loading={boxesLoading}
                resultCount={displayBoxes.length}
                totalCount={totalBoxesCount || boxes.length}
                showIccidRange={true}
              />

              {/* Boxes Table */}
              <div className="card card-custom">
                <div className="card-header card-header-custom">
                  <h5 className="mb-0">
                    <i className="bi bi-box-seam me-2"></i>
                    Available Boxes for Distribution
                  </h5>
                </div>
                <div className="card-body p-0">
                  {loading || boxesLoading ? (
                    <div className="text-center py-5">
                      <div className="spinner-border spinner-custom" role="status">
                        <span className="visually-hidden">Loading...</span>
                      </div>
                      <p className="mt-2 text-muted-custom">Loading boxes...</p>
                    </div>
                  ) : displayBoxes.length === 0 ? (
                    <div className="empty-state">
                      <i className="bi bi-inbox fs-1"></i>
                      <p className="mt-2">No boxes found matching your criteria</p>
                    </div>
                  ) : (
                    <div className="table-responsive">
                      <table className="table table-custom table-hover mb-0">
                        <thead>
                          <tr>
                            <th>Carton</th>
                            <th>Box #</th>
                            <th>MVNO</th>
                            <th>ICCID Range</th>
                            <th>Total</th>
                            <th>Remaining</th>
                            <th>Status</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {displayBoxes.map((box) => (
                            <tr key={box.box_id || box.carton_number + '-' + box.box_number}>
                              <td className="mono">{box.carton_number}</td>
                              <td className="fw-bold">
                                {box.box_display || box.box_number}
                                <small className="text-muted d-block" style={{ fontSize: '0.7rem' }}>
                                  {box.mvno}
                                </small>
                              </td>
                              <td>
                                <span className="badge" style={{ backgroundColor: 'var(--brand-primary)' }}>{box.mvno}</span>
                              </td>
                              <td className="mono">
                                <small>
                                  {formatIccid(box.iccid_start)} - {formatIccid(box.iccid_end)}
                                </small>
                              </td>
                              <td>{box.total_sims}</td>
                              <td>
                                <div className="d-flex align-items-center gap-2">
                                  <span className="fw-bold text-success">{box.remaining_sims}</span>
                                  <div className="progress progress-custom" style={{ width: '60px', height: '6px' }}>
                                    <div 
                                      className="progress-bar progress-bar-custom" 
                                      style={{ width: `${box.remaining_percent}%` }}
                                    ></div>
                                  </div>
                                </div>
                              </td>
                              <td>
                                <span className={`badge badge-${box.status.toLowerCase().replace('_', '_')}`}>
                                  {box.status.replace('_', ' ')}
                                </span>
                              </td>
                              <td>
                                {box.remaining_sims > 0 && distributors.length > 0 && (
                                  <div className="dropdown">
                                    <button 
                                      className="btn btn-sm btn-outline-custom dropdown-toggle"
                                      data-bs-toggle="dropdown"
                                    >
                                      Distribute
                                    </button>
                                    <ul className="dropdown-menu dropdown-menu-dark">
                                      {distributors.slice(0, 10).map(dist => (
                                        <li key={dist.id}>
                                          <button 
                                            className="dropdown-item dropdown-item-custom"
                                            onClick={() => {
                                              setSelectedDistributor(dist);
                                              setShowBoxSelection(true);
                                            }}
                                          >
                                            {dist.name}
                                          </button>
                                        </li>
                                      ))}
                                      {distributors.length > 10 && (
                                        <>
                                          <li><hr className="dropdown-divider" /></li>
                                          <li>
                                            <button 
                                              className="dropdown-item dropdown-item-custom text-center"
                                              onClick={() => setActiveTab('distribute')}
                                            >
                                              View all distributors...
                                            </button>
                                          </li>
                                        </>
                                      )}
                                    </ul>
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                <div className="card-footer text-muted-custom">
                  Showing {displayBoxes.length} of {boxes.length} boxes
                  {displayBoxes.length !== boxes.length && (
                    <span className="ms-2">
                      ({boxes.filter(b => b.remaining_sims > 0).length} with remaining SIMs)
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <DistributorHistory 
            history={isSuperAdmin ? history : filteredHistory} 
            loading={loading} 
            distributors={distributors}
            onUpdate={updatePickRecord}
            onRefresh={refetch}
          />
        )}

        {/* Distributors Tab */}
        {activeTab === 'distributors' && (
          <div className="row">
            <div className="col-12">
              <div className="d-flex justify-content-between align-items-center mb-3">
                <h5 className="mb-0">All Distributors</h5>
                <div className="d-flex gap-2">
                  <button 
                    className="btn btn-outline-info btn-sm"
                    onClick={() => {
                      // Show info about generating links
                      alert('To generate a stock request link for a distributor:\n\n1. Find the distributor below\n2. Click the link icon on their card\n3. Generate and copy the unique link\n4. Send it to the distributor');
                    }}
                  >
                    <i className="bi bi-info-circle me-1"></i>
                    How to Generate Links
                  </button>
                  <button 
                    className="btn btn-accent btn-sm"
                    onClick={() => setShowDistributorForm(true)}
                  >
                    <i className="bi bi-plus-lg me-1"></i>
                    Add Distributor
                  </button>
                </div>
              </div>

              {/* MVNO Filter and Stats */}
              <div className="row g-3 mb-3">
                <div className="col-md-4">
                  <select
                    className="form-select form-select-custom"
                    value={distributorMvnoFilter}
                    onChange={(e) => setDistributorMvnoFilter(e.target.value)}
                  >
                    <option value="">All MVNOs</option>
                    {mvnos.map(m => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
                <div className="col-md-8">
                  <div className="d-flex flex-wrap gap-2">
                    {mvnos.map(m => {
                      const count = distributorCountByMvno[m.name] || 0;
                      return (
                        <div key={m.id} className="badge bg-dark-subtle text-dark p-2">
                          <span className="me-1">{m.name}:</span>
                          <strong>{count}</strong>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
              
              {loading ? (
                <div className="text-center py-5">
                  <div className="spinner-border spinner-custom" role="status">
                    <span className="visually-hidden">Loading...</span>
                  </div>
                </div>
              ) : filteredDistributors.length === 0 ? (
                <div className="card card-custom">
                  <div className="card-body text-center py-5">
                    <i className="bi bi-people fs-1 text-muted-custom"></i>
                    <p className="mt-3">
                      {distributorMvnoFilter 
                        ? 'No distributors found for this MVNO'
                        : 'No distributors found'}
                    </p>
                    <button 
                      className="btn btn-accent"
                      onClick={() => setShowDistributorForm(true)}
                    >
                      Add First Distributor
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="row g-3">
                  {filteredDistributors.map(dist => (
                    <div key={dist.id} className="col-md-6 col-lg-4">
                      <div className="card card-custom h-100">
                        <div className="card-body">
                          <div className="d-flex justify-content-between align-items-start mb-2">
                            <h6 className="card-title mb-0">{dist.name}</h6>
                            <span className={`badge badge-${dist.type.toLowerCase().replace('_', '-')}`}>
                              {dist.type.replace('_', ' ')}
                            </span>
                          </div>
                          {dist.mvno_name && (
                            <p className="small mb-2 text-info">
                              <i className="bi bi-network me-1"></i>
                              {dist.mvno_name}
                            </p>
                          )}
                          {dist.location && (
                            <p className="text-muted-custom small mb-2">
                              <i className="bi bi-geo-alt me-1"></i>
                              {dist.location}
                            </p>
                          )}
                          {dist.contact_person && (
                            <p className="small mb-1">
                              <i className="bi bi-person me-2"></i>
                              {dist.contact_person}
                            </p>
                          )}
                          {dist.phone && (
                            <p className="small mb-0">
                              <i className="bi bi-phone me-2"></i>
                              {dist.phone}
                            </p>
                          )}
                        </div>
                        <div className="card-footer bg-transparent border-top-0 d-flex gap-2">
                          <button 
                            className="btn btn-sm btn-outline-custom flex-grow-1"
                            onClick={() => handleDistribute(dist)}
                            disabled={displayBoxes.filter(b => b.remaining_sims > 0).length === 0}
                          >
                            <i className="bi bi-box-seam me-1"></i>
                            Distribute SIMs
                          </button>
                          <button 
                            className="btn btn-sm btn-outline-secondary"
                            onClick={() => {
                              setEditingDistributor(dist);
                              setShowDistributorForm(true);
                            }}
                            title="Edit Distributor"
                          >
                            <i className="bi bi-pencil"></i>
                          </button>
                          <button 
                            className="btn btn-sm btn-outline-info"
                            onClick={() => {
                              setLinkGeneratorDistributor(dist);
                              setShowLinkGenerator(true);
                            }}
                            title="Generate Stock Request Link"
                          >
                            <i className="bi bi-link-45deg me-1"></i>
                            Link
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="card-footer text-muted-custom mt-3">
                  Showing {filteredDistributors.length} of {distributors.length} distributors
                  {distributorMvnoFilter && (
                    <span className="ms-2">
                      (filtered by MVNO)
                    </span>
                  )}
                </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* eSIM Tab */}
        {activeTab === 'esim' && (
          <EsimStockView mvnos={mvnos} />
        )}

        {/* Dashboard Tab (varies by role) */}
        {activeTab === 'superadmin' && (
          isSuperAdmin ? (
            <SuperAdminDashboard />
          ) : (
            <MVNOAdminDashboard user={platformUser!} />
          )
        )}

        {/* Stock Issuance Requests Tab */}
        {activeTab === 'stockrequests' && (
          <StockIssuanceRequests mvnoId={platformUser?.mvno_id || undefined} showAll={isSuperAdmin} />
        )}

        {/* Approve Stock Tab */}
        {activeTab === 'approvestock' && (
          <ApproveStock />
        )}

        {/* Distributor Stock Requests Tab */}
        {(activeTab === 'distributorrequests') && (
          <DistributorStockRequests mvnoId={platformUser?.mvno_id || undefined} showAll={isSuperAdmin} />
        )}
      </main>

      {/* Distributor Form Modal */}
      {(showDistributorForm) && (
        <div className="modal fade show d-block" tabIndex={-1} style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content modal-custom">
              <div className="modal-header">
                <h5 className="modal-title">{editingDistributor ? 'Edit Distributor' : 'Add New Distributor'}</h5>
                <button 
                  type="button" 
                  className="btn-close btn-close-white"
                  onClick={() => {
                    setShowDistributorForm(false);
                    setEditingDistributor(null);
                  }}
                ></button>
              </div>
              <div className="modal-body">
                <DistributorForm 
                  initial={editingDistributor}
                  mvnos={mvnos}
                  onSuccess={() => {
                    setShowDistributorForm(false);
                    setEditingDistributor(null);
                    refetch();
                  }}
                  onCancel={() => {
                    setShowDistributorForm(false);
                    setEditingDistributor(null);
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Box Selection Modal */}
      {showBoxSelection && selectedDistributor && (
        <DistributeSimsModal
          distributor={selectedDistributor}
          onSuccess={handlePickSuccess}
          onCancel={() => {
            setShowBoxSelection(false);
            setSelectedDistributor(null);
          }}
        />
      )}

      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />

      {showLinkGenerator && linkGeneratorDistributor && (
        <RequestLinkGenerator
          distributor={linkGeneratorDistributor}
          mvnos={mvnos}
          onClose={() => {
            setShowLinkGenerator(false);
            setLinkGeneratorDistributor(null);
          }}
          onLinkGenerated={(msg) => {
            console.log(msg);
            refetch();
          }}
        />
      )}
    </div>
  );
}

export default App;
