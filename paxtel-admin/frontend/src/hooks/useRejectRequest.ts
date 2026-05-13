import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rejectRequest } from '../services/api';
import { toast } from 'react-hot-toast';

export function useRejectRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => rejectRequest(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sim-requests'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      toast.success('Request rejected.');
    },
    onError: (err: any) => toast.error(err?.message || 'Failed to reject request'),
  });
}

