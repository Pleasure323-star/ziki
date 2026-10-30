"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SOLVER_POINTS, REPORTER_POINTS, REVIEWER_POINTS } from "@/lib/points/rules";
import type { ProjectRewardConfig } from "@/lib/points/project-rewards";

interface ProjectRewardRulesSectionProps {
  initialConfig?: ProjectRewardConfig | null;
  /** Platform (or hard-coded) defaults shown when the project has no override. */
  defaults?: ProjectRewardConfig | null;
  disabled?: boolean;
}

export function ProjectRewardRulesSection({
  initialConfig,
  defaults = null,
  disabled = false,
}: ProjectRewardRulesSectionProps) {
  const [open, setOpen] = useState(false);
  const fallback = defaults ?? {
    solver: SOLVER_POINTS,
    reporter: REPORTER_POINTS,
    reviewer: REVIEWER_POINTS,
    guidelines: null,
  };

  return (
    <div className="rounded-xl border border-zk-border bg-zk-tint/70 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zk-text">Reward & Points Rules</h3>
          <p className="text-xs text-zk-muted">
            Define custom reward bounties for solvers, reporters, and reviewers in this project.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="text-xs font-medium text-zk-accent hover:text-zk-accent"
        >
          {open ? "Hide custom rules" : "Customize rewards"}
        </button>
      </div>

      {open ? (
        <div className="mt-4 space-y-4 border-t border-zk-border pt-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="solverPoints" className="block text-xs font-semibold uppercase tracking-wider text-zk-text2">
                Solver points
              </label>
              <p className="text-xs text-zk-muted">Points awarded when an issue is resolved.</p>
              <Input
                id="solverPoints"
                type="number"
                name="solverPoints"
                defaultValue={initialConfig?.solver ?? fallback.solver}
                min={0}
                max={1_000_000}
                disabled={disabled}
                className="mt-1"
              />
            </div>
            <div>
              <label htmlFor="reporterPoints" className="block text-xs font-semibold uppercase tracking-wider text-zk-text2">
                Reporter bounty
              </label>
              <p className="text-xs text-zk-muted">Points awarded when an issue is confirmed.</p>
              <Input
                id="reporterPoints"
                type="number"
                name="reporterPoints"
                defaultValue={initialConfig?.reporter ?? fallback.reporter}
                min={0}
                max={1_000_000}
                disabled={disabled}
                className="mt-1"
              />
            </div>
            <div>
              <label htmlFor="reviewerPoints" className="block text-xs font-semibold uppercase tracking-wider text-zk-text2">
                Reviewer bounty
              </label>
              <p className="text-xs text-zk-muted">Points awarded for accepted merge verdicts.</p>
              <Input
                id="reviewerPoints"
                type="number"
                name="reviewerPoints"
                defaultValue={initialConfig?.reviewer ?? fallback.reviewer}
                min={0}
                max={1_000_000}
                disabled={disabled}
                className="mt-1"
              />
            </div>
          </div>

          <div>
            <label htmlFor="rewardGuidelines" className="block text-xs font-semibold uppercase tracking-wider text-zk-text2">
              Earning guidelines / notes
            </label>
            <p className="text-xs text-zk-muted">
              Ways points can be earned in this project (e.g. security audits, test suites).
            </p>
            <Textarea
              id="rewardGuidelines"
              name="rewardGuidelines"
              rows={2}
              placeholder="e.g. Extra 50 point bonus for full end-to-end regression tests."
              defaultValue={initialConfig?.guidelines ?? ""}
              maxLength={2000}
              disabled={disabled}
              className="mt-1"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
