"use client";

import { useEffect } from "react";
import Link from "next/link";
import {
  StatusPage,
  primaryActionClass,
  secondaryActionClass,
} from "@/components/status-page";
import { databaseErrorReason } from "@/lib/db-error";

/**
 * Error boundary for every signed-in page (#214). Shows a retry instead of
 * Next's bare "Application error" screen. In production the message from a
 * server error is generic; `digest` matches the entry in the server logs.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[app:error]", error.digest ?? "", error);
  }, [error]);

  const reason = databaseErrorReason(error);

  return (
    <StatusPage
      title="This page didn't load"
      actions={
        <>
          <button type="button" onClick={() => retry()} className={primaryActionClass}>
            Try again
          </button>
          <Link href="/dashboard" className={secondaryActionClass}>
            Go to issues
          </Link>
        </>
      }
    >
      <p>
        {reason ??
          "Something went wrong on our side while loading this page. Trying again usually works. If it keeps happening, report it with the reference below."}
      </p>
      {error.digest ? (
        <p className="text-xs text-slate-500">
          Reference: <code className="rounded bg-slate-100 px-1 py-0.5">{error.digest}</code>
        </p>
      ) : null}
    </StatusPage>
  );
}
