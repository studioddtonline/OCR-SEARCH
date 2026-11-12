-- Nullable reviewed variant used only by the fail-closed regression case.
-- Mirrors the hand-written schema in OCR-MCP-SERVER repository.test.ts.
CREATE TABLE source_images (
  id INTEGER PRIMARY KEY,
  file_path TEXT,
  file_name TEXT,
  ocr_text TEXT,
  reviewed INTEGER
);

CREATE VIRTUAL TABLE images_fts USING fts5(
  ocr_text,
  content='source_images',
  content_rowid='id',
  tokenize='trigram'
);

-- After inserting fixture rows, rebuild the external-content index:
-- INSERT INTO images_fts(images_fts) VALUES ('rebuild');
