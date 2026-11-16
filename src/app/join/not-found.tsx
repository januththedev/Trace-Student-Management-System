import Link from "next/link";

export default function JoinNotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-5 py-12 text-ink">
      <section className="w-full max-w-lg space-y-4 rounded-lg border border-line bg-card p-6 sm:p-8" aria-labelledby="join-not-found-title">
        <p className="font-mono text-xs uppercase tracking-wide text-muted">Student entry</p>
        <h1 id="join-not-found-title" className="text-2xl font-semibold">This entry link is unavailable</h1>
        <p className="text-sm text-muted">Ask your programme team for an active student entry link, or choose your course from the student entry page.</p>
        <Link href="/" className="btn inline-flex min-h-11 items-center rounded-md bg-accent px-4 font-medium text-white">Go to student entry</Link>
      </section>
    </main>
  );
}
