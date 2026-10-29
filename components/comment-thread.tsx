"use client";

import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { LocalTime } from "@/components/local-time";
import { truncateCommentBody, type CommentNode } from "@/lib/comments";
import { canDeleteComment } from "@/lib/comment-permissions";
import type { AppRole } from "@/lib/roles";
import type { OrganizationRole } from "@/lib/organization-role";
import { deleteCommentAction } from "@/app/actions/comments";
import { CommentBody } from "@/components/comment-body";
import { UserNameWithBadges } from "@/components/user-name-with-badges";
import { CopyLinkButton } from "@/components/copy-link-button";
import { AttachmentList, type AttachmentView } from "@/components/attachment-list";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";

type AttachmentsByComment = Record<string, AttachmentView[]>;
/** Each author's role in the issue's organization, by user id (#489). */
type OrganizationRoles = Record<string, OrganizationRole>;
type ViewerProps = {
  currentUserId?: string;
  currentUserRole?: AppRole | null;
  tenantAdmin?: boolean;
  /** A deleted issue: not even its author's own delete. */
  readOnly?: boolean;
};

type UserOption = { id: string; name: string };

/**
 * Small pencil button that opens the comment's actions. Earlier comments are
 * read-only (#entry-replies-only), so the one action is deleting your own. A
 * disclosure, not an ARIA menu: Escape closes it and puts focus back on the
 * pencil.
 */
function CommentActionsMenu({ deleting, onDelete }: { deleting: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Focus inside the popup would fall to the page once it unmounts.
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Comment actions"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zk-muted hover:bg-zk-chip hover:text-zk-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.4 12.7l-3 .8.8-3z" />
        </svg>
      </button>
      {open ? (
        <span
          id={panelId}
          className="absolute right-0 top-7 z-20 min-w-28 overflow-hidden rounded-lg border border-zk-border bg-zk-surface py-1 shadow-lg"
        >
          <button
            type="button"
            disabled={deleting}
            className="block w-full px-3 py-1.5 text-left text-[13px] text-zk-bad-fg hover:bg-zk-chip focus-visible:bg-zk-chip focus-visible:outline-none disabled:opacity-50"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </span>
      ) : null}
    </span>
  );
}

function CommentItem({
  comment,
  issueUrl,
  reporterId,
  users,
  currentUserId,
  currentUserRole,
  tenantAdmin = false,
  attachmentsByComment = {},
  organizationRoles = {},
  readOnly = false,
}: {
  comment: CommentNode;
  /** Canonical issue URL, for each comment's permalink (#279). */
  issueUrl: string;
  reporterId: string;
  users: UserOption[];
  attachmentsByComment?: AttachmentsByComment;
  organizationRoles?: OrganizationRoles;
} & ViewerProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const toast = useToast();
  const isDeleted = Boolean(comment.deletedAt);
  const canDelete = !readOnly && canDeleteComment(currentUserId, currentUserRole, comment, tenantAdmin);

  const handleDelete = async () => {
    const own = comment.authorId === currentUserId;
    const confirmed = await confirm({
      title: own ? "Delete your comment?" : `Delete ${comment.author.name}'s comment?`,
      body: own
        ? "Replies will stay, and the comment will show as deleted."
        : "This is recorded in the activity log.",
      confirmLabel: "Delete comment",
      tone: "danger",
    });
    if (!confirmed) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteCommentAction(comment.id);
      if (result.error) {
        setError(result.error);
        toast(result.error, "error");
      } else {
        toast("Comment deleted.");
      }
    });
  };

  return (
    <li
      id={`comment-${comment.id}`}
      // :target is the comment a permalink points at (#279); the highlight
      // needs no script, so it works on first load and on hash changes.
      // break-inside keeps a comment whole across printed pages (#300).
      className="group/comment scroll-mt-24 space-y-3 break-inside-avoid"
    >
      <article className="flex flex-col gap-2.5 rounded-xl border border-zk-border bg-zk-surface px-4 py-3 group-target/comment:border-zk-accent group-target/comment:bg-zk-tint group-target/comment:ring-2 group-target/comment:ring-electric-blue/40 motion-safe:transition-colors">
        {isDeleted ? (
          <p className="text-sm italic text-zk-muted">This comment was deleted.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-zk-muted">
              <div className="flex flex-wrap items-center gap-2">
                <UserNameWithBadges
                  name={comment.author.name}
                  role={comment.author.role}
                  organizationRole={organizationRoles[comment.authorId]}
                  image={comment.author.image}
                  avatar="sm"
                  userId={comment.authorId}
                  showAuthor={comment.authorId === reporterId}
                  agentName={comment.agent?.name}
                  className="font-bold text-zk-text"
                />
              </div>
              <span className="inline-flex items-center gap-1.5">
                <a href={`#comment-${comment.id}`} className="hover:text-zk-text hover:underline">
                  <LocalTime compact date={comment.createdAt} />
                </a>
                <CopyLinkButton url={`${issueUrl}#comment-${comment.id}`} label="comment" compact />
                {comment.editedAt ? <span title="This comment was edited">· edited</span> : null}
                {canDelete ? <CommentActionsMenu deleting={pending} onDelete={handleDelete} /> : null}
              </span>
            </div>

            {comment.parent ? (
              <p className="mt-2 rounded-md bg-card/80 px-2.5 py-1.5 text-xs text-zk-muted break-words">
                Replying to <span className="font-bold text-zk-text">{comment.parent.author.name}</span>
                {": "}
                <span className="italic text-zk-text2">
                  {comment.parent.deletedAt ? "deleted comment" : truncateCommentBody(comment.parent.body)}
                </span>
              </p>
            ) : null}

            <CommentBody body={comment.body} users={users} />
            <AttachmentList attachments={attachmentsByComment[comment.id] ?? []} />
          </>
        )}
        {error ? (
          <p className="text-xs text-zk-bad-fg" role="alert">
            {error}
          </p>
        ) : null}
      </article>

      {comment.children.length > 0 ? (
        <ul className="ml-2.5 space-y-3 border-l border-zk-divider pl-2.5 sm:ml-6 sm:pl-4">
          {comment.children.map((child) => (
            <CommentItem
              key={child.id}
              comment={child}
              issueUrl={issueUrl}
              reporterId={reporterId}
              users={users}
              currentUserId={currentUserId}
              currentUserRole={currentUserRole}
              tenantAdmin={tenantAdmin}
              attachmentsByComment={attachmentsByComment}
              organizationRoles={organizationRoles}
              readOnly={readOnly}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

type ThreadProps = {
  issueUrl: string;
  reporterId: string;
  comments: CommentNode[];
  /** For rendering @mentions in comment bodies. */
  users: UserOption[];
  /** Files attached to each comment, by comment id (#215). */
  attachmentsByComment?: AttachmentsByComment;
  organizationRoles?: OrganizationRoles;
} & ViewerProps;

/**
 * Comments from before an issue's stages took entries (#entry-replies-only),
 * with their replies: read-only. Nobody replies to or edits them; an author
 * (or an admin) may still delete one.
 */
export function CommentThread({ comments, ...props }: ThreadProps) {
  if (comments.length === 0) return null;
  return (
    <ul className="space-y-3">
      {comments.map((comment) => (
        <CommentItem key={comment.id} comment={comment} {...props} />
      ))}
    </ul>
  );
}

/** Whether the URL's #fragment points at an element inside `root`. */
function hashTargetsInside(root: HTMLElement | null): boolean {
  const id = typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.slice(1));
  if (!root || !id) return false;
  const target = document.getElementById(id);
  return Boolean(target && root.contains(target));
}

/**
 * The "Earlier comments (N)" section of the issue page: collapsed, and opened
 * by a permalink to one of its comments.
 */
export function EarlierComments({
  count,
  defaultOpen = false,
  children,
  ...props
}: ThreadProps & {
  /** Shown under the comments, e.g. "Show earlier". */
  children?: ReactNode;
  /** Top-level comments, shown in the summary. */
  count: number;
  /** Open on load, e.g. when the page was asked for one of these comments. */
  defaultOpen?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const openForHash = () => {
      if (ref.current && hashTargetsInside(ref.current)) ref.current.open = true;
    };
    openForHash();
    window.addEventListener("hashchange", openForHash);
    return () => window.removeEventListener("hashchange", openForHash);
  }, []);

  if (count === 0) return null;
  return (
    <details ref={ref} open={defaultOpen || undefined} className="group mt-4" data-testid="earlier-comments">
      <summary className="cursor-pointer list-none text-xs font-bold uppercase tracking-[0.08em] text-zk-muted hover:text-zk-text [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="mr-1 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        Earlier comments ({count})
      </summary>
      <p className="mb-3 mt-2 text-[13px] text-zk-muted">
        Written before issues took stage entries. They are kept as they were and can&apos;t be replied to.
      </p>
      <CommentThread {...props} />
      {children}
    </details>
  );
}
