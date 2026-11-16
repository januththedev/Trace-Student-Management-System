import { notFound } from "next/navigation";
import { can } from "@/server/auth/policy";
import { PageBody } from "@/components/ui";
import { PageHeader } from "@/app/staff/_shell/page-header";
import { staffPage } from "../../students/page-support";
import { listIdentities } from "@/server/services/imports/identity-resolution";
import { IdentityQueue } from "./identity-queue";

export const dynamic = "force-dynamic";

export default async function IdentityResolutionPage() {
  const p = await staffPage();
  if (!can(p, "nic.correct")) notFound();
  const items = await listIdentities(p, "open");
  return (
    <>
      <PageHeader title="Identity resolution" sub="Import rows without a valid identifier. Only a Super Admin can correct and import them." />
      <PageBody>
        <IdentityQueue initialOpen={items} />
      </PageBody>
    </>
  );
}
