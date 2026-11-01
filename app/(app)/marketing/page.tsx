import { redirect } from "next/navigation";

export const metadata = { title: "Marketing" };

export default function MarketingPage() {
  redirect("https://amp.ziki.dev");
}
