"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm, type ConfirmOptions } from "@/components/ui/confirm-dialog";

/**
 * A submit button for a server-action form that asks first. Confirming
 * submits the form it sits in; cancelling leaves it untouched. The form's
 * own validation (a required field, say) still runs before the question.
 */
export function ConfirmSubmitButton({
  confirm: options,
  variant = "danger-secondary",
  children,
  "aria-label": ariaLabel,
}: {
  confirm: ConfirmOptions;
  variant?: "primary" | "secondary" | "danger" | "danger-secondary";
  children: ReactNode;
  "aria-label"?: string;
}) {
  const confirm = useConfirm();
  return (
    <Button
      type="submit"
      variant={variant}
      aria-label={ariaLabel}
      onClick={async (event) => {
        const form = event.currentTarget.form;
        if (!form) return;
        event.preventDefault();
        if (!form.reportValidity()) return;
        if (await confirm({ tone: "danger", ...options })) form.requestSubmit();
      }}
    >
      {children}
    </Button>
  );
}
