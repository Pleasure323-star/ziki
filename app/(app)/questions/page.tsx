import { redirect } from "next/navigation";

export default function QuestionsRedirect() {
  redirect("/inbox?tab=escalations");
}
