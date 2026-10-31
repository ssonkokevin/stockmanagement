import puppeteer, { Browser, Page } from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';

interface BoxDetails {
  box_id: string;
  carton_number?: string;
  box_number?: string;
  box_display?: string;
  msisdn_start?: string;
  msisdn_end?: string;
  total_sims?: number;
  sims_picked?: number;
}

interface PickFormData {
  request_id: string;
  distributor_name: string;
  request_date: string;
  requested_quantity: number;
  assigned_boxes: BoxDetails[];
  approved_by_l1_email?: string | null;
  approved_by_l2_email?: string | null;
  approved_by_l3_email?: string | null;
  issued_by?: string | null;
  picked_by_name?: string | null;
  form_title?: string;
  sim_type?: 'PHYSICAL' | 'ESIM';
  esim_iccids?: string[];
  contact_person?: string | null;
  contact_email?: string | null;
  signature?: string | null;
}

async function getBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
}

function escapeHtml(text: string | undefined): string {
  if (!text) return 'N/A';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generatePickFormHTML(data: PickFormData): string {
  const shortRequestId = data.request_id ? data.request_id.slice(0, 8).toUpperCase() : 'N/A';
  const isEsim = data.sim_type === 'ESIM';
  const boxesHTML = data.assigned_boxes
    .map((box: BoxDetails, index: number) => {
      return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(box.carton_number)}</td>
        <td>${escapeHtml(box.box_display || box.box_number || box.box_id)}</td>
        <td>${escapeHtml(box.msisdn_start)}</td>
        <td>${escapeHtml(box.msisdn_end)}</td>
        <td>${box.total_sims ?? 'N/A'}</td>
        <td>${box.sims_picked ?? box.total_sims ?? 'N/A'}</td>
      </tr>`;
    })
    .join('');

  const esimRows = (data.esim_iccids || [])
    .map((iccid, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(iccid)}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(data.form_title || 'Pick Form')} - Request #${escapeHtml(shortRequestId)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 12px; padding: 20px; color: #333; }
    .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #333; padding-bottom: 15px; }
    .header h1 { font-size: 24px; margin-bottom: 5px; }
    .header .subtitle { font-size: 14px; color: #666; }
    .info-section { display: flex; justify-content: space-between; margin-bottom: 30px; }
    .info-box { flex: 1; border: 1px solid #ddd; padding: 15px; margin-right: 15px; border-radius: 5px; }
    .info-box:last-child { margin-right: 0; }
    .info-box h3 { font-size: 14px; margin-bottom: 10px; color: #555; }
    .info-box p { margin: 5px 0; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
    table th, table td { border: 1px solid #ddd; padding: 10px; text-align: left; }
    table th { background-color: #f5f5f5; font-weight: bold; }
    table tr:nth-child(even) { background-color: #fafafa; }
    .signature-section { margin-top: 50px; display: flex; justify-content: space-between; }
    .signature-box { width: 45%; }
    .signature-line { border-top: 1px solid #333; margin-top: 40px; padding-top: 5px; }
    .footer { margin-top: 50px; text-align: center; font-size: 10px; color: #999; }
    .status-badge { display: inline-block; padding: 5px 10px; background-color: #28a745; color: white; border-radius: 3px; font-size: 11px; }
    @media print { body { padding: 0; } .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(data.form_title || 'Pick Form').toUpperCase()}</h1>
    <p class="subtitle">SIM Card Stock Management System</p>
  </div>
  
  <div class="info-section">
    <div class="info-box">
      <h3>Request Information</h3>
      <p><strong>Request ID:</strong> ${escapeHtml(shortRequestId)}</p>
      <p><strong>Request Date:</strong> ${new Date(data.request_date).toLocaleDateString()}</p>
      <p><strong>Status:</strong> <span class="status-badge">READY FOR PICK</span></p>
    </div>
    
    <div class="info-box">
      <h3>Distributor Details</h3>
      <p><strong>Distributor:</strong> ${escapeHtml(data.distributor_name)}</p>
      <p><strong>Contact Person:</strong> ${escapeHtml(data.contact_person || data.picked_by_name || 'N/A')}</p>
      <p><strong>Contact Email:</strong> ${escapeHtml(data.contact_email || 'N/A')}</p>
      <p><strong>Total Quantity:</strong> ${data.requested_quantity}</p>
      <p><strong>Boxes Assigned:</strong> ${data.assigned_boxes.length}</p>
      <p><strong>Approved By (Level 1):</strong> ${escapeHtml(data.approved_by_l1_email || 'N/A')}</p>
      <p><strong>Approved By (Level 2):</strong> ${escapeHtml(data.approved_by_l2_email || 'N/A')}</p>
      <p><strong>Issued By:</strong> ${escapeHtml(data.issued_by || 'N/A')}</p>
    </div>
  </div>
  
  <h3>${isEsim ? 'Assigned eSIM ICCIDs' : 'Assigned Boxes'}</h3>
  ${isEsim ? `<table>
    <thead>
      <tr>
        <th>#</th>
        <th>ICCID</th>
      </tr>
    </thead>
    <tbody>
      ${esimRows || '<tr><td colspan="2">No eSIM ICCIDs found</td></tr>'}
    </tbody>
  </table>` : `<table>
    <thead>
      <tr>
        <th>#</th>
        <th>Carton Number</th>
        <th>Box Number</th>
        <th>ICCID Start</th>
        <th>ICCID End</th>
        <th>Total SIMs</th>
        <th>SIMs Picked</th>
      </tr>
    </thead>
    <tbody>
      ${boxesHTML}
    </tbody>
  </table>`}
  
  <div class="signature-section">
    <div class="signature-box">
      <p><strong>Requested By:</strong> ${escapeHtml(data.contact_person || data.picked_by_name || 'N/A')}</p>
      <p><strong>Email:</strong> ${escapeHtml(data.contact_email || 'N/A')}</p>
    </div>
  </div>
  
  <div class="footer">
    <p>Generated on ${new Date().toLocaleString()} | SIM Card Stock Management System</p>
  </div>
</body>
</html>`;
}

export async function generatePickFormPDF(data: PickFormData): Promise<Buffer> {
  const browser = await getBrowser();
  
  try {
    const page: Page = await browser.newPage();
    
    const html = generatePickFormHTML(data);
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px',
      },
    });
    
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

export async function savePickFormPDF(data: PickFormData): Promise<string> {
  const pdfBuffer = await generatePickFormPDF(data);
  
  // For now, save to local filesystem
  // In production, upload to Supabase Storage
  const timestamp = Date.now();
  const filename = `pick-form-${data.request_id}-${timestamp}.pdf`;
  const filepath = path.join('./uploads', filename);
  
  // Ensure uploads directory exists
  if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads', { recursive: true });
  }
  
  fs.writeFileSync(filepath, pdfBuffer);
  
  // Return the URL path
  return `/uploads/${filename}`;
}
