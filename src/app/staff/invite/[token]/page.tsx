import Link from "next/link";
import type { Metadata } from "next";
import { invitationDetails } from "@/server/services/governance";
import { AppError } from "@/server/http";
import { AuthFrame } from "../../_shell/auth-frame";
import AcceptForm from "./accept-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Accept invitation", referrer: "no-referrer", robots: { index: false, follow: false } };
export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let invitation;
  try { invitation = await invitationDetails(token); }
  catch (e) { if (!(e instanceof AppError) && !(e instanceof Error && e.name === "ZodError")) throw e; }
  return <AuthFrame>
    {invitation ? <><p className="text-sm font-medium text-[#8fe3e9]">You’re invited</p><h1 className="mt-3 text-2xl font-semibold text-white">Welcome, {invitation.name}</h1><p className="mt-3 text-sm leading-6 text-white/65">Join T2T Student Operations as {invitation.role === "SUPER_ADMIN" ? "a Super Admin" : "an Admin"}. Set your password to get started.</p><AcceptForm token={token} /></> : <><h1 className="text-2xl font-semibold text-white">This invitation is unavailable</h1><p className="my-4 text-sm leading-6 text-white/65">It may have expired or already been used. Ask your Super Admin for a new invitation.</p><Link href="/staff/login" className="inline-flex min-h-11 items-center font-medium text-[#8fe3e9] u-draw">Go to sign in</Link></>}
  </AuthFrame>;
}
