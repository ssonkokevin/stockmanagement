export declare function savePickFormPDF(data: {
  request_id: string;
  distributor_name: string;
  request_date: string;
  requested_quantity: number;
  assigned_boxes: any[];
  approved_by_l1_email?: string | null;
  approved_by_l2_email?: string | null;
  approved_by_l3_email?: string | null;
  issued_by: string;
  form_title: string;
  sim_type: string;
  esim_iccids?: string[];
}): Promise<string | null>;

export declare function generatePickFormPdf(data: {
  outDir: string;
  filename: string;
  html: string;
}): Promise<void>;
