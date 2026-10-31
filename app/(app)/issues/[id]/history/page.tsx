import { notFound } from "next/navigation";
import { redirectLegacyIssue } from "../legacy-issue";

type Props = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** `/issues/<ref>/history` moved to `/<project-slug>/<number>/history` (#project-urls). */
export default async function LegacyIssueHistoryPage({ params, searchParams }: Props) {
  const { id } = await params;
  await redirectLegacyIssue(id, "/history", (await searchParams) ?? {});
  notFound();
}
