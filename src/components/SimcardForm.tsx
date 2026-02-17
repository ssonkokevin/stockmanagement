import { useState } from 'react';
import type { Simcard, SimcardInsert } from '../types/simcard';

const STATUS_OPTIONS = ['available', 'assigned', 'activated', 'deactivated'] as const;

interface SimcardFormProps {
  initial?: Simcard | null;
  onSubmit: (data: SimcardInsert) => Promise<void>;
  onCancel: () => void;
}

export function SimcardForm({ initial, onSubmit, onCancel }: SimcardFormProps) {
  const [iccid, setIccid] = useState(initial?.iccid ?? '');
  const [phoneNumber, setPhoneNumber] = useState(initial?.phone_number ?? '');
  const [carrier, setCarrier] = useState(initial?.carrier ?? '');
  const [status, setStatus] = useState<typeof STATUS_OPTIONS[number]>(
    initial?.status ?? 'available');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!iccid.trim()) {
      setError('ICCID is required');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        iccid: iccid.trim(),
        phone_number: phoneNumber.trim() || null,
        carrier: carrier.trim() || null,
        status,
        notes: notes.trim() || null,
      });
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="simcard-form">
      <h3>{initial ? 'Edit SIM Card' : 'Add SIM Card'}</h3>
      {error && <div className="form-error">{error}</div>}
      <div className="form-group">
        <label htmlFor="iccid">ICCID *</label>
        <input
          id="iccid"
          type="text"
          value={iccid}
          onChange={(e) => setIccid(e.target.value)}
          placeholder="e.g. 8944110000000000000"
          disabled={!!initial}
        />
      </div>
      <div className="form-group">
        <label htmlFor="phone">Phone Number</label>
        <input
          id="phone"
          type="text"
          value={phoneNumber}
          onChange={(e) => setPhoneNumber(e.target.value)}
          placeholder="+1234567890"
        />
      </div>
      <div className="form-group">
        <label htmlFor="carrier">Carrier</label>
        <input
          id="carrier"
          type="text"
          value={carrier}
          onChange={(e) => setCarrier(e.target.value)}
          placeholder="e.g. AT&T, Vodafone"
        />
      </div>
      <div className="form-group">
        <label htmlFor="status">Status</label>
        <select id="status" value={status} onChange={(e) => setStatus(e.target.value as typeof STATUS_OPTIONS[number])}>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="notes">Notes</label>
        <textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional notes..."
          rows={2}
        />
      </div>
      <div className="form-actions">
        <button type="button" onClick={onCancel} className="btn btn-secondary">
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Saving...' : initial ? 'Update' : 'Add'}
        </button>
      </div>
    </form>
  );
}
