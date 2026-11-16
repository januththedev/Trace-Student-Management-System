import { PageBody } from "@/components/ui";
import { PageHeader } from "../_shell/page-header";
import { redirect } from "next/navigation";
import { currentStaff } from "@/server/auth/staff";
import { listTeam } from "@/server/services/governance";
import TeamClient from "./team-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team" };
export default async function TeamPage() {
  const actor = await currentStaff();
  if (!actor) redirect("/staff/login");
  if (actor.role !== "SUPER_ADMIN") return <main className="p-8 text-ink"><h1 className="text-2xl font-bold">Team access is restricted</h1><p className="mt-3">Only a Super Admin can manage staff accounts.</p></main>;
  const data = await listTeam(actor);
  return <><PageHeader title="Your team" sub="Manage who can access T2T and the programmes they support. Every permission change is recorded." eyebrow="Workspace settings"/><PageBody><TeamClient data={data} /></PageBody></>;
}
