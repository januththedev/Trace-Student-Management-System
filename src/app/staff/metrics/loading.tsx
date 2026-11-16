import { Card } from "@/components/ui";

export default function LoadingMetrics() {
  return <main role="status" className="space-y-4 px-4 py-6 sm:px-6"><p className="text-sm text-muted">Loading records…</p><Card aria-hidden="true" className="divide-y divide-line">{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton m-4 h-14 rounded-md" />)}</Card></main>;
}
