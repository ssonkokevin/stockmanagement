import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

export async function generatePickFormPdf({ outDir, filename, html }) {
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, filename);

  const browser = await puppeteer.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", right: "12mm", bottom: "16mm", left: "12mm" },
    });
  } finally {
    await browser.close();
  }

  return outPath;
}

export function renderPickFormHtml({ request, mvnoName, distributorName, allocations }) {
  const rows = allocations
    .map((a) => {
      const carton = a.carton_number ?? "";
      const box = a.box_display ?? a.box_number ?? "";
      const qty = a.quantity ?? "";
      const iccidStart = a.iccid_start ?? "";
      const iccidEnd = a.iccid_end ?? "";
      return `<tr>
        <td>${carton}</td>
        <td>${box}</td>
        <td style="text-align:right">${qty}</td>
        <td style="font-family:monospace">${iccidStart}</td>
        <td style="font-family:monospace">${iccidEnd}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { font-family: Arial, sans-serif; color: #111; }
        h1 { font-size: 18px; margin: 0 0 8px; }
        .meta { font-size: 12px; margin-bottom: 12px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #ddd; padding: 6px 8px; font-size: 12px; }
        th { background: #f4f4f4; text-align: left; }
      </style>
    </head>
    <body>
      <h1>SIM Stock Pick Form</h1>
      <div class="meta">
        <div><strong>Request ID:</strong> ${request.id}</div>
        <div><strong>MVNO:</strong> ${mvnoName}</div>
        <div><strong>Distributor:</strong> ${distributorName}</div>
        <div><strong>SIM Type:</strong> ${request.sim_type}</div>
        <div><strong>Quantity:</strong> ${request.quantity}</div>
        <div><strong>Date:</strong> ${new Date().toLocaleString()}</div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Carton</th>
            <th>Box</th>
            <th style="text-align:right">Qty</th>
            <th>ICCID Start</th>
            <th>ICCID End</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </body>
  </html>`;
}

