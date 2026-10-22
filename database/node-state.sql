CREATE TABLE IF NOT EXISTS node_browser_session (
  id_hash char(64) NOT NULL PRIMARY KEY,
  data json NOT NULL,
  expires_at int NOT NULL,
  KEY idx_node_session_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS node_rate_limit (
  id char(64) NOT NULL PRIMARY KEY,
  count int NOT NULL DEFAULT 0,
  expires_at int NOT NULL,
  KEY idx_node_limit_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
