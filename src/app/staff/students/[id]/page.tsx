import { db } from "@/db/client";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageBody, Stat } from "@/components/ui";
import { GraduationCap, Phone } from "lucide-react";
import { PageHeader } from "@/app/staff/_shell/page-header";
import { studentDetail } from "@/server/services/directory";
import { can } from "@/server/auth/policy";
import { scoped, staffPage } from "../page-support";
import { ContactForm } from "../contact-form";
export const dynamic="force-dynamic";
export default async function StudentPage({params}:{params:Promise<{id:string}>}){const p=await staffPage();const {id}=await params;const d=await scoped(()=>studentDetail(db(),p,id));
 return <><PageHeader title={d.student.fullName} sub={`${d.student.ref} | ${d.student.nicMasked??"Identifier unresolved"}`} actions={<ButtonLink variant="secondary" href="/staff/students">All students</ButtonLink>}/><PageBody><Card><CardHeader icon={<GraduationCap/>} title="Enrolments" description="Programmes and intakes in your scope"/>{d.enrolments.length?<div className="space-y-4 p-5">{d.enrolments.map(e=><Card className="space-y-4 p-4" key={e.id}><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium">{e.programmeName}</h3><p className="text-sm text-muted">{e.intakeLabel}</p></div><Badge>{e.status}</Badge></div><div className="grid gap-3 sm:grid-cols-3"><Stat label="Outstanding" minor={e.summary.outstandingMinor}/><Stat label="Overdue" minor={e.summary.overdueMinor} tone="bad"/><Stat label="Credit" minor={e.summary.creditMinor}/></div><ButtonLink href={`/staff/enrolments/${e.id}`}>View financial history</ButtonLink></Card>)}</div>:<div className="p-5"><EmptyState icon={<GraduationCap/>} title="No enrolments in your scope"/></div>}</Card><Card><CardHeader icon={<Phone/>} title="Contact details" description="Changes update shared contact details and are audited."/><div className="p-5"><ContactForm key={d.student.version} student={d.student} canCorrectNic={can(p,"nic.correct")}/></div></Card></PageBody></>;
}
