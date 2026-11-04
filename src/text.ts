/** Small text helpers shared by the parser: contractions, stemming and canonical phrase keys. */

const STOP = new Set([
  "the", "a", "an", "any", "some", "is", "are", "was", "were", "be", "been",
  "does", "do", "did", "its", "their", "this", "that", "these", "those",
]);

export function expandContractions(s: string): string {
  return s
    .replace(/[’]/g, "'")
    .replace(/\b(does|do|did|is|are|was|were|has|have|had|should|would|could|must)n't\b/gi, "$1 not")
    .replace(/\bcan't\b/gi, "can not")
    .replace(/\bcannot\b/gi, "can not")
    .replace(/\bwon't\b/gi, "will not");
}

export function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(sh|ch|x|ss|z)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[`"]/g, "")
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function contentWords(s: string): string[] {
  return words(s).filter((w) => !STOP.has(w));
}

/** Two phrasings of the same test map to the same key: "the ticket mentions a refund" == "tickets mention refunds". */
export function canonical(phrase: string): string {
  return contentWords(phrase).map(stem).join(" ");
}

export function stripQuotes(s: string): string {
  return s.replace(/^[`"']+|[`"']+$/g, "");
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
