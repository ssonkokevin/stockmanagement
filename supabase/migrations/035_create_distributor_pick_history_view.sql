-- Create distributor_pick_history_view for displaying distributor pick history
-- This view joins box_pick_records with boxes, cartons, distributors and mvnos

-- Drop existing view if it exists
DROP VIEW IF EXISTS distributor_pick_history_view;

CREATE VIEW distributor_pick_history_view AS
SELECT 
    bpr.id,
    d.name AS distributor_name,
    d.type AS distributor_type,
    c.carton_number,
    b.box_number,
    -- Box display: x/total_boxes (e.g., x/800 for PAXTEL, x/200 for SALAMTEL/AGROTEL)
    CASE m.name
        WHEN 'PAXTEL' THEN CONCAT(b.box_number::text, '/800')
        WHEN 'SALAMTEL' THEN CONCAT(b.box_number::text, '/200')
        WHEN 'AGROTEL' THEN CONCAT(b.box_number::text, '/200')
        ELSE CONCAT(b.box_number::text, '/', 
        (SELECT COUNT(*)::text FROM boxes b2 
        JOIN cartons c2 ON b2.carton_id = c2.id 
        WHERE c2.mvno_id = m.id))
    END as box_display,
    COALESCE(bpr.quantity, bpr.sims_picked, 0) AS sims_picked,
    bpr.iccid_start,
    bpr.iccid_end,
    bpr.created_at AS pick_date,
    m.name AS mvno
FROM box_pick_records bpr
LEFT JOIN boxes b ON bpr.box_id = b.id
LEFT JOIN cartons c ON b.carton_id = c.id
LEFT JOIN distributors d ON bpr.distributor_id = d.id
LEFT JOIN mvnos m ON c.mvno_id = m.id;

-- Grant access to anon role
GRANT SELECT ON distributor_pick_history_view TO anon;
