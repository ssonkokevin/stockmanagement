import { useEffect, useState, useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import type { Distributor } from '../types/simcard';

// Uganda regions with coordinates
const UGANDA_REGIONS = [
  { name: 'Kampala', lat: 0.3476, lng: 32.5825 },
  { name: 'Wakiso', lat: 0.3644, lng: 32.4793 },
  { name: 'Mukono', lat: 0.3533, lng: 32.7567 },
  { name: 'Jinja', lat: 0.4252, lng: 33.2037 },
  { name: 'Bugiri', lat: 0.5635, lng: 33.7401 },
  { name: 'Busia', lat: 0.4635, lng: 34.1117 },
  { name: 'Soroti', lat: 1.7146, lng: 33.6107 },
  { name: 'Mbale', lat: 1.0823, lng: 34.1713 },
  { name: 'Masaka', lat: 0.3397, lng: 31.7304 },
  { name: 'Rakai', lat: 0.4859, lng: 31.9339 },
  { name: 'Mbarara', lat: -0.6052, lng: 30.6485 },
  { name: 'Bushenyi', lat: -0.5548, lng: 30.0687 },
  { name: 'Kasese', lat: 0.5829, lng: 30.0637 },
  { name: 'Fort Portal', lat: 0.6714, lng: 30.2734 },
  { name: 'Gulu', lat: 2.7746, lng: 32.2990 },
  { name: 'Kitgum', lat: 3.2787, lng: 32.8786 },
  { name: 'Arua', lat: 3.0201, lng: 30.9641 },
  { name: 'Nebbi', lat: 2.4776, lng: 31.1783 },
  { name: 'Lira', lat: 2.3849, lng: 32.8998 },
  { name: 'Moroto', lat: 2.5446, lng: 34.6214 },
  { name: 'Kotido', lat: 3.0176, lng: 33.9699 },
];

// Uganda center coordinates
const UGANDA_CENTER: [number, number] = [1.3733, 32.2903];
const DEFAULT_ZOOM = 7;

// Color scale based on distributor count
const getShadingColor = (count: number, maxCount: number): string => {
  if (count === 0) return '#6B6966'; // Gray for no distributors
  const intensity = Math.min(count / maxCount, 1);
  
  // Green gradient from light to dark based on intensity
  if (intensity < 0.25) return '#8FD4C0'; // Light green
  if (intensity < 0.5) return '#5A9E8F';  // Medium light green
  if (intensity < 0.75) return '#3F7F6F';  // Brand green
  return '#2F5F52';                         // Dark green
};

const getOpacity = (count: number, maxCount: number): number => {
  if (count === 0) return 0.3;
  return 0.4 + (Math.min(count / maxCount, 1) * 0.4); // 0.4 to 0.8
};

interface DistributorMapProps {
  distributors: Distributor[];
}

export function DistributorMap({ distributors }: DistributorMapProps) {
  const [showRegions, setShowRegions] = useState(true);
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null);

  // Calculate region statistics
  const regionStats = useMemo(() => {
    const stats: Record<string, { count: number; distributors: Distributor[] }> = {};
    
    // Initialize all regions
    UGANDA_REGIONS.forEach(r => {
      stats[r.name] = { count: 0, distributors: [] };
    });
    
    // Count distributors per region
    distributors.forEach(d => {
      const region = d.region || 'Unknown';
      if (!stats[region]) {
        stats[region] = { count: 0, distributors: [] };
      }
      stats[region].count++;
      stats[region].distributors.push(d);
    });
    
    return stats;
  }, [distributors]);

  // Get max count for color scaling
  const maxCount = useMemo(() => {
    return Math.max(...Object.values(regionStats).map(r => r.count), 1);
  }, [regionStats]);

  // Get distributors for selected region
  const selectedRegionDistributors = useMemo(() => {
    if (!selectedRegion) return [];
    return regionStats[selectedRegion]?.distributors || [];
  }, [selectedRegion, regionStats]);

  const totalDistributors = distributors.length;
  const regionsWithDistributors = Object.values(regionStats).filter(r => r.count > 0).length;

  return (
    <div className="card card-custom">
      <div className="card-header card-header-custom">
        <div className="d-flex justify-content-between align-items-center">
          <h5 className="mb-0">
            <i className="bi bi-grid-3x3 me-2"></i>
            Distributor Coverage Map
          </h5>
          <div className="form-check form-switch">
            <input 
              className="form-check-input" 
              type="checkbox" 
              id="showRegions"
              checked={showRegions}
              onChange={(e) => setShowRegions(e.target.checked)}
            />
            <label className="form-check-label small" htmlFor="showRegions">
              Show Coverage Areas
            </label>
          </div>
        </div>
      </div>
      <div className="card-body p-0">
        {/* Map */}
        <div style={{ height: '450px', width: '100%' }}>
          <MapContainer
            center={UGANDA_CENTER}
            zoom={DEFAULT_ZOOM}
            style={{ height: '100%', width: '100%' }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            
            {/* Show region shading circles */}
            {showRegions && UGANDA_REGIONS.map(region => {
              const stats = regionStats[region.name] || { count: 0 };
              const isSelected = selectedRegion === region.name;
              
              return (
                <CircleMarker
                  key={region.name}
                  center={[region.lat, region.lng]}
                  radius={isSelected ? 35 : 25}
                  pathOptions={{
                    fillColor: getShadingColor(stats.count, maxCount),
                    fillOpacity: getOpacity(stats.count, maxCount),
                    color: isSelected ? '#F0A326' : '#3F7F6F',
                    weight: isSelected ? 3 : 1,
                  }}
                  eventHandlers={{
                    click: () => setSelectedRegion(
                      selectedRegion === region.name ? null : region.name
                    ),
                  }}
                >
                  <Popup>
                    <div style={{ minWidth: '180px' }}>
                      <h6 className="mb-2" style={{ color: '#2D2A26' }}>
                        {region.name} Region
                      </h6>
                      <div className="d-flex justify-content-between mb-1">
                        <span className="text-muted">Distributors:</span>
                        <strong style={{ color: stats.count > 0 ? '#3F7F6F' : '#6B6966' }}>
                          {stats.count}
                        </strong>
                      </div>
                      {stats.count > 0 && (
                        <div className="mt-2 pt-2 border-top">
                          <small className="text-muted">Click to see distributors</small>
                        </div>
                      )}
                    </div>
                  </Popup>
                </CircleMarker>
              );
            })}
          </MapContainer>
        </div>

        {/* Selected Region Details */}
        {selectedRegion && (
          <div className="p-3 border-top" style={{ backgroundColor: '#F4F4F2' }}>
            <div className="d-flex justify-content-between align-items-center mb-2">
              <h6 className="mb-0" style={{ color: '#2D2A26' }}>
                {selectedRegion} - Distributors ({selectedRegionDistributors.length})
              </h6>
              <button 
                className="btn btn-sm btn-outline-secondary"
                onClick={() => setSelectedRegion(null)}
              >
                Close
              </button>
            </div>
            <div className="row g-2">
              {selectedRegionDistributors.map(d => (
                <div key={d.id} className="col-md-6 col-lg-4">
                  <div className="p-2 rounded" style={{ backgroundColor: 'white', border: '1px solid #E0DDD9' }}>
                    <div className="fw-semibold" style={{ color: '#2D2A26' }}>{d.name}</div>
                    <small className="text-muted">
                      {d.type?.replace('_', ' ')} • {d.contact_phone || 'No contact'}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Legend and Summary */}
        <div className="p-3 border-top" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
          <div className="row align-items-center">
            <div className="col-md-6">
              <h6 className="mb-2">Coverage Legend</h6>
              <div className="d-flex align-items-center gap-3">
                <div className="d-flex align-items-center gap-1">
                  <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: '#8FD4C0' }}></div>
                  <small>1-25%</small>
                </div>
                <div className="d-flex align-items-center gap-1">
                  <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: '#5A9E8F' }}></div>
                  <small>26-50%</small>
                </div>
                <div className="d-flex align-items-center gap-1">
                  <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: '#3F7F6F' }}></div>
                  <small>51-75%</small>
                </div>
                <div className="d-flex align-items-center gap-1">
                  <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: '#2F5F52' }}></div>
                  <small>76-100%</small>
                </div>
              </div>
            </div>
            <div className="col-md-6 text-md-end mt-2 mt-md-0">
              <small className="text-muted">
                <strong style={{ color: '#3F7F6F' }}>{totalDistributors}</strong> total distributors
                <span className="mx-2">|</span>
                <strong style={{ color: '#3F7F6F' }}>{regionsWithDistributors}</strong> regions covered
              </small>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
