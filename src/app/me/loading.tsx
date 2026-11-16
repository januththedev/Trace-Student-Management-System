import { Card } from "@/components/ui";

export default function LoadingPayments() {
  return <main role="status" className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6"><p className="text-sm text-muted">Loading your payments…</p><div aria-hidden="true" className="grid grid-cols-2 gap-3 md:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Card key={i} className="skeleton h-24" />)}</div><Card aria-hidden="true" className="skeleton h-64" /></main>;
}
