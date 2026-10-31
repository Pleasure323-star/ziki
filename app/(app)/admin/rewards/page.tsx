import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import {
  getPlatformRewardConfig,
  hardCodedPlatformRewards,
} from "@/lib/points/platform-rewards";
import { PlatformRewardsForm } from "@/components/platform-rewards-form";

export const metadata = { title: "Platform points" };

export default async function AdminRewardsPage() {
  await requireSuperAdmin();
  const initial = await getPlatformRewardConfig(prisma);
  const hardCoded = hardCodedPlatformRewards();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm">
          <Link href="/admin/users" className="font-medium text-teal-700 hover:underline">
            ← Site admin
          </Link>
        </p>
        <h1 className="mt-2 text-xl font-semibold text-slate-900 sm:text-2xl">Platform points</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Change the site-wide ledger amounts. When a value is missing from the database, the
          hard-coded default is used so awards keep working. Individual projects may still set
          their own solver, reporter, and merge-reviewer amounts.
        </p>
      </div>
      <PlatformRewardsForm initial={initial} hardCoded={hardCoded} />
    </div>
  );
}
