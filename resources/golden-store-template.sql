PRAGMA user_version = 2;
PRAGMA journal_mode = WAL;
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
