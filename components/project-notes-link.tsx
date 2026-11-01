import Link from "next/link";

/** The project's notes, `/<slug>/notes` (#project-urls). */
export function ProjectNotesLink({ slug }: { slug: string }) {
  return <Link href={`/${encodeURIComponent(slug)}/notes`} aria-label="Project notes" title="Project notes" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zk-border text-zk-text2 transition hover:bg-zk-chip focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zk-accent"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="3" width="15" height="18" rx="2" /><path d="M9 3v18M3 7h4M3 12h4M3 17h4M12 8h5M12 12h5" /></svg></Link>;
}
