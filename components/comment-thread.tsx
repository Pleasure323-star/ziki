"use client";

import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { EntryReplyForm } from "@/components/entry-reply-form";
import { LocalTime } from "@/components/local-time";
import { truncateCommentBody, type CommentNode } from "@/lib/comments";
import { canDeleteComment } from "@/lib/comment-permissions";
import type { AppRole } from "@/lib/roles";
import type { OrganizationRole } from "@/lib/organization-role";
import { deleteCommentAction, upvoteCommentAction } from "@/app/actions/comments";
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
  /** Set while the issue is Open: top-level comments take replies. */
  replyBugId?: string;
  /**
   * The people who marked the issue important (#729): an agent's comment says
   * so when its owner is one of them. Issue votes are a plain importance
   * toggle, so there is no downvote to show.
   */
  markedImportantBy?: readonly string[];
};

type UserOption = { id: string; name: string };

/**
 * Small pencil button that opens the comment's actions. Comments aren't
 * edited, so the one action is deleting your own. A
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

/**
 * A comment's upvotes (#comment-votes): a small button with the count. Each
 * upvote from another person earns the comment's author 1 point. People
 * upvote while the issue is Open, once each, and never their own comment;
 * otherwise the count shows on its own.
 */
function CommentUpvote({
  commentId,
  voters,
  currentUserId,
  canVote,
  own,
}: {
  commentId: string;
  voters: string[];
  currentUserId?: string;
  canVote: boolean;
  own: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [votes, setVotes] = useState(voters.length);
  const [voted, setVoted] = useState(Boolean(currentUserId && voters.includes(currentUserId)));
  const toast = useToast();
  if (!canVote && votes === 0) return null;
  const label = `${votes} ${votes === 1 ? "upvote" : "upvotes"}`;
  if (!canVote || own) {
    return (
      <span className="inline-flex items-center gap-1 text-xs tabular-nums text-zk-muted" title={own ? "Others upvote your comment; each upvote earns you 1 point." : label}>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6" /></svg>
        <span>{votes}</span>
        <span className="sr-only">{votes === 1 ? " upvote" : " upvotes"}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={pending || voted}
      aria-pressed={voted}
      aria-label={voted ? `You upvoted this comment, ${label}` : `Upvote this comment, ${label}`}
      title={voted ? "You upvoted this comment" : "Upvote a helpful comment: its author earns 1 point"}
      onClick={() => {
        startTransition(async () => {
          const result = await upvoteCommentAction(commentId);
          if (result.error) {
            toast(result.error, "error");
            return;
          }
          setVoted(true);
          if (typeof result.votes === "number") setVotes(result.votes);
        });
      }}
      className={`inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs font-semibold tabular-nums transition-colors disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong ${
        voted ? "border-zk-accent bg-zk-tint text-zk-accent" : "border-zk-border text-zk-muted hover:bg-zk-chip hover:text-zk-text"
      }`}
    >
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6" /></svg>
      <span>{votes}</span>
    </button>
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
  replyBugId,
  markedImportantBy = [],
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
                {comment.agentId && markedImportantBy.includes(comment.authorId) ? (
                  <span
                    className="rounded-full bg-zk-ok-bg px-2 py-0.5 text-[11px] font-semibold text-zk-ok-fg"
                    title={`${comment.author.name} marked this issue important`}
                    data-testid="comment-author-marked-important"
                  >
                    Marked important
                  </span>
                ) : null}
              </div>
              <span className="inline-flex items-center gap-1.5">
                <a href={`#comment-${comment.id}`} className="hover:text-zk-text hover:underline">
                  <LocalTime date={comment.createdAt} />
                </a>
                <CopyLinkButton url={`${issueUrl}#comment-${comment.id}`} label="comment" compact />
                {comment.editedAt ? <span title="This comment was edited">· edited</span> : null}
                <CommentUpvote
                  commentId={comment.id}
                  voters={(comment.votes ?? []).map((vote) => vote.onBehalfOfUserId)}
                  currentUserId={currentUserId}
                  canVote={Boolean(replyBugId) && !readOnly && Boolean(currentUserId)}
                  own={comment.authorId === currentUserId}
                />
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

            {/* #730: an agent's comment leads with its point, then the full body. */}
            {comment.summary ? (
              <p className="mt-2 text-sm font-semibold leading-snug text-zk-text" data-testid="comment-summary">{comment.summary}</p>
            ) : null}
            <CommentBody body={comment.body} users={users} />
            <AttachmentList attachments={attachmentsByComment[comment.id] ?? []} />
            {replyBugId && !readOnly && !comment.parentId ? (
              <EntryReplyForm bugId={replyBugId} target={{ parentId: comment.id }} label="Reply to this comment" />
            ) : null}
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
              replyBugId={replyBugId}
              markedImportantBy={markedImportantBy}
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
 * The comments on the issue itself, with their replies. While the issue is
 * Open (`replyBugId` set) anyone may reply to a top-level comment; an author
 * (or an admin) may delete their own.
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

/**
 * The issue's Comments section: the comment box while the issue is Open
 * (`composer`), then the comments, newest threads first as loaded.
 */
export function IssueComments({
  count,
  composer,
  children,
  ...props
}: ThreadProps & {
  /** Top-level comments. */
  count: number;
  /** The comment box, shown only while the issue takes comments. */
  composer?: ReactNode;
  /** Shown under the comments, e.g. "Show earlier". */
  children?: ReactNode;
}) {
  if (count === 0 && !composer) return null;
  return (
    <section aria-labelledby="comments-heading" className="mt-5" data-testid="issue-comments">
      <h3 id="comments-heading" className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-zk-muted">
        Comments
        <span className="font-mono font-normal normal-case tracking-normal">{count}</span>
      </h3>
      {composer}
      <CommentThread {...props} />
      {children}
    </section>
  );
}

