/**
 * The Ziki mark: a Z with a short line through its middle. Drawn in
 * currentColor so it follows the theme; the same shape is the favicon
 * (app/icon.svg), light on a dark tile.
 */
export function ZikiMark({ className = "h-7 w-auto", title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path
        d="M22 22H78L22 78H78M30 50H70"
        stroke="currentColor"
        strokeWidth="11"
        strokeLinejoin="miter"
        strokeMiterlimit="10"
      />
    </svg>
  );
}
