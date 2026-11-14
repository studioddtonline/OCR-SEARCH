/** Common fields shared by standard and Japanese OCR search results. */
export interface OcrSearchHit {
  id: number;
  label: string | null;
  fileName: string | null;
  reviewed: number | null;
  snippet: string;
}
