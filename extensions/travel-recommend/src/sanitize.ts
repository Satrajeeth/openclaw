// Sanitize text before storing in DB
export function sanitizeText(input: string, maxLength = 500): string {
  if (!input) return "";

  // Strip control characters and trim
  const sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
  return sanitized.slice(0, maxLength);
}
