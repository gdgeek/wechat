-- The v2 migration removed device.shop_id while v1 Game/System still require it.
-- Apply once, after legacy-schema.sql; the TypeScript migration runner checks
-- information_schema before applying this compatibility change to its target DB.
-- Existing device/shop relationships lost by the Yii2 DROP COLUMN cannot be
-- reconstructed. Restore them from an explicitly verified device-to-shop mapping.
ALTER TABLE `device`
  ADD COLUMN `shop_id` int NULL,
  ADD KEY `idx-device-shop_id` (`shop_id`),
  ADD CONSTRAINT `fk-device-shop_id` FOREIGN KEY (`shop_id`) REFERENCES `shop` (`id`) ON DELETE CASCADE;
