import { notFound } from "next/navigation";
import { statusFromSegment } from "@/lib/project-paths";
import { IssuesList } from "../_list/issues-list";
import { queryOf } from "../_list/route-page";

type Props = {
  params: Promise<{ project: string; status: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** `/<slug>/issues/<status>`: open, in-progress, done, merge, live, closed, all, rejected, duplicates (#project-urls). */
export default async function IssuesStatusPage({ params, searchParams }: Props) {
  const { project, status: segment } = await params;
  const status = statusFromSegment(segment);
  if (!status) notFound();
  const query = await searchParams;
  return <IssuesList slug={project} status={status} returnTo={`/${project}/issues/${segment}${queryOf(query)}`} searchParams={Promise.resolve(query)} />;
}
