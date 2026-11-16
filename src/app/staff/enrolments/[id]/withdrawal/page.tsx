import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { can } from "@/server/auth/policy";
import { enrolmentDetail } from "@/server/services/enrolments";
import { ButtonLink, Card, CardHeader, PageBody } from "@/components/ui";
import { UserMinus } from "lucide-react";
import { PageHeader } from "@/app/staff/_shell/page-header";
import { scoped, staffPage } from "../../../students/page-support";
import { WithdrawalForm } from "../financial-forms";
export const dynamic="force-dynamic";
export default async function WithdrawalPage({params}:{params:Promise<{id:string}>}){const p=await staffPage();const {id}=await params;const d=await scoped(()=>enrolmentDetail(db(),p,id),id);if(!can(p,"withdrawals.manage"))notFound();return <><PageHeader title="Withdraw enrolment" sub={`${d.student.fullName} | ${d.programme.name} | ${d.intake.label}`} actions={<ButtonLink variant="secondary" href={`/staff/enrolments/${id}`}>Financial history</ButtonLink>}/><PageBody><Card className="max-w-3xl"><CardHeader icon={<UserMinus/>} title="Withdrawal details" description="Preview future cancellations, retained arrears, credit and open tasks before confirming."/><div className="p-5">{d.enrolment.status==="ACTIVE"?<WithdrawalForm key={d.enrolment.version} id={id} version={d.enrolment.version} today={d.today}/>:<p className="text-sm text-muted">This enrolment is {d.enrolment.status.toLowerCase()}.</p>}</div></Card></PageBody></>;}
