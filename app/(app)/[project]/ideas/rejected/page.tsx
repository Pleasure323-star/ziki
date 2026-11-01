import { IssuesList } from "../../issues/_list/issues-list";
import { queryOf } from "../../issues/_list/route-page";

type Props = {
  params: Promise<{ project: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** `/<slug>/ideas/rejected`: ideas a manager agent rejected or archived (#project-urls). */
export default async function RejectedIdeasPage({ params, searchParams }: Props) {
  const { project } = await params;
  const query = await searchParams;
  return <IssuesList slug={project} status="rejected_ideas" returnTo={`/${project}/ideas/rejected${queryOf(query)}`} searchParams={Promise.resolve(query)} />;
}
