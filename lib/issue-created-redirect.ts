/**
 * Identifies the Next.js redirect thrown after an issue is created.
 * Other redirects, such as an expired session sending the user to login,
 * must not clear the saved draft.
 */
export function isIssueCreatedRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string") return false;

  const parts = digest.split(";");
  if (parts[0] !== "NEXT_REDIRECT") return false;

  const destination = parts.slice(2, -2).join(";");
  return /^\/[^/?#]+\/ideas\/[0-9]+$/.test(destination);
}
