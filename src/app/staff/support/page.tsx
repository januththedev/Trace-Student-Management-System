import { redirect } from "next/navigation";
import { currentStaff } from "@/server/auth/staff";
import { isSuper } from "@/server/auth/policy";
import { listFeedback } from "@/server/services/support/feedback";
import { PageHeader } from "../_shell/page-header";
import { PageBody } from "@/components/ui";
import { SupportWorkspace } from "./support-workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Help & support" };
export default async function SupportPage() {
  const p = await currentStaff();
  if (!p) redirect("/staff/login");
  const feedback = await listFeedback(p);
  return <><PageHeader title="Help & support" sub="Find your task, watch the steps, or tell us what needs to improve." />
    <PageBody><SupportWorkspace isSuper={isSuper(p)} initialFeedback={feedback} /></PageBody></>;
}
