/**
 * Where opening a notification may send you (#216): app-relative paths only,
 * so a stored URL can never become an open redirect ("//evil", "https://...").
 */
export function safeNotificationPath(url: string): string {
  return url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\") ? url : "/dashboard";
}
