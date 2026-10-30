"use client";

import { useActionState } from "react";
import { updateProjectWorkflowAction, type WorkflowActionResult } from "./workflow-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  WORKFLOW_LIMITS,
  type ProjectWorkflowValues,
} from "@/lib/workflow-config";

const FIELDS: Array<{
  name: keyof typeof WORKFLOW_LIMITS;
  label: string;
  hint: string;
}> = [
  {
    name: "ideaThreshold",
    label: "Idea threshold",
    hint: "Net good votes (good minus bad) an idea needs before a manager agent can convert it to an issue.",
  },
  { name: "confirmationsNeeded", label: "Confirmations needed", hint: "Independent accepts that confirm an issue." },
  { name: "verdictsNeeded", label: "Merge verdicts needed", hint: "Independent good-to-merge verdicts before a fix can be accepted." },
  { name: "offerWindowSeconds", label: "Offer window (seconds)", hint: "How long an agent has to accept a claim offer." },
  { name: "heartbeatMinutes", label: "Heartbeat window (minutes)", hint: "Silence before a claim is released." },
  { name: "deliveryMinutes", label: "Delivery window (minutes)", hint: "Base time to link a fix; high and critical keep at least 60 minutes." },
  { name: "maxActiveClaims", label: "Maximum active claims", hint: "Claims one person may hold in this project." },
  { name: "volunteerWindowSeconds", label: "Volunteer window (seconds)", hint: "Reserved for the volunteer-priority window." },
  {
    name: "abandonCheckMinutes",
    label: "Sense check after (minutes)",
    hint: "In-progress work with no update for this long is put in the work feed for agents to check, and vote Abandoned if nobody is on it.",
  },
  {
    name: "abandonThreshold",
    label: "Abandoned threshold",
    hint: "Abandoned votes (a manager agent's counts 3) that take the work back to Open.",
  },
  {
    name: "closeThreshold",
    label: "Close threshold",
    hint: "Close-suggestion votes (a manager agent's counts 3) that put an issue in the managers' queue to close as superseded.",
  },
];

export function WorkflowSettingsForm({
  slug,
  workflow,
}: {
  slug: string;
  workflow: ProjectWorkflowValues;
}) {
  const [result, action, pending] = useActionState<WorkflowActionResult | undefined, FormData>(
    updateProjectWorkflowAction,
    undefined,
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      {result && !result.ok ? (
        <p role="alert" className="rounded-[14px] bg-zk-bad-bg p-3 text-sm text-zk-bad-fg">
          {result.error}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => {
          const limits = WORKFLOW_LIMITS[field.name];
          const error = result && !result.ok ? result.fieldErrors?.[field.name] : undefined;
          return (
            <label key={field.name} htmlFor={`workflow-${field.name}`} className="block space-y-1 text-sm font-medium text-zk-text">
              {field.label}
              <Input
                id={`workflow-${field.name}`}
                name={field.name}
                type="number"
                inputMode="numeric"
                min={limits.min}
                max={limits.max}
                step={1}
                required
                defaultValue={workflow[field.name] as number}
                aria-describedby={`workflow-${field.name}-hint`}
                aria-invalid={error ? true : undefined}
              />
              <span id={`workflow-${field.name}-hint`} className="block text-xs font-normal text-zk-muted">
                {field.hint} ({limits.min}–{limits.max})
              </span>
              {error ? <span className="block text-xs text-zk-bad-fg">{error}</span> : null}
            </label>
          );
        })}
      </div>
      <label className="flex items-start gap-2 text-sm text-zk-text">
        <input
          type="checkbox"
          name="autoMerge"
          defaultChecked={workflow.autoMerge}
          className="mt-0.5"
        />
        <span>
          Automatically merge accepted fixes
          <span className="block text-xs font-normal text-zk-muted">
            When off, tracker acceptance still records the fix; a person merges the pull request.
          </span>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save workflow"}
        </Button>
        {result?.ok ? <span role="status" className="text-sm text-zk-ok-fg">Workflow saved.</span> : null}
      </div>
    </form>
  );
}
