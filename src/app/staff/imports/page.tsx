import { notFound } from "next/navigation";
import { can } from "@/server/auth/policy";
import { ButtonLink, PageBody } from "@/components/ui";
import { PageHeader } from "@/app/staff/_shell/page-header";
import { staffPage } from "../students/page-support";
import { ImportForm } from "./import-form";
export const dynamic="force-dynamic";
export default async function ImportsPage(){const p=await staffPage();if(!can(p,"imports.run"))notFound();return <><PageHeader title="CSV import" sub="Validate student records and opening schedules before committing"/><PageBody><ImportForm/>{can(p,"nic.correct")&&<div><ButtonLink variant="secondary" href="/staff/imports/identity">Identity resolution queue</ButtonLink></div>}</PageBody></>;}
