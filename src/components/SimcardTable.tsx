import type { Simcard, SimcardStatus } from '../types/simcard';

interface SimcardTableProps {
  simcards: Simcard[];
  onEdit: (sim: Simcard) => void;
  onDelete: (sim: Simcard) => void;
  onStatusChange: (sim: Simcard, status: SimcardStatus) => void;
}

const STATUS_COLORS: Record<string, string> = {
  available: 'var(--success)',
  assigned: 'var(--accent)',
  activated: 'var(--accent)',
  deactivated: 'var(--text-secondary)',
};

const STATUS_OPTIONS: SimcardStatus[] = ['available', 'assigned', 'activated', 'deactivated'];

export function SimcardTable({ simcards, onEdit, onDelete, onStatusChange }: SimcardTableProps) {
  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

  return (
    <div className="table-wrapper">
      <table className="simcard-table">
        <thead>
          <tr>
            <th>ICCID</th>
            <th>Phone</th>
            <th>Carrier</th>
            <th>Status</th>
            <th>Added</th>
            <th className="actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {simcards.length === 0 ? (
            <tr>
              <td colSpan={6} className="empty">
                No SIM cards in stock. Add one to get started.
              </td>
            </tr>
          ) : (
            simcards.map((sim) => (
              <tr key={sim.id}>
                <td className="mono">{sim.iccid}</td>
                <td>{sim.phone_number || '—'}</td>
                <td>{sim.carrier || '—'}</td>
                <td>
                  <select
                    className="status-select"
                    value={sim.status}
                    onChange={(e) => onStatusChange(sim, e.target.value as SimcardStatus)}
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{formatDate(sim.created_at)}</td>
                <td className="actions">
                  <button className="btn btn-sm btn-ghost" onClick={() => onEdit(sim)}>
                    Edit
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => onDelete(sim)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
