import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { Distributor, Mvno, DistributorType } from '../types/simcard';

interface DistributorFormProps {
  initial?: Distributor | null;
  mvnos: Mvno[];
  onSuccess: () => void;
  onCancel: () => void;
}

const DISTRIBUTOR_TYPES: DistributorType[] = [
  'SERVICE_CENTER',
  'CHANNEL_PARTNER',
  'INDIVIDUAL',
  'MANAGEMENT',
  'DISTRIBUTOR',
  'AGENT',
  'RETAILER',
  'WHOLESALER',
  'EMPLOYEE',
  'OTHER'
];

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
  { name: 'Kalangala', lat: -0.9833, lng: 32.2333 },
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
  { name: 'Other', lat: 0.0, lng: 32.0 }
];

export function DistributorForm({ initial, mvnos, onSuccess, onCancel }: DistributorFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<DistributorType>(initial?.type ?? 'DISTRIBUTOR');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [region, setRegion] = useState(initial?.region ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [contactPhone, setContactPhone] = useState(initial?.contact_phone ?? '');
  const [latitude, setLatitude] = useState<number | ''>(initial?.latitude ?? '');
  const [longitude, setLongitude] = useState<number | ''>(initial?.longitude ?? '');
  const [mvnoId, setMvnoId] = useState(initial?.mvno_id ?? '');
  const [contactPerson, setContactPerson] = useState(initial?.contact_person ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle region selection and auto-fill coordinates
  const handleRegionChange = (selectedRegion: string) => {
    setRegion(selectedRegion);
    const regionData = UGANDA_REGIONS.find(r => r.name === selectedRegion);
    if (regionData) {
      setLatitude(regionData.lat);
      setLongitude(regionData.lng);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    if (!name.trim()) {
      setError('Distributor name is required');
      return;
    }

    setSubmitting(true);
    try {
      const data = {
        name: name.trim(),
        type,
        location: location.trim() || null,
        region: region || null,
        address: address.trim() || null,
        contact_phone: contactPhone.trim() || null,
        latitude: latitude || null,
        longitude: longitude || null,
        mvno_id: mvnoId || null,
        contact_person: contactPerson.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
        is_active: true
      };

      let result;
      if (initial) {
        result = await supabase
          .from('distributors')
          .update(data)
          .eq('id', initial.id);
      } else {
        result = await supabase
          .from('distributors')
          .insert(data);
      }

      if (result.error) {
        throw result.error;
      }

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save distributor');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {error && (
        <div className="alert alert-danger-custom alert-dismissible fade show" role="alert">
          {error}
          <button type="button" className="btn-close" onClick={() => setError(null)}></button>
        </div>
      )}

      <div className="mb-3">
        <label className="form-label">Distributor Name *</label>
        <input
          type="text"
          className="form-control form-control-custom"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter distributor name"
          required
        />
      </div>

      <div className="mb-3">
        <label className="form-label">Type *</label>
        <select
          className="form-select form-select-custom"
          value={type}
          onChange={(e) => setType(e.target.value as DistributorType)}
          required
        >
          {DISTRIBUTOR_TYPES.map(t => (
            <option key={t} value={t}>{t.replace('_', ' ')}</option>
          ))}
        </select>
      </div>

      <div className="mb-3">
        <label className="form-label">MVNO</label>
        <select
          className="form-select form-select-custom"
          value={mvnoId}
          onChange={(e) => setMvnoId(e.target.value)}
        >
          <option value="">Select MVNO (optional)</option>
          {mvnos.map(m => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      </div>

      <div className="mb-3">
        <label className="form-label">Location</label>
        <input
          type="text"
          className="form-control form-control-custom"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="e.g., Kampala, Masaka"
        />
      </div>

      <div className="mb-3">
        <label className="form-label">Region</label>
        <select
          className="form-select form-select-custom"
          value={region}
          onChange={(e) => handleRegionChange(e.target.value)}
        >
          <option value="">Select Region</option>
          {UGANDA_REGIONS.map(r => (
            <option key={r.name} value={r.name}>{r.name}</option>
          ))}
        </select>
      </div>

      <div className="mb-3">
        <label className="form-label">Address</label>
        <input
          type="text"
          className="form-control form-control-custom"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Full address"
        />
      </div>

      <div className="row mb-3">
        <div className="col-6">
          <label className="form-label">Latitude</label>
          <input
            type="number"
            step="0.00000001"
            className="form-control form-control-custom"
            value={latitude}
            onChange={(e) => setLatitude(e.target.value ? parseFloat(e.target.value) : '')}
            placeholder="0.000000"
          />
        </div>
        <div className="col-6">
          <label className="form-label">Longitude</label>
          <input
            type="number"
            step="0.00000001"
            className="form-control form-control-custom"
            value={longitude}
            onChange={(e) => setLongitude(e.target.value ? parseFloat(e.target.value) : '')}
            placeholder="0.000000"
          />
        </div>
      </div>

      <div className="row mb-3">
        <div className="col-6">
          <label className="form-label">Contact Person</label>
          <input
            type="text"
            className="form-control form-control-custom"
            value={contactPerson}
            onChange={(e) => setContactPerson(e.target.value)}
            placeholder="Primary contact name"
          />
        </div>
        <div className="col-6">
          <label className="form-label">Contact Phone</label>
          <input
            type="tel"
            className="form-control form-control-custom"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="+256..."
          />
        </div>
      </div>

      <div className="row mb-3">
        <div className="col-6">
          <label className="form-label">Phone</label>
          <input
            type="tel"
            className="form-control form-control-custom"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+256..."
          />
        </div>
        <div className="col-6">
          <label className="form-label">Email</label>
          <input
            type="email"
            className="form-control form-control-custom"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@example.com"
          />
        </div>
      </div>

      <div className="mb-3">
        <label className="form-label">Notes</label>
        <textarea
          className="form-control form-control-custom"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Additional notes..."
        />
      </div>

      <div className="d-flex justify-content-end gap-2">
        <button type="button" className="btn btn-outline-custom" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-accent" disabled={submitting}>
          {submitting ? 'Saving...' : initial ? 'Update' : 'Add'} Distributor
        </button>
      </div>
    </form>
  );
}
