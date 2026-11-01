import { IssuesList } from "../issues/_list/issues-list";
import { queryOf } from "../issues/_list/route-page";

type Props = {
  params: Promise<{ project: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** `/<slug>/ideas`: new ideas, the project's landing list (#project-urls). A search here looks through them. */
export default async function IdeasPage({ params, searchParams }: Props) {
  const { project } = await params;
  const query = await searchParams;
  return <IssuesList slug={project} status="ideas" returnTo={`/${project}/ideas${queryOf(query)}`} searchParams={Promise.resolve(query)} />;
}
