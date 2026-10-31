import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { issueTenantHintFor } from "@/lib/issue-tenant-hint";
import { IssueTenantSwitch } from "@/components/issue-tenant-hint";
import { resolveSessionUserId } from "@/lib/session-user";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { redirectLegacyIssue } from "./legacy-issue";

type Props = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/issues/<n>`, `/issues/ZE-<n>` and `/issues/<id>`: the addresses issues
 * had before they moved under their project (#project-urls). Links to them
 * live on in emails, GitHub, chats and agents' notes, so each one
 * permanently redirects to `/<project-slug>/<number>`, keeping its query
 * (a comment permalink gets its #fragment back from `?comment=`).
 *
 * There is no loading.tsx on this route, so the redirect is a real 308.
 */
export default async function LegacyIssuePage({ params, searchParams }: Props) {
  const { id } = await params;
  await redirectLegacyIssue(id, "", (await searchParams) ?? {});

  // A link to an issue in another of the viewer's tenants should not
  // dead-end (#519): name the tenant and offer the switch.
  const resolved = await resolveSessionUserId();
  if ("userId" in resolved) {
    const hint = await issueTenantHintFor(prisma, {
      userId: resolved.userId,
      activeTenantId: await currentTenantIdFor(resolved.userId),
      issueId: id,
    });
    if (hint) return <IssueTenantSwitch issueId={id} tenant={hint} />;
  }
  notFound();
}
