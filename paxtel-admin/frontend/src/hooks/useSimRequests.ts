import { useQuery } from '@tanstack/react-query';
import { fetchSimRequests, type FetchSimRequestsParams } from '../services/api';

export function useSimRequests(params: FetchSimRequestsParams) {
  return useQuery({
    queryKey: ['sim-requests', params],
    queryFn: () => fetchSimRequests(params),
  });
}

