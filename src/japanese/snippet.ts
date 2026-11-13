/**
 * Keep Japanese snippets consistent with the Worker implementation. The search index
 * supplies query tokens and ranking; the caller supplies the current source OCR text.
 */
export function makeJapaneseSnippet(value: string | null, queryTokens: string[]): string {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!text) return "";

  const asciiFold = (input: string) =>
    input.replace(/[A-Z]/gu, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
  const foldedText = asciiFold(text);
  const highlightTokens = [...new Set(queryTokens.map(asciiFold))]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .slice(0, 16);
  let firstMatch = -1;
  for (const token of highlightTokens) {
    const at = foldedText.indexOf(token);
    if (at >= 0 && (firstMatch < 0 || at < firstMatch)) firstMatch = at;
  }

  const maxChars = 180;
  if (firstMatch < 0) {
    let end = Math.min(text.length, maxChars);
    if (end > 0 && end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    }
    return text.length > end ? `${text.slice(0, end)}…` : text;
  }

  let start = Math.max(0, firstMatch - 60);
  if (start + maxChars > text.length) start = Math.max(0, text.length - maxChars);
  let end = Math.min(text.length, start + maxChars);
  if (start > 0 && start < text.length) {
    const unit = text.charCodeAt(start);
    if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
  }
  if (end > start && end < text.length) {
    const unit = text.charCodeAt(end - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
  }

  const foldedSlice = foldedText.slice(start, end);
  const ranges: Array<[number, number]> = [];
  for (const token of highlightTokens) {
    let from = 0;
    while (from < foldedSlice.length) {
      const at = foldedSlice.indexOf(token, from);
      if (at < 0) break;
      ranges.push([at, at + token.length]);
      from = at + Math.max(1, token.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    const last = merged[merged.length - 1];
    if (last && rangeStart < last[1]) last[1] = Math.max(last[1], rangeEnd);
    else merged.push([rangeStart, rangeEnd]);
  }

  let result = start > 0 ? "…" : "";
  let cursor = 0;
  for (const [rangeStart, rangeEnd] of merged) {
    result += text.slice(start + cursor, start + rangeStart);
    result += `〔${text.slice(start + rangeStart, start + rangeEnd)}〕`;
    cursor = rangeEnd;
  }
  result += text.slice(start + cursor, end);
  if (end < text.length) result += "…";
  return result;
}
