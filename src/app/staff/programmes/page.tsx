import { Plus } from "lucide-react";
import { Disclosure } from "@/components/ui/kit";
import Image from "next/image";
import Link from "next/link";
import { db } from "@/db/client";
import { can } from "@/server/auth/policy";
import { bannerChoices, listProgrammes } from "@/server/services/directory";
import { Badge, Card, EmptyState } from "@/components/ui";
import { PageBody } from "@/components/ui";
import { PageHeader } from "@/app/staff/_shell/page-header";
import { staffPage } from "../students/page-support";
import { ProgrammeForm } from "./programme-forms";
export const dynamic="force-dynamic";
export default async function ProgrammesPage(){const p=await staffPage();const rows=await listProgrammes(db(),p);const banners=can(p,"programme.create")?await bannerChoices():[];
 return <><PageHeader title="Programmes" sub={`${rows.length} programmes in your scope`}/><PageBody className="space-y-5">{can(p,"programme.create")&&<Card className="p-4"><Disclosure title={<><Plus aria-hidden className="size-4 text-accent" />New programme</>} triggerClassName="min-h-11 cursor-pointer text-lg"><div><ProgrammeForm banners={banners}/></div></Disclosure></Card>}{rows.length?<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{rows.map(r=><Link key={r.id} href={`/staff/programmes/${r.id}`} className="lift overflow-hidden rounded-lg border border-line bg-card">{r.bannerPath&&<Image width={1920} height={1080} sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 33vw" src={r.bannerPath} alt="" className="aspect-video w-full object-cover"/>}<div className="space-y-3 p-4"><p className="font-mono text-xs text-muted">{r.code}</p><h2 className="text-xl">{r.name}</h2><div className="flex flex-wrap gap-2"><Badge tone={r.trashedAt?"bad":r.status==="ACTIVE"?"ok":"neutral"}>{r.trashedAt?"In Trash":r.status}</Badge><Badge>{r.isPublic?"Public":"Private"}</Badge></div><p className="text-sm text-muted">{r.description}</p></div></Link>)}</div>:<EmptyState title="No programmes in your scope"/>}</PageBody></>;
}
