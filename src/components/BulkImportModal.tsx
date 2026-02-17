import { useState } from 'react';
import type { SimcardInsert } from '../types/simcard';

const STATUS_OPTIONS = ['available', 'assigned', 'activated', 'deactivated'] as const;

interface BulkImportModalProps {
  onImport: (rows: SimcardInsert[]) => Promise<void>;
  onCancel: () => void;
}

export function BulkImportModal({ onImport, onCancel }: BulkImportModalProps) {
  const [text, setText] = useState('');
  const [defaultStatus, setDefaultStatus] = useState<SimcardInsert['status']>('available');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SimcardInsert[] | null>(null);

  const parseCsv = (input: string): SimcardInsert[] => {
    const lines = input.trim().split(/\r?\n/).filter(Boolean);
    const rows: SimcardInsert[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split(',').map((p) => p.trim());
      const iccid = parts[0] || '';
      if (!iccid) continue;
      const phone = parts[1] || null;
      const carrier = parts[2] || null;
      const status = (parts[3]?.toLowerCase() || defaultStatus) as SimcardInsert['status'];
      const notes = parts[4] || null;
      if (!STATUS_OPTIONS.includes(status as (typeof STATUS_OPTIONS)[number])) continue;
      rows.push({
        iccid,
        phone_number: phone,
        carrier: carrier,
        status: status as SimcardInsert['status'],
        notes,
      });
    }
    return rows;
  };

  const handlePreview = () => {
    setError(null);
    try {
      const parsed = parseCsv(text);
      if (parsed.length === 0) {
        setError('No valid rows. Format: ICCID, Phone (opt), Carrier (opt), Status (opt), Notes (opt)');
        setPreview(null);
      } else {
        setPreview(parsed);
      }
    } catch {
      setError('Invalid CSV format');
      setPreview(null);
    }
  };

  const handleImport = async () => {
    const rows = preview ?? parseCsv(text);
    if (rows.length === 0) {
      setError('No valid rows to import');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onImport(rows);
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bulk-import-modal">
      <h3>Bulk Import SIM Cards</h3>
      <p className="text-secondary">
        Paste CSV: ICCID, Phone (optional), Carrier (optional), Status (optional), Notes (optional)
      </p>
      <div className="form-group">
        <label htmlFor="default-status">Default status for rows without one</label>
        <select
          id="default-status"
          value={defaultStatus}
          onChange={(e) => setDefaultStatus(e.target.value as SimcardInsert['status'])}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="bulk-csv">CSV data</label>
        <textarea
          id="bulk-csv"
          rows={8}
          placeholder="8944110000000000000,+1234567890,AT&T,available,Note&#10;8944110000000000001,,Vodafone,available,"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
          className="mono"
        />
      </div>
      {error && <div className="form-error">{error}</div>}
      {preview && (
        <div className="import-preview">
          <strong>{preview.length} SIM card(s) ready to import</strong>
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-secondary" onClick={handlePreview}>
          Preview
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleImport}
          disabled={submitting || (!preview && parseCsv(text).length === 0)}
        >
          {submitting ? 'Importing...' : 'Import'}
        </button>
      </div>
    </div>
  );
}
