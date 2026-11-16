import { currentStaff } from "@/server/auth/staff";
import { isSuper } from "@/server/auth/policy";
import { StaffShell } from "./_shell/staff-nav";

export const dynamic = "force-dynamic";

/**
 * Staff shell. Pages enforce auth themselves (redirect to /staff/login); unauthenticated routes
 * like /staff/login and /staff/invite/[token] render without the shell.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const p = await currentStaff();
  if (!p) return <>{children}</>;
  return (
    <>
      <meta name="csrf-token" content={p.csrfSecret} />
      <StaffShell name={p.name} email={p.email} role={p.role === "SUPER_ADMIN" ? "Super Admin" : "Admin"} isSuper={isSuper(p)}>
        {children}
      </StaffShell>
    </>
  );
}
