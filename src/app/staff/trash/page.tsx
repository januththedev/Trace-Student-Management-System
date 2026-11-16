import { PageBody } from "@/components/ui";
import { PageHeader } from "../_shell/page-header";
import { redirect } from "next/navigation";
import { currentStaff } from "@/server/auth/staff";
import { listTrash } from "@/server/services/trash";
import TrashClient from "./trash-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trash & recovery" };
export default async function TrashPage() {
  const actor = await currentStaff();
  if (!actor) redirect("/staff/login");
  if (actor.role !== "SUPER_ADMIN") return <main className="p-8 text-ink"><h1 className="text-2xl font-bold">Trash access is restricted</h1><p className="mt-3">Only a Super Admin can manage Trash.</p></main>;
  return <><PageHeader title="Trash & recovery" sub="Restore programmes, intakes and staff within 30 days. After the window closes, scheduled cleanup removes disposable fields while preserving history." eyebrow="Workspace settings"/><PageBody><TrashClient data={await listTrash(actor)} /></PageBody></>;
}
