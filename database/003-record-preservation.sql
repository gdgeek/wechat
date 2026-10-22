-- Applied by scripts/record-preservation.ts after validating the live schema.
-- Placeholders identify the existing key and preserve its integer type and update
-- action. A different replacement name allows an atomic DROP + ADD in MySQL.
ALTER TABLE `record`
  DROP FOREIGN KEY {{foreign_key}},
  MODIFY COLUMN `device_id` {{column_type}} NULL,
  ADD CONSTRAINT {{replacement_key}} FOREIGN KEY (`device_id`) REFERENCES `device` (`id`) ON DELETE SET NULL ON UPDATE {{on_update}};
