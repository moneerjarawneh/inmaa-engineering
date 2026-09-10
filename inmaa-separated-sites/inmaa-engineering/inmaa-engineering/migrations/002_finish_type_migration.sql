-- Run only after a PostgreSQL backup. Review the audit query before COMMIT.
-- This migration assumes the legacy table is named apartments and has a finish_type column.
BEGIN;

ALTER TABLE apartments ADD COLUMN IF NOT EXISTS legacy_finish_type TEXT;

UPDATE apartments
SET legacy_finish_type = finish_type
WHERE legacy_finish_type IS NULL
  AND finish_type IS NOT NULL
  AND lower(trim(finish_type)) NOT IN ('super', 'super_deluxe', 'vip');

-- Extend these mappings with every value returned by the audit query.
UPDATE apartments
SET finish_type = CASE lower(trim(finish_type))
  WHEN 'economy' THEN 'super'
  WHEN 'standard' THEN 'super'
  WHEN 'premium' THEN 'super_deluxe'
  WHEN 'اقتصادي' THEN 'super'
  WHEN 'قياسي' THEN 'super'
  WHEN 'فاخر' THEN 'super_deluxe'
  WHEN 'super deluxe' THEN 'super_deluxe'
  WHEN 'سوبر' THEN 'super'
  WHEN 'سوبر ديلوكس' THEN 'super_deluxe'
  WHEN 'vip' THEN 'vip'
  ELSE 'super'
END
WHERE finish_type IS NULL
   OR lower(trim(finish_type)) NOT IN ('super', 'super_deluxe', 'vip');

-- Add and validate the new check constraint only after reviewing the audit.
SELECT legacy_finish_type, finish_type, COUNT(*) AS records
FROM apartments
GROUP BY legacy_finish_type, finish_type
ORDER BY records DESC;

COMMIT;
