import { redirect } from "next/navigation";

export default async function QuestionIdRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/inbox/escalations/${id}`);
}
