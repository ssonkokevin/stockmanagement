import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { 
  Box, 
  BoxStockSummary, 
  Distributor, 
  Mvno, 
  StockDistribution,
  DistributionDetail,
  BoxPickRecord,
  CurrentStock,
  DistributorPickHistory,
  SimStatus
} from '../types/simcard';

// Hook for boxes with ICCID ranges
export function useBoxes(mvnoId?: string) {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBoxes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('boxes')
        .select('*, mvnos!inner(name)')
        .order('box_number', { ascending: true });

      if (mvnoId) {
        query = query.eq('mvno_id', mvnoId);
      }

      const { data, error: fetchError } = await query;

      if (fetchError) {
        // Fallback without join
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('boxes')
          .select('*')
          .order('box_number', { ascending: true });
        
        if (fallbackError) {
          setError(fallbackError.message);
          setBoxes([]);
        } else {
          setBoxes(fallbackData?.map((b: any) => ({
            ...b,
            mvnos: { name: 'Unknown' }
          })) ?? []);
        }
      } else {
        setBoxes(data ?? []);
      }
    } catch (err) {
      setError('Unexpected error fetching boxes');
      setBoxes([]);
    } finally {
      setLoading(false);
    }
  }, [mvnoId]);

  useEffect(() => {
    fetchBoxes();
  }, [fetchBoxes]);

  return { boxes, loading, error, refetch: fetchBoxes };
}

// Hook for available boxes (with remaining SIMs)
export function useAvailableBoxes(mvnoId?: string) {
  const [boxes, setBoxes] = useState<BoxStockSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBoxes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Use the box_stock_summary view for all boxes
      let query = supabase
        .from('box_stock_summary')
        .select('*')
        .gt('remaining_sims', 0)
        .order('mvno', { ascending: true })
        .order('carton_number', { ascending: true })
        .order('box_number', { ascending: true });

      if (mvnoId) {
        // Get mvno name for filtering
        const { data: mvnoData } = await supabase
          .from('mvnos')
          .select('name')
          .eq('id', mvnoId)
          .single();
        
        if (mvnoData?.name) {
          query = query.eq('mvno', mvnoData.name);
        }
      }

      const { data, error: fetchError } = await query;

      if (fetchError) {
        setError(fetchError.message);
        setBoxes([]);
      } else {
        setBoxes(data ?? []);
      }
    } catch (err) {
      setError('Unexpected error fetching available boxes');
      setBoxes([]);
    } finally {
      setLoading(false);
    }
  }, [mvnoId]);

  useEffect(() => {
    fetchBoxes();
  }, [fetchBoxes]);

  return { boxes, loading, error, refetch: fetchBoxes };
}

// Hook for distributors
export function useDistributors() {
  const [distributors, setDistributors] = useState<Distributor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDistributors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await supabase
        .from('distributors')
        .select('*')
        .eq('is_active', true)
        .order('name', { ascending: true });

      if (fetchError) {
        setError(fetchError.message);
        setDistributors([]);
      } else {
        setDistributors(data ?? []);
      }
    } catch (err) {
      setError('Unexpected error fetching distributors');
      setDistributors([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDistributors();
  }, [fetchDistributors]);

  return { distributors, loading, error, refetch: fetchDistributors };
}

// Hook for MVNOs
export function useMvnos() {
  const [mvnos, setMvnos] = useState<Mvno[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMvnos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await supabase
        .from('mvnos')
        .select('*')
        .order('name', { ascending: true });

      if (fetchError) {
        setError(fetchError.message);
        setMvnos([]);
      } else {
        setMvnos(data ?? []);
      }
    } catch (err) {
      setError('Unexpected error fetching MVNOs');
      setMvnos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMvnos();
  }, [fetchMvnos]);

  return { mvnos, loading, error, refetch: fetchMvnos };
}

// ============================================
// ESIM Stock with Advanced Filters
// ============================================

export interface EsimFilters {
  search: string;
  cartonNumber: string;
  boxNumber: string;
  iccidFrom: string;
  iccidTo: string;
  mvno: string;
  status: string;
}

interface EsimStockItem {
  id: number;
  operator: string;
  imsi: string;
  iccid: string;
  status: string;
  created_at: string;
  carton_number: string | null;
  box_number: string | null;
  mvno: string | null;
}

export function useEsimStock(filters: EsimFilters) {
  const [esimStock, setEsimStock] = useState<EsimStockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  const fetchEsimStock = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // First get total count
      const { count } = await supabase
        .from('esim_stock')
        .select('*', { count: 'exact', head: true });
      
      setTotalCount(count || 0);

      // Build query with filters
      let query = supabase
        .from('esim_stock')
        .select('*')
        .order('created_at', { ascending: false });

      // Apply filters
      if (filters.mvno) {
        query = query.ilike('operator', filters.mvno);
      }

      if (filters.status) {
        query = query.eq('status', filters.status);
      }

      if (filters.cartonNumber) {
        query = query.ilike('carton_number', `%${filters.cartonNumber}%`);
      }

      if (filters.boxNumber) {
        query = query.ilike('box_number', `%${filters.boxNumber}%`);
      }

      if (filters.search) {
        const searchTerm = `%${filters.search}%`;
        query = query.or(`iccid.ilike.${searchTerm},imsi.ilike.${searchTerm}`);
      }

      // ICCID range filter or single ICCID filter
      if (filters.iccidFrom && filters.iccidTo) {
        // For ICCID range, we need to filter in memory since it's text
        const { data: allData, error: fetchError } = await query;
        
        if (fetchError) {
          setError(fetchError.message);
          setEsimStock([]);
        } else {
          const filteredData = (allData || []).filter(item => {
            const iccid = item.iccid || '';
            return iccid >= filters.iccidFrom && iccid <= filters.iccidTo;
          });
          setEsimStock(filteredData);
        }
      } else if (filters.iccidFrom) {
        // Single ICCID filter
        query = query.ilike('iccid', `%${filters.iccidFrom}%`);
        const { data, error: fetchError } = await query;
        
        if (fetchError) {
          setError(fetchError.message);
          setEsimStock([]);
        } else {
          setEsimStock(data || []);
        }
      } else {
        const { data, error: fetchError } = await query;
        
        if (fetchError) {
          setError(fetchError.message);
          setEsimStock([]);
        } else {
          setEsimStock(data || []);
        }
      }
    } catch (err) {
      setError('Unexpected error fetching eSIM stock');
      setEsimStock([]);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchEsimStock();
  }, [fetchEsimStock]);

  return { esimStock, loading, error, totalCount, refetch: fetchEsimStock };
}

// ============================================
// Box Stock with Advanced Filters
// ============================================

export interface BoxFilters {
  search: string;
  cartonNumber: string;
  boxNumber: string;
  boxDisplay: string;
  iccidFrom: string;
  iccidTo: string;
  mvno: string;
  status: string;
}

export function useFilteredBoxes(filters: BoxFilters) {
  const [boxes, setBoxes] = useState<BoxStockSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  const fetchBoxes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // First get total count
      const { count } = await supabase
        .from('box_stock_summary')
        .select('*', { count: 'exact', head: true });
      
      setTotalCount(count || 0);

      // Build query with filters
      let query = supabase
        .from('box_stock_summary')
        .select('*')
        .order('mvno', { ascending: true })
        .order('carton_number', { ascending: true })
        .order('box_number', { ascending: true });

      // Apply filters
      if (filters.mvno) {
        query = query.eq('mvno', filters.mvno);
      }

      if (filters.status) {
        query = query.eq('status', filters.status);
      }

      if (filters.cartonNumber) {
        query = query.ilike('carton_number', `%${filters.cartonNumber}%`);
      }

      if (filters.boxNumber) {
        // Handle both number and range formats (e.g., "5" or "1-50")
        if (filters.boxNumber.includes('-')) {
          const [from, to] = filters.boxNumber.split('-').map(n => parseInt(n.trim()));
          if (!isNaN(from) && !isNaN(to)) {
            query = query.gte('box_number', from).lte('box_number', to);
          }
        } else {
          const boxNum = parseInt(filters.boxNumber);
          if (!isNaN(boxNum)) {
            query = query.eq('box_number', boxNum);
          }
        }
      }

      if (filters.boxDisplay) {
        query = query.ilike('box_display', `%${filters.boxDisplay}%`);
      }

      if (filters.search) {
        const searchTerm = `%${filters.search}%`;
        query = query.or(`iccid_start.ilike.${searchTerm},iccid_end.ilike.${searchTerm},carton_number.ilike.${searchTerm},box_display.ilike.${searchTerm}`);
      }

      const { data, error: fetchError } = await query;
      
      if (fetchError) {
        setError(fetchError.message);
        setBoxes([]);
      } else {
        let filteredData = data || [];

        // ICCID range filter (needs to be done in memory for text comparison)
        if (filters.iccidFrom && filters.iccidTo) {
          filteredData = filteredData.filter(box => {
            const iccidStart = box.iccid_start || '';
            return iccidStart >= filters.iccidFrom && iccidStart <= filters.iccidTo;
          });
        }

        setBoxes(filteredData);
      }
    } catch (err) {
      setError('Unexpected error fetching boxes');
      setBoxes([]);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchBoxes();
  }, [fetchBoxes]);

  return { boxes, loading, error, totalCount, refetch: fetchBoxes };
}

// Hook for stock distributions
export function useStockDistributions(distributorId?: string) {
  const [distributions, setDistributions] = useState<StockDistribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDistributions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('stock_distributions')
        .select('*')
        .order('created_at', { ascending: false });

      if (distributorId) {
        query = query.eq('distributor_id', distributorId);
      }

      const { data, error: fetchError } = await query;

      if (fetchError) {
        setError(fetchError.message);
        setDistributions([]);
      } else {
        setDistributions(data ?? []);
      }
    } catch (err) {
      setError('Unexpected error fetching distributions');
      setDistributions([]);
    } finally {
      setLoading(false);
    }
  }, [distributorId]);

  useEffect(() => {
    fetchDistributions();
  }, [fetchDistributions]);

  // Subscribe to realtime changes
  useEffect(() => {
    const channel = supabase
      .channel('stock_distributions-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_distributions' }, () => {
        fetchDistributions();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchDistributions]);

  return { distributions, loading, error, refetch: fetchDistributions };
}

// Hook for picking SIMs from a box
export function usePickSims() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickSims = async (
    boxId: string, 
    distributorId: string, 
    quantity: number,
    purpose?: string
  ): Promise<{ success: boolean; message: string }> => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('pick_sims_from_box', {
        p_box_id: boxId,
        p_distributor_id: distributorId,
        p_quantity: quantity,
        p_purpose: purpose || null
      });

      if (rpcError) {
        setError(rpcError.message);
        return { success: false, message: rpcError.message };
      }

      if (data && data.length > 0) {
        const result = data[0];
        return { 
          success: result.success, 
          message: result.message 
        };
      }

      return { success: false, message: 'Unknown error occurred' };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to pick SIMs';
      setError(errorMessage);
      return { success: false, message: errorMessage };
    } finally {
      setLoading(false);
    }
  };

  return { pickSims, loading, error };
}

// Hook for updating pick records
export function useUpdatePickRecord() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updatePickRecord = async (
    recordId: string,
    updates: {
      sims_picked?: number;
      iccid_start?: string;
      iccid_end?: string;
      distributor_id?: string;
    }
  ): Promise<{ success: boolean; message: string }> => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: updateError } = await supabase
        .from('box_pick_records')
        .update(updates)
        .eq('id', recordId)
        .select()
        .single();

      if (updateError) {
        setError(updateError.message);
        return { success: false, message: updateError.message };
      }

      return { success: true, message: 'Record updated successfully' };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update record';
      setError(errorMessage);
      return { success: false, message: errorMessage };
    } finally {
      setLoading(false);
    }
  };

  return { updatePickRecord, loading, error };
}

// Hook for stock statistics
export function useStockStats() {
  const [stats, setStats] = useState<{
    physical: CurrentStock[];
    esim: CurrentStock[];
  }>({ physical: [], esim: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // First try fetching from current_stock_view
      const { data, error: fetchError } = await supabase
        .from('current_stock_view')
        .select('*');

      if (fetchError || !data) {
        // Fallback to direct table queries
        await fetchFromTables();
      } else {
        const physical = data?.filter(s => s.sim_type === 'PHYSICAL') ?? [];
        const esim = data?.filter(s => s.sim_type === 'ESIM') ?? [];
        setStats({ physical, esim });
      }
    } catch (err) {
      // Fallback to direct table queries
      await fetchFromTables();
    } finally {
      setLoading(false);
    }
  }, []);

  // Fallback function to fetch directly from tables
  const fetchFromTables = async () => {
    try {
      // Fetch physical SIM stock from boxes - use mvno_id directly
      const { data: boxData, error: boxError } = await supabase
        .from('boxes')
        .select('status, remaining_sims, issued_sims, total_sims, mvno_id');
      
      // Get mvnos for name lookup
      const { data: mvnosData } = await supabase
        .from('mvnos')
        .select('id, name');

      // Create a map of mvno_id to name
      const mvnoMap: Record<string, string> = {};
      if (mvnosData) {
        mvnosData.forEach((m: any) => {
          mvnoMap[m.id] = m.name;
        });
      }
      
      // Fetch eSIM stock
      const { data: esimData } = await supabase
        .from('esim_stock')
        .select('operator, status');

      // Calculate physical SIM stats - use mvno_id directly
      let physicalTotal = 0, physicalRemaining = 0, physicalIssued = 0;
      const physicalByMvno: Record<string, { total: number; remaining: number; issued: number }> = {};
      
      if (boxData && !boxError) {
        boxData.forEach((box: any) => {
          const total = box.total_sims || 0;
          const remaining = box.remaining_sims || total;
          const issued = box.issued_sims || 0;
          
          // Get MVNO name from mvno_id directly
          const mvnoName = mvnoMap[box.mvno_id] || 'Unknown';
          
          if (!physicalByMvno[mvnoName]) {
            physicalByMvno[mvnoName] = { total: 0, remaining: 0, issued: 0 };
          }
          physicalByMvno[mvnoName].total += total;
          physicalByMvno[mvnoName].remaining += remaining;
          physicalByMvno[mvnoName].issued += issued;
          
          physicalTotal += total;
          physicalRemaining += remaining;
          physicalIssued += issued;
        });
      }

      // Calculate eSIM stats
      let esimTotal = 0, esimAvailable = 0, esimAssigned = 0, esimActivated = 0;
      const esimByOperator: Record<string, { total: number; available: number; assigned: number; activated: number }> = {};
      
      if (esimData) {
        esimData.forEach((esim: any) => {
          const operator = esim.operator || 'Unknown';
          
          if (!esimByOperator[operator]) {
            esimByOperator[operator] = { total: 0, available: 0, assigned: 0, activated: 0 };
          }
          
          esimByOperator[operator].total++;
          esimTotal++;
          
          if (esim.status === 'available') {
            esimByOperator[operator].available++;
            esimAvailable++;
          } else if (esim.status === 'assigned') {
            esimByOperator[operator].assigned++;
            esimAssigned++;
          } else if (esim.status === 'activated') {
            esimByOperator[operator].activated++;
            esimActivated++;
          }
        });
      }

      // Build physical stock array
      const physical: CurrentStock[] = [
        { mvno: 'TOTAL', sim_type: 'PHYSICAL', total_stock: physicalTotal, in_store: physicalRemaining, issued: physicalIssued, activated: 0, sold: 0, failed: 0 }
      ];
      Object.entries(physicalByMvno).forEach(([mvno, data]) => {
        physical.push({
          mvno,
          sim_type: 'PHYSICAL',
          total_stock: data.total,
          in_store: data.remaining,
          issued: data.issued,
          activated: 0,
          sold: 0,
          failed: 0
        });
      });

      // Build eSIM stock array
      const esim: CurrentStock[] = [
        { mvno: 'TOTAL', sim_type: 'ESIM', total_stock: esimTotal, in_store: esimAvailable, issued: esimAssigned + esimActivated, activated: esimActivated, sold: 0, failed: 0 }
      ];
      Object.entries(esimByOperator).forEach(([operator, data]) => {
        esim.push({
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

      setStats({ physical, esim });
    } catch (err) {
      setError('Failed to fetch stock statistics');
    }
  };

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return { stats, loading, error, refetch: fetchStats };
}

// Hook for distributor pick history
export function useDistributorPickHistory(distributorId?: string) {
  const [history, setHistory] = useState<DistributorPickHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await supabase
        .from('distributor_pick_history_view')
        .select('*')
        .limit(100);

      if (fetchError) {
        // Fallback to box_pick_records - use LEFT joins to not exclude records if joins fail
        const { data: pickData, error: pickError } = await supabase
          .from('box_pick_records')
          .select(`
            id,
            quantity,
            sims_picked,
            iccid_start,
            iccid_end,
            created_at,
            boxes(id, box_number),
            cartons(carton_number, mvno_id),
            distributors(id, name, type)
          `)
          .order('created_at', { ascending: false })
          .limit(100);

        if (pickError) {
          setError(pickError.message);
          setHistory([]);
        } else {
          // Get mvno names separately
          const mvnoIds = [...new Set(pickData?.map((h: any) => h.cartons?.mvno_id).filter(Boolean) || [])];
          let mvnoMap: Record<string, string> = {};
          
          if (mvnoIds.length > 0) {
            const { data: mvnoData } = await supabase
              .from('mvnos')
              .select('id, name')
              .in('id', mvnoIds);
            
            mvnoData?.forEach(m => {
              mvnoMap[m.id] = m.name;
            });
          }
          
          setHistory(pickData?.map((h: any) => ({
            id: h.id,
            distributor_name: h.distributors?.name,
            distributor_type: h.distributors?.type,
            carton_number: h.cartons?.carton_number,
            box_number: h.boxes?.box_number,
            box_display: h.boxes?.box_number ? String(h.boxes?.box_number) : '',
            sims_picked: h.quantity ?? h.sims_picked ?? 0,
            iccid_start: h.iccid_start,
            iccid_end: h.iccid_end,
            pick_date: h.created_at,
            mvno: mvnoMap[h.cartons?.mvno_id] || 'Unknown'
          })) ?? []);
        }
      } else {
        // Add id field from the view if available
        setHistory(data?.map((item: any) => ({
          ...item,
          id: item.id
        })) ?? []);
      }
    } catch (err) {
      setError('Failed to fetch pick history');
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, [distributorId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Subscribe to realtime changes for box_pick_records
  useEffect(() => {
    const channel = supabase
      .channel('box_pick_records-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'box_pick_records' }, () => {
        fetchHistory();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchHistory]);

  return { history, loading, error, refetch: fetchHistory };
}

// Combined hook for SIM card management
export function useSimcards() {
  const { boxes, loading: boxesLoading, error: boxesError, refetch: refetchBoxes } = useAvailableBoxes();
  const { distributors, loading: distributorsLoading, error: distributorsError, refetch: refetchDistributors } = useDistributors();
  const { mvnos, loading: mvnosLoading, error: mvnosError, refetch: refetchMvnos } = useMvnos();
  const { distributions, loading: distributionsLoading, error: distributionsError, refetch: refetchDistributions } = useStockDistributions();
  const { stats, loading: statsLoading, error: statsError, refetch: refetchStats } = useStockStats();
  const { history, loading: historyLoading, error: historyError, refetch: refetchHistory } = useDistributorPickHistory();
  const { pickSims, loading: pickingLoading, error: pickingError } = usePickSims();

  const loading = boxesLoading || distributorsLoading || mvnosLoading || distributionsLoading || statsLoading || historyLoading;
  const error = boxesError || distributorsError || mvnosError || distributionsError || statsError || historyError || pickingError;

  const refetch = () => {
    refetchBoxes();
    refetchDistributors();
    refetchMvnos();
    refetchDistributions();
    refetchStats();
    refetchHistory();
  };

  return {
    boxes,
    distributors,
    mvnos,
    distributions,
    stats,
    history,
    loading,
    error,
    pickSims,
    pickingLoading,
    refetch
  };
}
