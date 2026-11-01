import { IssuesList } from "../../issues/_list/issues-list";
import { queryOf } from "../../issues/_list/route-page";

type Props = {
  params: Promise<{ project: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** `/<slug>/ideas/drafts`: unstructured draft ideas waiting to be structured (#project-urls). */
export default async function DraftIdeasPage({ params, searchParams }: Props) {
  const { project } = await params;
  const query = await searchParams;
  return <IssuesList slug={project} status="ideas" ideas="drafts" returnTo={`/${project}/ideas/drafts${queryOf(query)}`} searchParams={Promise.resolve(query)} />;
}
