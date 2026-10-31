import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth-helpers";

export default async function AdminIndexPage() {
  await requireSuperAdmin();
  redirect("/admin/users");
}
