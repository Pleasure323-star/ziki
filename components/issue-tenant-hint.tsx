import Link from "next/link";
import { switchTenantForIssueAction } from "@/app/(app)/tenants/actions";
import type { IssueTenantHint } from "@/lib/issue-tenant-hint";

/**
 * Shown instead of a 404 when an issue exists in another tenant the viewer
 * belongs to (#519): names the tenant and switches to it in one click.
 */
export function IssueTenantSwitch({
  issueId,
  tenant,
}: {
  issueId: string;
  tenant: IssueTenantHint;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-4 py-10">
      <p className="text-sm text-slate-500">Ziki Issues</p>
      <h1 className="text-xl font-semibold text-slate-900">
        This issue is in {tenant.name}
      </h1>
      <p className="text-sm text-slate-600">
        You&apos;re a member of {tenant.name}, but a different workspace is active on this
        device. Switch workspace to open the issue.
      </p>
      <form action={switchTenantForIssueAction}>
        <input type="hidden" name="issueId" value={issueId} />
        <input type="hidden" name="tenantId" value={tenant.id} />
        <button
          type="submit"
          className="rounded-md bg-teal-700 px-3 py-2 text-sm font-medium text-white hover:bg-teal-800"
        >
          Switch to {tenant.name} and open the issue
        </button>
      </form>
      <Link href="/dashboard" className="inline-flex text-sm font-medium text-teal-700 hover:underline">
        Back to issues
      </Link>
    </div>
  );
}
