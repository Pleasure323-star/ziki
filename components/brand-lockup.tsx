import Link from "next/link";
import { ZikiMark } from "@/components/ziki-mark";

type BrandLockupProps = {
  /** When set, wraps the mark in a link. Omit on auth pages. */
  href?: string;
  size?: "sm" | "md";
  /** "chrome" paints the mark light, for a dark header. */
  tone?: "default" | "chrome";
};

const sizes = {
  sm: "h-7 w-7",
  md: "h-11 w-11",
} as const;

/** The Ziki logo: the mark alone (a Z with a line through it), no wordmark; its name says Ziki. */
export function BrandLockup({ href, size = "sm", tone = "default" }: BrandLockupProps) {
  const content = <ZikiMark className={`${sizes[size]} ${tone === "chrome" ? "text-porcelain" : "text-slate-900"}`} />;

  if (!href) {
    return (
      <div className="inline-flex items-center" role="img" aria-label="Ziki">
        {content}
      </div>
    );
  }

  return (
    <Link
      href={href}
      className={`inline-flex items-center rounded-md ${
        tone === "chrome"
          ? "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-tint focus-visible:ring-offset-2 focus-visible:ring-offset-deep-ocean"
          : ""
      }`}
      aria-label="Ziki"
    >
      {content}
    </Link>
  );
}
