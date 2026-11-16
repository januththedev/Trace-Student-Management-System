import { can } from "@/server/auth/policy";
import { db } from "@/db/client";
import { ButtonLink, PageBody } from "@/components/ui";
import { Download, UserPlus } from "lucide-react";
import { PageHeader } from "@/app/staff/_shell/page-header";
import { searchStudents } from "@/server/services/directory";
import { staffPage } from "./page-support";
import { DirectorySearch } from "./private-search";

export const dynamic = "force-dynamic";

export default async function StudentsPage() {
  const principal = await staffPage();
  const result = await searchStudents(db(), principal, {});
  return <>
    <PageHeader title="Students" sub="Student profiles and enrolments in your scope" actions={<>
      <ButtonLink href="/staff/admissions"><UserPlus /> New application</ButtonLink>
      {can(principal, "exports.download") && <ButtonLink variant="secondary" href="/api/staff/students/export" download prefetch={false}><Download /> Export scoped directory</ButtonLink>}
    </>} />
    <PageBody><DirectorySearch initial={result} /></PageBody>
  </>;
}
