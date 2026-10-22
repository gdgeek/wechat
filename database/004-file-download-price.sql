-- Snapshot prices only for new recordings. Existing files intentionally remain unknown.
ALTER TABLE `file`
  ADD COLUMN `price` int NULL COMMENT '拍摄时的下载费用，单位分；NULL 表示历史金额未确认';

-- Match WeChat's case-sensitive ASCII order identifiers. Keep the reservation
-- history independent of user/file deletion, as in the frozen Yii migration.
CREATE TABLE IF NOT EXISTS `file_payment_order` (
  `out_trade_no` varchar(32) NOT NULL,
  `user_id` int NOT NULL,
  `file_id` int NOT NULL,
  `amount` int NOT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`out_trade_no`)
) CHARACTER SET ascii COLLATE ascii_bin ENGINE=InnoDB;
