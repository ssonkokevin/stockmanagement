# Hamilton Telecom SIM Inventory - Migration Guide

## Run Order in Supabase SQL Editor

1. **002_hamilton_sim_inventory.sql** – Tables, enums, indexes, RLS
2. **003_hamilton_functions_and_data.sql** – Functions, triggers, views, sample distributors, 40 cartons
3. **004_esim_upload.sql** – eSIM stock (expand VALUES with your full IMSI/ICCID lists)

## Fixes Applied

| Issue | Fix |
|-------|-----|
| **eSIM INSERT column order** | Table uses `(iccid, imsi)` but original used `(imsi, iccid)` – SELECT now uses `iccid, imsi` |
| **generate_physical_sim_stock** | Removed invalid nested DECLARE; fixed ICCID formatting with LPAD(20) |
| **physical_sims population** | 200k row insert disabled; only cartons + boxes created (840 rows). Uncomment loop in 003 if you need per‑SIM rows |
| **ENUM creation** | Wrapped in `DO $$ ... EXCEPTION WHEN duplicate_object` so re-runs are safe |
| **distributor_balances trigger** | Uses `ON CONFLICT (distributor_id) DO UPDATE` for upsert |
| **views** | Switched to `FILTER (WHERE ...)` instead of `CASE WHEN` for aggregates |

## IMSI/ICCID Ranges (Paxtel Physical)

- **200,000 SIMs** across 40 cartons
- Carton labels: 1/40 … 40/40
- Each carton: 20 boxes × 250 SIMs = 5,000
- Block 1 (100k): IMSI 641201100014001–641201100114000, ICCID 89256200000000025001–89256200000000125000
- Block 2 (100k): IMSI 641201100114001–641201100214000, ICCID 89256200000000125001–89256200000000225000

## eSIM Upload

1. Open `004_esim_upload.sql`
2. Add all IMSI/ICCID pairs to each `VALUES` list in the form `('imsi', 'iccid')`
3. Run the script in the Supabase SQL Editor

## Frontend Next Steps

The current React app uses the `simcards` table. To support Hamilton:

- Use `cartons`, `boxes`, `physical_sims`, `esim_stock`, `distributors`, `stock_distributions`, `distribution_details`
- Implement screens for: stock overview, distributions, distributor management, reports, BOSS integration (when available)
