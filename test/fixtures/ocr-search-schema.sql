-- Pinned search fixture schema, transcribed from OCR-MCP-SERVER test/support/ocr-fixture.ts.
-- This is test-only DDL. OCR-SEARCH does not create or migrate consumer databases.
CREATE TABLE source_images (
  id INTEGER PRIMARY KEY,
  file_path TEXT,
  file_name TEXT,
  ocr_text TEXT,
  reviewed INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE images_fts USING fts5(
  ocr_text,
  content='source_images',
  content_rowid='id',
  tokenize='trigram'
);

-- After inserting fixture rows, rebuild the external-content index:
-- INSERT INTO images_fts(images_fts) VALUES ('rebuild');
