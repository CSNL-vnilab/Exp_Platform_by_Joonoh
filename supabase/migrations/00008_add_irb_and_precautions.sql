-- Add IRB document URL and precaution checklist to experiments
ALTER TABLE experiments ADD COLUMN irb_document_url text;
ALTER TABLE experiments ADD COLUMN precautions jsonb DEFAULT '[]'::jsonb;
