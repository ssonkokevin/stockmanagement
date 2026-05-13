import { useQuery } from '@tanstack/react-query';
import { fetchDashboardStats } from '../services/api';

export function useDashboardStats() {
  return useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: fetchDashboardStats,
    refetchInterval: 60_000,
  });
}

