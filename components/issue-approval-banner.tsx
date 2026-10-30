"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";

export type IssueApprovalView = {
  id: string;
  stage: string;
  status: string;
  rule?: {
    issueType?: { name: string } | null;
    fileGlob?: string | null;
  } | null;
};

export function IssueApprovalBanner({
  approval,
  canDecide,
}: {
  approval: IssueApprovalView;
  canDecide: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function handleDecision(decision: "approved" | "rejected") {
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `${BASE_PATH}/api/v1/approvals/${encodeURIComponent(approval.id)}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? `Could not save decision (${decision}).`);
      }
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Decision failed.");
    } finally {
      setPending(false);
    }
  }

  const stageLabel =
    approval.stage === "before_merge"
      ? "before its pull request is merged"
      : "before it can be offered to agents";

  const ruleReasons: string[] = [];
  if (approval.rule?.issueType?.name) {
    ruleReasons.push(`type: ${approval.rule.issueType.name}`);
  }
  if (approval.rule?.fileGlob) {
    ruleReasons.push(`files matching: ${approval.rule.fileGlob}`);
  }

  return (
    <section
      aria-label="Human approval required"
      className="flex flex-col gap-3 rounded-xl border border-zk-warn-bd bg-zk-warn-bg p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-lg" aria-hidden="true">
            ⚠️
          </span>
          <h2 className="text-sm font-semibold text-zk-warn-fg">
            Human approval required
          </h2>
        </div>
        <p className="text-sm text-zk-warn-fg">
          This issue requires workspace approval {stageLabel}.
          {ruleReasons.length ? (
            <span className="ml-1 text-xs text-zk-warn-fg">
              ({ruleReasons.join(", ")})
            </span>
          ) : null}
        </p>
        {error ? (
          <p role="alert" className="text-xs font-medium text-zk-bad-fg">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {canDecide ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => handleDecision("approved")}
              className="inline-flex items-center justify-center rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-teal-800 disabled:opacity-50"
            >
              {pending ? "Saving…" : "Approve"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => handleDecision("rejected")}
              className="inline-flex items-center justify-center rounded-lg border border-zk-border bg-zk-surface px-3 py-1.5 text-xs font-semibold text-zk-text2 shadow-xs hover:bg-zk-chip disabled:opacity-50"
            >
              {pending ? "Saving…" : "Reject"}
            </button>
          </>
        ) : (
          <span className="text-xs italic text-zk-warn-fg">
            Waiting for workspace owner or admin decision
          </span>
        )}
      </div>
    </section>
  );
}
