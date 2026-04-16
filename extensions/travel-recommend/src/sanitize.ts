import {
  sanitizeForPromptLiteral,
  wrapUntrustedPromptDataBlock,
} from "openclaw/agents/sanitize-for-prompt";

// Sanitize text before storing in DB
export function sanitizeText(input: string, maxLength = 500): string {
  if (!input) return "";

  const sanitized = sanitizeForPromptLiteral(input);
  return sanitized.slice(0, maxLength);
}

// Wrap output before sending to LLM
export function wrapForLLM(text: string): string {
  return wrapUntrustedPromptDataBlock(text);
}
