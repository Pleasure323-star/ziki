"use client";

import { useRef, useState } from "react";
import { ConfirmationForm } from "@/components/confirmation-form";

type Initial = Parameters<typeof ConfirmationForm>[0]["initial"];

/**
 * "Add confirmation" opens the confirmation form in a modal, as "Add verdict"
 * does on an idea (#issue-confirmations). Once you have given one it reads
 * "Update confirmation" and opens with yours filled in. It closes on save.
 */
export function AddConfirmationDialog({
  bugId,
  summaryMaxChars,
  mine,
}: {
  bugId: string;
  summaryMaxChars: number;
  /** The viewer's current entry, when they have given one. */
  mine: Initial;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const label = mine ? "Update confirmation" : "Add confirmation";

  const show = () => {
    setOpen(true);
    dialogRef.current?.showModal();
  };
  const close = () => dialogRef.current?.close();

  return (
    <>
      <button
        type="button"
        onClick={show}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zk-border bg-zk-surface px-3 text-[13px] font-medium text-zk-text hover:bg-zk-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong print:hidden"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {label}
      </button>
      <dialog
        ref={dialogRef}
        aria-label={label}
        onClose={() => setOpen(false)}
        className="m-auto w-[min(44rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-zk-border bg-zk-surface p-0 text-zk-text shadow-[0_24px_56px_rgba(11,23,51,0.22)] backdrop:bg-black/40"
      >
        <div className="relative p-5 sm:p-6">
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-lg text-zk-muted hover:bg-zk-chip hover:text-zk-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-electric-blue-strong"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
          <h2 className="m-0 mb-4 text-base font-bold text-zk-text">{label}</h2>
          {open ? <ConfirmationForm bugId={bugId} summaryMaxChars={summaryMaxChars} initial={mine} onSaved={close} /> : null}
        </div>
      </dialog>
    </>
  );
}
