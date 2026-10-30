import Link from "next/link";
import { formatProofLinkLabel } from "@/lib/proof-links";
import { ideaPath } from "@/lib/issue-ref";

export type IssueLinksProps = {
  links: string[];
  /** The issue's attached pull request, shown here even when it is not in the link list. */
  linkedPullRequestUrl?: string | null;
  /** The idea the issue was converted from. */
  idea?: { number: number } | null;
};

function ExternalLinkIcon({ className }: { className: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
      />
    </svg>
  );
}

/**
 * The issue's Links, in the side rail: its GitHub pull request links and the
 * idea it came from. The agent delivering the work links its pull request.
 */
export function IssueLinks({ links: proofLinks, linkedPullRequestUrl, idea = null }: IssueLinksProps) {
  const links = linkedPullRequestUrl && !proofLinks.includes(linkedPullRequestUrl)
    ? [linkedPullRequestUrl, ...proofLinks]
    : proofLinks;

  return (
    <section aria-label="Links" className="rounded-[20px] border border-zk-border bg-zk-surface px-4 py-3.5">
      <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">Links</h2>
      <dl className="mt-3 flex flex-col gap-2.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <dt className="w-16 shrink-0 whitespace-nowrap text-xs leading-5 text-zk-muted">GitHub PR</dt>
          <dd className="m-0 min-w-0">
            {links.length === 0 ? (
              <span className="text-xs leading-5 text-zk-muted">None linked yet.</span>
            ) : (
              <ul className="m-0 list-none space-y-1.5 p-0">
                {links.map((url, index) => (
                  <li key={`${index}-${url}`}>
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={url}
                      className="inline-flex items-center gap-1.5 break-all text-xs font-medium leading-5 text-zk-accent hover:underline"
                    >
                      <ExternalLinkIcon className="h-3.5 w-3.5 shrink-0 text-zk-muted" />
                      <span>{formatProofLinkLabel(url)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        {idea ? (
          <div className="flex min-w-0 items-baseline gap-3">
            <dt className="w-16 shrink-0 whitespace-nowrap text-xs leading-5 text-zk-muted">Idea</dt>
            <dd className="m-0 min-w-0">
              <Link href={ideaPath(idea.number)} data-testid="source-idea-link" className="text-xs font-medium leading-5 text-zk-accent hover:underline">
                Idea #{idea.number}
              </Link>
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
