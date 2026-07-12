/**
 * Text normalization utilities shared by curriculum parsing, the RAG engine
 * and content extraction.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeForComparison(value: string): string {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase();
}

export function normalizeForLookup(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function stripTrailingLevelNumber(value: string): string {
  return String(value || "")
    .replace(/\s+\d+\s*$/, "")
    .trim();
}
