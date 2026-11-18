-- KS_OPS_FLOW_PDF_LINK_v1 - link the approved one-page Keystone overview (PDF) from the flow's second email
-- ("Not opened, week 1") and the "Opened: more details" email. Only fills the link when the template has none yet,
-- so re-running is a no-op and a link staff changed by hand is kept.
UPDATE ks_mkt_templates
   SET fields = fields || jsonb_build_object(
         'link2_label', 'Download the one-page Keystone overview (PDF)',
         'link2_url', 'https://www.keystonecrm.online/keystone-overview.pdf'),
       updated_at = now()
 WHERE name IN ('Keystone flow - Not opened, week 1', 'Keystone flow - Opened: more details')
   AND COALESCE(fields->>'link2_url', '') = '';
