import { PageBody } from "@/components/ui";
import { PageHeader } from "../_shell/page-header";
import { redirect } from "next/navigation";
import { currentStaff } from "@/server/auth/staff";
import { getCallQueue } from "@/server/services/followups/queue";
import { CallWorkspace } from "./_components/workspace";
import { Holidays } from "./_components/holidays";
import { listHolidays } from "@/server/services/followups/calendar";

export default async function CallsPage() {
  const principal = await currentStaff();
  if (!principal) redirect("/staff/login");
  const queue = await getCallQueue(principal);
  return <><PageHeader title="Follow-up calls" sub="One enrolment, one clear next action. Pending evidence stays on hold while staff review it."/><PageBody>
    <CallWorkspace initial={JSON.parse(JSON.stringify(queue))} />
    {principal.role === "SUPER_ADMIN" && <Holidays initial={(await listHolidays(principal)).map(holiday => ({ day: holiday.day, label: holiday.label }))} />}
  </PageBody></>;
}
