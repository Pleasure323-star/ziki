import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveSessionUserId } from "@/lib/session-user";
import { BASE_PATH } from "@/lib/base-path";
import { safeNotificationPath } from "@/lib/notification-links";
import { expireTag, TAGS } from "@/lib/cache-tags";
import { memberTenantById, readActiveTenantCookie, setActiveTenantCookie } from "@/lib/tenants";
import { setActiveProjectCookie } from "@/lib/project-context";

/**
 * A relative Location, so the browser stays on the host it asked. Behind the
 * reverse proxy, the request's own origin is the container's bind address
 * (https://0.0.0.0:3000), which no browser can open (#416). `path` is always
 * app-relative (see safeNotificationPath), so this can't leave the site.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { Location: `${BASE_PATH}${path}` } });
}

/**
 * Opening a notification marks it read and goes to what it's about (#216).
 * A plain link, so it works without JavaScript and from a new tab.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const resolved = await resolveSessionUserId();

  if ("error" in resolved) {
    return redirectTo("/login");
  }

  const notification = await prisma.notification.findUnique({
    where: { id },
    select: { userId: true, tenantId: true, url: true, readAt: true },
  });
  // Someone else's notification (or none): don't reveal or touch it.
  if (!notification || notification.userId !== resolved.userId) {
    return redirectTo("/inbox");
  }

  if (notification.tenantId) {
    const tenant = await memberTenantById(prisma, resolved.userId, notification.tenantId);
    if (!tenant) return redirectTo("/inbox");
    if ((await readActiveTenantCookie()) !== tenant.id) {
      await setActiveTenantCookie(tenant.id);
      await setActiveProjectCookie("");
    }
  }

  if (!notification.readAt) {
    await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    expireTag(TAGS.unread(resolved.userId));
  }
  return redirectTo(safeNotificationPath(notification.url));
}
