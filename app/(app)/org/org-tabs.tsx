"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The organization admin area's sections, one route each. */
export const ORG_TABS = [
  { href: "/org", label: "Overview" },
  { href: "/org/members", label: "Members" },
  { href: "/org/invites", label: "Invites" },
  { href: "/org/projects", label: "Projects" },
  { href: "/org/types", label: "Issue types" },
  { href: "/org/platforms", label: "Platforms" },
  { href: "/org/milestones", label: "Milestones" },
  { href: "/org/settings", label: "Settings" },
] as const;

function isActive(pathname: string, href: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (href === "/org") return path === "/org";
  return path === href || path.startsWith(`${href}/`);
}

/**
 * The segmented tab bar under the organization's name. On a phone it scrolls
 * sideways inside itself, so the page never does.
 */
export function OrgTabs() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Organization sections" className="-mx-1 overflow-x-auto px-1 pb-1">
      <ul className="flex w-max gap-0.5 rounded-full bg-zk-seg p-1">
        {ORG_TABS.map((tab) => {
          const on = isActive(pathname, tab.href);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={on ? "page" : undefined}
                className={`inline-flex min-h-9 items-center whitespace-nowrap rounded-full px-3.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue ${
                  on
                    ? "bg-zk-surface font-bold text-zk-text shadow-[0_1px_3px_rgba(21,18,31,0.12)]"
                    : "font-medium text-zk-text2 hover:text-zk-text"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
