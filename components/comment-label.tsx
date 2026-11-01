/** A comment's short freeform label in its title, e.g. "Blocker" (#comment-label). */
export function CommentLabel({ label }: { label?: string | null }) {
  if (!label) return null;
  return (
    <span data-testid="comment-label" className="rounded-full bg-zk-tint px-2 py-0.5 text-[11px] font-bold text-zk-accent">
      {label}
    </span>
  );
}
