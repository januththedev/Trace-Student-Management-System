import { Card } from "@/components/ui";

export default function LoadingReview() {
  return <main role="status" className="space-y-4 px-4 py-6 sm:px-6"><p className="text-sm text-muted">Loading receipt review…</p><div aria-hidden="true" className="grid gap-4 lg:grid-cols-2"><Card className="skeleton h-[50vh]" /><Card className="skeleton h-[50vh]" /></div></main>;
}
