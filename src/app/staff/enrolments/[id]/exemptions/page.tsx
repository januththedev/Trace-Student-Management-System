import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { can } from "@/server/auth/policy";
import { enrolmentDetail } from "@/server/services/enrolments";
import { Badge, ButtonLink, Card, CardHeader, PageBody } from "@/components/ui";
import { Award } from "lucide-react";
import { PageHeader } from "@/app/staff/_shell/page-header";
import { scoped, staffPage } from "../../../students/page-support";
import { AwardForm, RevokeForm } from "../financial-forms";
export const dynamic="force-dynamic";
export default async function ExemptionsPage({params}:{params:Promise<{id:string}>}){const p=await staffPage();const {id}=await params;const d=await scoped(()=>enrolmentDetail(db(),p,id),id);if(!can(p,"exemptions.manage"))notFound();
 return <><PageHeader title="Exemption awards" sub={`${d.student.fullName} | ${d.programme.name} | ${d.intake.label}`} actions={<ButtonLink variant="secondary" href={`/staff/enrolments/${id}`}>Financial history</ButtonLink>}/><PageBody className="space-y-5"><Card><CardHeader icon={<Award/>} title="New award" description="Awards reduce obligations. Released allocations become enrolment credit."/><div className="p-5"><AwardForm key={d.enrolment.version} id={id} version={d.enrolment.version} instalments={d.ledger.instalments} today={d.today}/></div></Card>{d.awards.map(a=><Card className="space-y-3 p-4" key={a.id}><div className="flex flex-wrap justify-between gap-3"><h2>{a.type.replaceAll("_"," ")}</h2><Badge>{a.status}</Badge></div><p className="text-sm">{a.reason}</p>{a.status==="ACTIVE"&&<RevokeForm version={d.enrolment.version} id={id} awardId={a.id}/>}</Card>)}</PageBody></>;
}
