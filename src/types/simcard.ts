export type SimcardStatus = 'available' | 'assigned' | 'activated' | 'deactivated';

export interface Simcard {
  id: string;
  iccid: string;
  phone_number: string | null;
  carrier: string | null;
  status: SimcardStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SimcardInsert {
  iccid: string;
  phone_number?: string | null;
  carrier?: string | null;
  status?: SimcardStatus;
  notes?: string | null;
}

export interface SimcardUpdate {
  iccid?: string;
  phone_number?: string | null;
  carrier?: string | null;
  status?: SimcardStatus;
  notes?: string | null;
}
