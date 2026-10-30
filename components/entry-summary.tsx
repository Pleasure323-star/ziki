import { RichText } from "@/components/rich-text";

const DESCRIPTION_CLASS =
  "rich-text mt-1.5 space-y-2 [overflow-wrap:anywhere] break-words text-[13px] leading-[1.5] text-zk-text2 [&_a]:font-medium [&_a]:text-zk-accent [&_a]:underline [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-zk-chip [&_:not(pre)>code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-slate-900 [&_pre]:p-3 [&_pre]:text-slate-100 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5";

/**
 * An entry's summary, and its full description behind a chevron: click the
 * summary line (or the chevron) to expand it. The description is Markdown.
 */
export function EntrySummary({ summary, description }: { summary: string; description: string }) {
  return (
    <details className="group/entry mt-1" data-testid="entry-summary">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 break-words text-[13px] leading-[1.5] text-zk-text">{summary}</span>
        <span className="sr-only">Full description</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="mt-0.5 h-4 w-4 shrink-0 text-zk-muted transition-transform group-open/entry:rotate-180 group-hover/entry:text-zk-text"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 7.5l5 5 5-5" />
        </svg>
      </summary>
      <RichText content={description} className={DESCRIPTION_CLASS} />
    </details>
  );
}

/** A comment's text under an entry, as Markdown. */
export function EntryText({ body }: { body: string }) {
  return <RichText content={body} className="rich-text mt-0.5 space-y-1.5 [overflow-wrap:anywhere] break-words text-[13px] leading-[1.5] text-zk-text [&_a]:text-zk-accent [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5" />;
}
