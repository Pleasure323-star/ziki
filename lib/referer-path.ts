import { headers } from "next/headers";
import { BASE_PATH } from "@/lib/base-path";

/**
 * The in-app path of the page a server action was submitted from (#project-urls),
 * from the Referer header, or null. Actions use it to send people back to the
 * project page they were on, since the project is in that page's URL.
 */
export async function refererPath(): Promise<string | null> {
  try {
    const referer = (await headers()).get("referer");
    if (!referer) return null;
    const url = new URL(referer);
    const path = BASE_PATH && url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) || "/" : url.pathname;
    return path.startsWith("/") && !path.startsWith("//") ? path : null;
  } catch {
    return null;
  }
}

/** The project slug of the page an action came from (`/<slug>/…`), or null. */
export async function refererProjectSlug(): Promise<string | null> {
  const path = await refererPath();
  const first = path?.split("/")[1];
  return first ? decodeURIComponent(first) : null;
}
