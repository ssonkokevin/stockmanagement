import { useMutation, useQueryClient } from '@tanstack/react-query';
import { approveRequest } from '../services/api';
import { toast } from 'react-hot-toast';

export function useApproveRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) => approveRequest(id, notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sim-requests'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      toast.success('Request approved. Stock updated.');
    },
    onError: (err: any) => toast.error(err?.message || 'Failed to approve request'),
  });
}

