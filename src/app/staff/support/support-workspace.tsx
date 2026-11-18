"use client";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Tabs as AccessibleTabs } from "radix-ui";
import { Check, ChevronRight, MessageSquare, Play, Search } from "lucide-react";
import { Alert, Button, EmptyState, inputCls } from "@/components/ui";
import { Dialog, Select } from "@/components/ui/kit";
import { TUTORIALS } from "./tutorials";
import mediaJson from "./tutorial-media.json";
import { FeedbackPanel, FeedbackForm, type FeedbackData } from "./feedback-panel";

type Media = { src: string; captions: string; poster: string; duration: number; bytes: number };
const media = mediaJson as Record<string, Media>;
const duration = (seconds: number) => `${Math.floor(Math.round(seconds) / 60)}:${(Math.round(seconds) % 60).toString().padStart(2, "0")}`;
const compactQuery = "(min-width: 1280px) and (max-height: 820px)";
function subscribeHeight(callback: () => void) { const query = window.matchMedia(compactQuery); query.addEventListener("change", callback); return () => query.removeEventListener("change", callback); }
const shortDesktop = () => window.matchMedia(compactQuery).matches;
const serverHeight = () => false;
export function SupportWorkspace({ isSuper, initialFeedback }: { isSuper: boolean; initialFeedback: FeedbackData }) {
  const [tab, setTab] = useState("learn");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All tasks");
  const [page, setPage] = useState(0);
  const pageSize = useSyncExternalStore(subscribeHeight, shortDesktop, serverHeight) ? 3 : 6;
  const [selected, setSelected] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackArea, setFeedbackArea] = useState("GENERAL");
  const [refresh, setRefresh] = useState(0);
  const [sent, setSent] = useState(false);
  const guides = useMemo(() => TUTORIALS.filter(g => isSuper || !g.superOnly), [isSuper]);
  const categories = ["All tasks", ...new Set(guides.map(g => g.group))];
  const searchWords = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word && !["a", "an", "the", "or", "to", "and"].includes(word));
  const filtered = guides.filter(g => (category === "All tasks" || g.group === category) && searchWords.every(word => `${g.title} ${g.summary} ${g.steps.join(" ")}`.toLowerCase().includes(word)));
  const activePage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const visible = filtered.slice(activePage * pageSize, (activePage + 1) * pageSize);
  const guide = guides.find(g => g.id === selected);
  const clip = guide ? media[guide.id] : null;
  function sendFeedback(area = "GENERAL") { setSent(false); setFeedbackArea(area); setFeedbackOpen(true); }
  return <div className="space-y-4">
    <AccessibleTabs.Root value={tab} onValueChange={setTab}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <AccessibleTabs.List aria-label="Support" className="inline-flex max-w-full flex-wrap gap-1 rounded-lg bg-surface p-1">{[{ value: "learn", label: "Learn a task" }, { value: "mine", label: "My feedback" }, ...(isSuper ? [{ value: "inbox", label: "Feedback inbox" }] : [])].map(item => <AccessibleTabs.Trigger key={item.value} value={item.value} className="btn inline-flex min-h-11 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted data-[state=active]:bg-card data-[state=active]:text-ink data-[state=active]:shadow-sm">{item.label}</AccessibleTabs.Trigger>)}</AccessibleTabs.List>
      <Button onClick={() => sendFeedback()}><MessageSquare className="size-4" />Send feedback</Button>
    </div>
    <AccessibleTabs.Content value={tab} className="mt-4 space-y-4 focus-visible:outline-accent">
    {sent ? <Alert tone="ok">Feedback sent. Keep the reference in My feedback to follow its progress.</Alert> : null}
    {tab === "learn" ? <>
      <div className="flex flex-wrap gap-3"><label className="relative block min-w-0 flex-1 basis-64"><span className="sr-only">Search help topics</span><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted" /><input value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} placeholder="Try ‘approve a receipt’ or ‘download a report’" className={`${inputCls} pl-10`} /></label><div className="w-full sm:w-56"><Select aria-label="Help category" value={category} onValueChange={value => { setCategory(value); setPage(0); }} options={categories.map(value => ({ value, label: value }))} /></div></div>
      <p role="status" className="text-sm text-muted">{filtered.length} task{filtered.length === 1 ? "" : "s"}{category !== "All tasks" ? ` · ${category}` : ""}</p>
      {!filtered.length ? <EmptyState title="No matching task"><p>Try a shorter search, or send us a question.</p><Button variant="secondary" className="mt-4" onClick={() => { setQuery(""); setCategory("All tasks"); setPage(0); }}>Show all tasks</Button></EmptyState> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{visible.map(g => {
        const video = media[g.id];
        return <button key={g.id} onClick={() => setSelected(g.id)} className="lift flex min-h-40 flex-col rounded-xl border border-line bg-card p-5 text-left focus-visible:outline-accent">
          <div className="flex w-full items-center justify-between gap-2"><span className="text-xs font-medium text-accent">{g.group}{g.superOnly ? " · Super Admin" : ""}</span><Play className="size-4 shrink-0 text-accent" /></div>
          <h3 className="mt-3 text-base">{g.title}</h3><p className="mt-1 flex-1 text-sm leading-relaxed text-muted">{g.summary}</p>
          <span className="mt-4 flex items-center gap-2 text-xs text-muted">{video ? `${duration(video.duration)} · ${(video.bytes / 1_000_000).toFixed(1)} MB` : "Step-by-step guide"}<ChevronRight className="ml-auto size-4" /></span>
        </button>;
      })}</div>}
      {filtered.length > pageSize ? <nav aria-label="Help pages" className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted">Showing {activePage * pageSize + 1}–{Math.min((activePage + 1) * pageSize, filtered.length)} of {filtered.length}</p><div className="flex gap-2"><Button variant="secondary" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>Previous tasks</Button><Button variant="secondary" disabled={(activePage + 1) * pageSize >= filtered.length} onClick={() => setPage(activePage + 1)}>Next tasks<ChevronRight className="size-4" /></Button></div></nav> : null}
    </> : <FeedbackPanel key={`${tab}:${refresh}`} view={tab === "inbox" ? "all" : "mine"} initial={tab === "mine" && refresh === 0 ? initialFeedback : undefined} />}
    </AccessibleTabs.Content></AccessibleTabs.Root>
    <Dialog open={Boolean(guide)} onOpenChange={open => { if (!open) setSelected(null); }} title={guide?.title ?? "Task guide"} description={guide?.summary} size="lg">
      {guide ? <div className="space-y-5">
        {clip ? <div><video key={clip.src} controls playsInline preload="none" poster={clip.poster} className="aspect-video w-full rounded-lg bg-inv" aria-label={`${guide.title} walkthrough`}>
          <source src={clip.src} type="video/mp4" /><track kind="captions" src={clip.captions} srcLang="en" label="English" default />Your browser cannot play this video. Use the written steps below.
        </video><div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted"><p>English narration and captions · Demonstration data · Use fullscreen for a closer look.</p><a href={clip.src} download className="u-draw inline-flex min-h-11 items-center font-medium text-accent">Download video · {(clip.bytes / 1_000_000).toFixed(1)} MB</a></div></div> : null}
        <div><h3 className="text-base">Follow these steps</h3><ol className="mt-3 space-y-3">{guide.steps.map((step, i) => <li key={step} className="flex gap-3 text-sm leading-relaxed"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{i + 1}</span><span>{step}</span></li>)}</ol></div>
        <div className="flex flex-wrap gap-3 border-t border-line pt-4"><a href={guide.href} className="btn inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white">Open this task<ChevronRight className="size-4" /></a><Button variant="secondary" onClick={() => { setSelected(null); sendFeedback(guide.area); }}>I still need help</Button></div>
      </div> : null}
    </Dialog>
    <Dialog open={feedbackOpen} onOpenChange={setFeedbackOpen} title="Send feedback" description="Help us make your daily work easier." size="lg">
      <FeedbackForm key={feedbackArea} area={feedbackArea} onSent={() => { setFeedbackOpen(false); setSent(true); setRefresh(n => n + 1); setTab("mine"); }} />
    </Dialog>
    <p className="flex items-center gap-2 text-xs text-muted"><Check className="size-3.5" />Only tasks available to your role are shown. Some actions also need delegated permissions.</p>
  </div>;
}
