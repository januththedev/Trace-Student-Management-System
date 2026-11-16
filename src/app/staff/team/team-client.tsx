"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { listTeam } from "@/server/services/governance";
import type { Capability, ScopeGrant } from "@/server/auth/policy";
import { Checkbox, Dialog, Select } from "@/components/ui/kit";
import { EmptyState, inputCls } from "@/components/ui";
import { Search, UserPlus, Users } from "lucide-react";
import { postStaff } from "../login/request";

type Team = Awaited<ReturnType<typeof listTeam>>;
type Account = Team["staff"][number];
const inputClass = inputCls;
const buttonClass = "btn inline-flex min-h-11 items-center justify-center rounded-lg border border-line bg-card px-4 text-sm font-semibold text-ink hover:bg-surface focus-visible:ring-4 focus-visible:ring-accent/25 disabled:opacity-50";
const capabilityLabels: Record<Capability, string> = {
  "programme.manage": "Edit programmes and intakes", "programme.create": "Create programmes and intakes", "fees.adjust": "Adjust fees", "exemptions.manage": "Manage exemptions", "withdrawals.manage": "Manage withdrawals", "exports.download": "Download exports", "admissions.decide": "Decide admissions", "imports.run": "Run imports",
};

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }} title={title} closeLabel="Close dialog">{children}</Dialog>;
}

function Permissions({ data, capabilities, setCapabilities, scopes, setScopes }: { data: Team; capabilities: Capability[]; setCapabilities: (v: Capability[]) => void; scopes: ScopeGrant[]; setScopes: (v: ScopeGrant[]) => void }) {
  function toggle(s: ScopeGrant) {
    const selected = scopes.some(v => v.programmeId === s.programmeId && v.intakeId === s.intakeId);
    setScopes(selected ? scopes.filter(v => !(v.programmeId === s.programmeId && v.intakeId === s.intakeId)) : [...scopes, s]);
  }
  return <>
    <fieldset className="rounded-lg border border-line p-3"><legend className="px-1 text-sm font-semibold">Delegated capabilities</legend><div className="grid gap-x-4 sm:grid-cols-2">{(Object.keys(capabilityLabels) as Capability[]).map(c => <div key={c} className="flex min-h-11 items-center"><Checkbox id={`cap-${c}`} checked={capabilities.includes(c)} onCheckedChange={checked => setCapabilities(checked ? [...capabilities, c] : capabilities.filter(v => v !== c))} label={capabilityLabels[c]} /></div>)}</div></fieldset>
    <fieldset className="rounded-lg border border-line p-3"><legend className="px-1 text-sm font-semibold">Programme and intake access</legend><p className="mb-2 text-sm text-muted">No assignments means no programme access. A programme assignment includes all its intakes.</p>
      {!data.programmes.length && <p className="py-3 text-sm text-muted">No programmes available yet.</p>}
      <div className="max-h-60 overflow-y-auto">{data.programmes.map(p => <div key={p.id} className="border-b border-line last:border-0"><Checkbox id={`scope-${p.id}`} checked={scopes.some(s => s.programmeId === p.id && s.intakeId === null)} onCheckedChange={() => toggle({ programmeId: p.id, intakeId: null })} label={<span className="font-medium">{p.name} · all intakes</span>} />{data.intakes.filter(i => i.programmeId === p.id).map(i => <div key={i.id} className="ml-5"><Checkbox id={`scope-${i.id}`} checked={scopes.some(s => s.programmeId === p.id && s.intakeId === i.id)} onCheckedChange={() => toggle({ programmeId: p.id, intakeId: i.id })} label={i.label} /></div>)}</div>)}</div>
    </fieldset>
  </>;
}

function Editor({ data, account, onClose, onSaved }: { data: Team; account?: Account; onClose: () => void; onSaved: (message: string, invitationUrl?: string) => void }) {
  const [role, setRole] = useState<"ADMIN" | "SUPER_ADMIN">(account?.role ?? "ADMIN");
  const [caps, setCaps] = useState<Capability[]>((account?.capabilities ?? []) as Capability[]);
  const [scopes, setScopes] = useState<ScopeGrant[]>(account?.scopes ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    setBusy(true); setError("");
    try {
      const values = { role, capabilities: caps, scopes };
      if (account) {
        await postStaff("/api/staff/team/edit", { ...values, id: account.id, version: account.version, reason: f.get("reason") });
        onSaved("Permissions updated. The member must sign in again.");
      } else {
        const r = await postStaff<{ token: string }>("/api/staff/team/invite", { ...values, name: f.get("name"), email: f.get("email") });
        onSaved("Invitation created. Share this private link with the invited person. It expires in 7 days.", `${location.origin}/staff/invite/${r.token}`);
      }
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return <Modal title={account ? `Edit ${account.name}` : "Invite a team member"} onClose={onClose}><form onSubmit={submit} className="space-y-5" aria-busy={busy}>
    {!account && <><label className="block text-sm font-semibold">Full name<input name="name" autoComplete="name" required maxLength={150} className={`${inputClass} mt-2`} /></label><label className="block text-sm font-semibold">Email address<input name="email" type="email" autoComplete="email" required maxLength={254} className={`${inputClass} mt-2`} /></label></>}
    <div><label htmlFor="staff-role" className="mb-2 block text-sm font-medium">Role</label><Select id="staff-role" value={role} onValueChange={v => setRole(v as typeof role)} options={[{value:"ADMIN",label:"Admin"},{value:"SUPER_ADMIN",label:"Super Admin"}]} /></div>
    {role === "SUPER_ADMIN" ? <p className="rounded-lg bg-accent-soft p-4 text-sm leading-6 text-ink">Super Admins have full access, including staff management. A maximum of three may be active. Pending invitations do not reserve a place.</p> : <Permissions data={data} capabilities={caps} setCapabilities={setCaps} scopes={scopes} setScopes={setScopes} />}
    {account && <label className="block text-sm font-semibold">Reason for change<textarea name="reason" required maxLength={1000} className={`${inputClass} mt-2 min-h-24 py-3`} /></label>}
    {error && <p role="alert" className="rounded-lg bg-bad-soft p-3 text-sm text-bad">{error}</p>}
    <div className="flex justify-end gap-3"><button type="button" onClick={onClose} className={buttonClass} disabled={busy}>Cancel</button><button disabled={busy} className="btn min-h-11 rounded-lg bg-accent px-5 font-semibold text-inv-ink focus-visible:ring-4 focus-visible:ring-accent/30 disabled:opacity-50">{busy ? "Saving…" : account ? "Save changes" : "Create invitation"}</button></div>
  </form></Modal>;
}

function StatusDialog({ account, action, onClose, onSaved }: { account: Account; action: "trash" | "deactivate" | "reactivate"; onClose: () => void; onSaved: (m: string) => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const title = action === "trash" ? "Move staff member to Trash" : action === "deactivate" ? "Deactivate staff member" : "Reactivate staff member";
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError("");
    const reason = new FormData(e.currentTarget).get("reason");
    try { await postStaff(action === "trash" ? "/api/staff/trash" : "/api/staff/team/status", { id: account.id, version: account.version, action, reason, ...(action === "trash" ? { kind: "staff" } : {}) }); onSaved(action === "reactivate" ? "Staff member reactivated. A new sign-in is required." : "Access revoked. The change has been recorded."); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return <Modal title={title} onClose={onClose}><p className="mb-5 leading-7 text-muted">{account.name} ({account.email}). {action === "trash" ? "Access will end immediately. The account can be restored for 30 days." : action === "deactivate" ? "All sessions will be revoked immediately. You can reactivate this account later." : "Access will return with the same role and assignments. Previous sessions will stay revoked."}</p><form onSubmit={submit} className="space-y-4" aria-busy={busy}><label className="block text-sm font-semibold">Reason<textarea name="reason" required maxLength={1000} className={`${inputClass} mt-2 min-h-24 py-3`} /></label>{error && <p role="alert" className="rounded-lg bg-bad-soft p-3 text-bad">{error}</p>}<div className="flex justify-end gap-3"><button type="button" onClick={onClose} className={buttonClass} disabled={busy}>Cancel</button><button disabled={busy} className="btn min-h-11 rounded-lg bg-accent px-5 font-semibold text-inv-ink focus-visible:ring-4 focus-visible:ring-accent/30 disabled:opacity-50">{busy ? "Saving…" : "Confirm"}</button></div></form></Modal>;
}

export default function TeamClient({ data }: { data: Team }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [editor, setEditor] = useState<Account | "invite" | null>(null);
  const [action, setAction] = useState<{ account: Account; type: "deactivate" | "reactivate" | "trash" } | null>(null);
  const [notice, setNotice] = useState(""); const [invitationUrl, setInvitationUrl] = useState(""); const router = useRouter();
  function saved(message: string, url?: string) { setEditor(null); setAction(null); setNotice(message); setInvitationUrl(url ?? ""); router.refresh(); }
  const activeSuper = data.staff.filter(s => s.role === "SUPER_ADMIN" && s.status === "ACTIVE").length;
  const query = search.trim().toLocaleLowerCase();
  const members = data.staff.filter(member =>
    (status === "all" || member.status === status) &&
    (!query || `${member.name} ${member.email}`.toLocaleLowerCase().includes(query))
  );
  return <div>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4"><p className="text-sm text-muted"><strong className="font-semibold text-ink">{activeSuper} of 3</strong> Super Admin places in use · {data.staff.length} team members</p><button onClick={() => setEditor("invite")} className="btn inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white shadow-sm hover:bg-accent-strong"><UserPlus className="size-4" />Invite team member</button></div>
    {notice && <div role="status" className="mb-6 rounded-lg border border-accent/30 bg-accent-soft p-4 text-sm leading-6 text-ink"><p>{notice}</p>{invitationUrl && <label className="mt-3 block font-semibold">Private invitation link<input readOnly value={invitationUrl} onFocus={e => e.currentTarget.select()} className={`${inputClass} mt-2 text-sm font-normal`} /></label>}</div>}
    <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_200px]">
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <label htmlFor="team-search" className="sr-only">Search team members</label>
        <input id="team-search" type="search" autoCapitalize="none" spellCheck={false} enterKeyHint="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by name or email" className={`${inputClass} pl-10`} />
      </div>
      <Select aria-label="Filter team by status" value={status} onValueChange={setStatus} options={[{value:"all",label:"All statuses"},{value:"ACTIVE",label:"Active"},{value:"DEACTIVATED",label:"Deactivated"}]} />
    </div>
    <p role="status" className="mb-3 text-xs text-muted">{members.length} of {data.staff.length} team members</p>
    {!members.length ? <EmptyState icon={<Users />} title={data.staff.length ? "No matching team members" : "No team members to display."}>{data.staff.length ? <button className="btn mt-3 inline-flex min-h-11 items-center rounded-md px-4 font-medium text-accent hover:bg-accent-soft" onClick={() => { setSearch(""); setStatus("all"); }}>Clear filters</button> : null}</EmptyState> : <div className="overflow-hidden rounded-xl border border-line bg-card shadow-xs"><table className="responsive-table w-full text-left text-sm"><caption className="sr-only">Staff accounts, roles, access and actions</caption><thead className="border-b border-line bg-bg text-muted"><tr><th scope="col" className="p-4">Team member</th><th scope="col" className="p-4">Role & status</th><th scope="col" className="hidden p-4 lg:table-cell">Access</th><th scope="col" className="p-4">Actions</th></tr></thead><tbody className="divide-y divide-line">{members.map(a => <tr key={a.id}><th scope="row" className="p-4 font-normal"><p className="font-semibold text-ink">{a.name}</p><p className="mt-1 break-all text-muted">{a.email}</p></th><td data-label="Role & status" className="p-4"><div><p className="whitespace-nowrap font-medium">{a.role === "SUPER_ADMIN" ? "Super Admin" : "Admin"}</p><span className={`mt-2 inline-flex rounded-full px-2 py-1 text-xs font-semibold ${a.status === "ACTIVE" ? "bg-ok-soft text-ok" : "bg-surface text-muted"}`}>{a.status === "ACTIVE" ? "Active" : "Deactivated"}</span></div></td><td data-label="Access" className="p-4 text-muted">{a.role === "SUPER_ADMIN" ? "All programmes" : `${a.scopes.length} assignments · ${a.capabilities.length} capabilities`}</td><td data-label="Actions" className="p-4"><div className="flex flex-wrap justify-end gap-2 lg:justify-start"><button onClick={() => setEditor(a)} className={buttonClass} aria-label={`Edit permissions for ${a.name}`}>Edit access</button><button onClick={() => setAction({ account: a, type: a.status === "ACTIVE" ? "deactivate" : "reactivate" })} className={buttonClass}>{a.status === "ACTIVE" ? "Deactivate" : "Reactivate"}</button><button onClick={() => setAction({ account: a, type: "trash" })} className={buttonClass} aria-label={`Move ${a.name} to Trash`}>Trash</button></div></td></tr>)}</tbody></table></div>}
    {editor && <Editor data={data} account={editor === "invite" ? undefined : editor} onClose={() => setEditor(null)} onSaved={saved} />}
    {action && <StatusDialog account={action.account} action={action.type} onClose={() => setAction(null)} onSaved={saved} />}
  </div>;
}
