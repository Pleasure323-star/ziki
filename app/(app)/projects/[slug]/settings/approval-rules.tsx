import { createApprovalRuleAction, deleteApprovalRuleAction } from "@/app/(app)/projects/actions";
import { Button } from "@/components/ui/button";

export type ApprovalRuleView = {
  id: string;
  stage: string;
  issueTypeId: string | null;
  fileGlob: string | null;
  issueType?: { id: string; name: string } | null;
};

export function ProjectApprovalRulesSection({
  projectId,
  slug,
  rules,
  issueTypes,
}: {
  projectId: string;
  slug: string;
  rules: ApprovalRuleView[];
  issueTypes: { id: string; name: string }[];
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-zk-text">
          Human approval rules
        </h2>
        <p className="text-sm text-zk-text2">
          Configure gates where issues must wait for human approval before they can be offered to agents or merged.
        </p>
      </div>

      {rules.length ? (
        <ul className="divide-y divide-zk-border rounded-full border border-zk-border bg-zk-surface">
          {rules.map((rule) => {
            const stageLabel =
              rule.stage === "before_merge" ? "Before merge" : "Before offer";
            const typeLabel = rule.issueType?.name ?? "Any type";
            const fileLabel = rule.fileGlob ? `Files: ${rule.fileGlob}` : null;

            return (
              <li
                key={rule.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-md bg-zk-warn-bg px-2 py-0.5 text-xs font-semibold text-zk-warn-fg border border-zk-warn-bd">
                      {stageLabel}
                    </span>
                    <span className="text-sm font-medium text-zk-text">
                      {typeLabel}
                    </span>
                  </div>
                  {fileLabel ? (
                    <p className="text-xs text-zk-text2 font-mono">
                      {fileLabel}
                    </p>
                  ) : null}
                </div>

                <form action={deleteApprovalRuleAction} className="shrink-0">
                  <input type="hidden" name="ruleId" value={rule.id} />
                  <input type="hidden" name="slug" value={slug} />
                  <button
                    type="submit"
                    className="text-xs font-medium text-rose-600 hover:text-rose-800 hover:underline"
                  >
                    Delete
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-zk-muted italic">
          No approval rules configured for this project yet.
        </p>
      )}

      <div className="rounded-xl border border-zk-border bg-zk-tint/50 p-4">
        <h3 className="text-sm font-semibold text-zk-text mb-3">
          Add approval rule
        </h3>
        <form action={createApprovalRuleAction} className="space-y-3">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="slug" value={slug} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="rule-stage"
                className="block text-xs font-medium text-zk-text2 mb-1"
              >
                Gate stage
              </label>
              <select
                id="rule-stage"
                name="stage"
                defaultValue="before_merge"
                className="w-full rounded-xl border border-zk-border bg-zk-surface px-3 py-1.5 text-xs text-zk-text shadow-2xs focus:border-electric-blue focus:outline-hidden"
              >
                <option value="before_merge">Before merge</option>
                <option value="before_offer">Before offer</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="rule-type"
                className="block text-xs font-medium text-zk-text2 mb-1"
              >
                Issue type
              </label>
              <select
                id="rule-type"
                name="issueTypeId"
                defaultValue=""
                className="w-full rounded-xl border border-zk-border bg-zk-surface px-3 py-1.5 text-xs text-zk-text shadow-2xs focus:border-electric-blue focus:outline-hidden"
              >
                <option value="">Any issue type</option>
                {issueTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label
              htmlFor="rule-glob"
              className="block text-xs font-medium text-zk-text2 mb-1"
            >
              Changed file glob (optional, for before merge)
            </label>
            <input
              id="rule-glob"
              type="text"
              name="fileGlob"
              placeholder="e.g. app/(app)/billing/**"
              className="w-full rounded-xl border border-zk-border bg-zk-surface px-3 py-1.5 text-xs text-zk-text shadow-2xs focus:border-electric-blue focus:outline-hidden"
            />
          </div>

          <div>
            <Button type="submit" className="text-xs px-3 py-1.5">
              Add rule
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
