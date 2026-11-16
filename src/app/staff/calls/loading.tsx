export default function Loading() {
  return <main className="space-y-4 p-8" aria-busy="true" aria-label="Loading follow-up calls"><div className="h-10 w-64 animate-pulse rounded bg-slate-200" />{[1, 2, 3].map(i => <div key={i} className="h-40 animate-pulse rounded-xl bg-slate-100" />)}</main>;
}
