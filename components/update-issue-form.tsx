"use client";

import { useEffect, useState, useTransition } from "react";
import type { Severity, Status } from "@prisma/client";
import { updateBugAction } from "@/app/actions/issues";
import { severities, statuses } from "@/lib/validations/issue";
import { severityLabel, statusLabel } from "@/lib/labels";
import type { AppRole } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RESOLUTION_NOTE_MAX, isFinishedStatus } from "@/lib/resolution-note";
import { AssigneeCombobox } from "@/components/assignee-combobox";
import { triageFieldsKey } from "@/lib/triage-options";

type UserOption = { id: string; name: string; role: AppRole; image?: string | null };
type CategoryOption = { id: string; name: string };
type AreaOption = { id: string; name: string };
type TypeOption = { id: string; name: string };
type MilestoneOption = { id: string; title: string; isClosed: boolean };

/** The editable triage fields, as strings so they compare cleanly. */
type Draft = {
  status: string;
  typeId: string;
  severity: string;
  categoryId: string;
  areaId: string;
  assigneeId: string;
  milestoneId: string;
};

const sameDraft = (a: Draft, b: Draft) =>
  (Object.keys(a) as (keyof Draft)[]).every((k) => a[k] === b[k]);

const selectClass =
  "h-11 w-full rounded-xl border border-zk-border bg-zk-surface px-3 py-2 text-sm text-zk-text shadow-xs focus:border-electric-blue-strong focus:outline-none focus:ring-1 focus:ring-electric-blue-strong";

export function UpdateIssueForm({
  bugId,
  status,
  severity,
  typeId,
  assigneeId,
  categoryId,
  areaId,
  milestoneId,
  users,
  categories = [],
  areas = [],
  types = [],
  milestones = [],
  canEditTriage = true,
}: {
  bugId: string;
  status: Status;
  severity: Severity;
  typeId?: string | null;
  assigneeId: string | null;
  categoryId?: string | null;
  areaId?: string | null;
  /** #289: the issue's milestone, if any. */
  milestoneId?: string | null;
  users: UserOption[];
  categories?: CategoryOption[];
  areas?: AreaOption[];
  types?: TypeOption[];
  /** Open milestones, plus the current one even if it was since closed. */
  milestones?: MilestoneOption[];
  /** Admins can edit severity/type/category/assignee; assignees only change status. */
  canEditTriage?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const markSaved = (isSaved: boolean) => {
    setSaved(isSaved);
    setSavedAt(isSaved ? new Date() : null);
  };
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  // What the server currently holds.
  const serverDraft: Draft = {
    status,
    typeId: typeId ?? "",
    severity,
    categoryId: categoryId ?? "",
    areaId: areaId ?? "",
    assigneeId: assigneeId ?? "",
    milestoneId: milestoneId ?? "",
  };

  // The selects are controlled: `defaultValue` is only read when the node
  // mounts, so after a save + revalidate React kept the pre-save value on
  // screen while the badge above showed the new one (#TRIAGE-REVERT).
  const [draft, setDraft] = useState<Draft>(serverDraft);
  const [lastServer, setLastServer] = useState<Draft>(serverDraft);

  // Adopt a change made elsewhere (another admin, or our own save) without
  // throwing away edits in progress. Adjusted during render, not in an effect.
  if (!sameDraft(lastServer, serverDraft)) {
    const wasUnedited = sameDraft(draft, lastServer);
    setLastServer(serverDraft);
    if (wasUnedited) setDraft(serverDraft);
  }

  const dirty = !sameDraft(draft, serverDraft);
  // #316: only a move into resolved/closed can carry a note.
  const asksForNote = draft.status !== status && isFinishedStatus(draft.status);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    markSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  // Unsaved triage edits used to disappear silently: everything else on this
  // page saves on its own, so only this panel needs an explicit Save.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <form
      className="space-y-3 rounded-[20px] border border-zk-border bg-zk-surface p-5"
      /* Submitted by hand rather than through the `action` prop: React 19
         resets a form after an action runs, which wiped the selects back to
         their pre-save value even though state held the new one. The fields
         are controlled, so the payload is built from state. */
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        markSaved(false);
        const formData = new FormData();
        // Ziki #713: the status moves on its own as agents work, so it is never sent.
        if (canEditTriage) {
          formData.set("typeId", draft.typeId);
          formData.set("severity", draft.severity);
          formData.set("categoryId", draft.categoryId);
          formData.set("areaId", draft.areaId);
          formData.set("assigneeId", draft.assigneeId);
          formData.set("milestoneId", draft.milestoneId);
        } else if (assigneeId) {
          formData.set("assigneeId", draft.assigneeId);
        }
        startTransition(async () => {
          const result = await updateBugAction(bugId, formData);
          if (result.error) {
            setError(result.error);
          } else {
            markSaved(true);
            setNote("");
          }
        });
      }}
    >
      <h2 className="text-sm font-semibold text-zk-text">
        {canEditTriage ? "Triage" : "Update status"}
      </h2>
      {/* Remount the fields when the saved values change so they never show
          (and re-submit) stale values after a save (#261). */}
      <div
        key={triageFieldsKey({ status, severity, typeId, categoryId, areaId, assigneeId, milestoneId })}
        className={
          canEditTriage
            ? "grid gap-3 sm:grid-cols-4"
            : "grid gap-3 sm:grid-cols-2 sm:max-w-md"
        }
      >
        <div>
          <label htmlFor="status" className="mb-1 block text-xs font-medium text-zk-text2">
            Status
          </label>
          <select
            id="status"
            name="status"
            value={draft.status}
            disabled
            aria-describedby="status-automatic"
            className={selectClass}
          >
            {statuses.map((value) => (
              <option key={value} value={value}>
                {statusLabel[value]}
              </option>
            ))}
          </select>
          <p id="status-automatic" className="mt-1 text-xs text-zk-muted">
            Moves on its own as agents work.
          </p>
        </div>
        {canEditTriage ? (
          <>
            <div>
              <label htmlFor="typeId" className="mb-1 block text-xs font-medium text-zk-text2">
                Type
              </label>
              <select
                id="typeId"
                name="typeId"
                value={draft.typeId}
                onChange={(event) => set("typeId", event.target.value)}
                className={selectClass}
              >
                <option value="">No type</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="severity"
                className="mb-1 block text-xs font-medium text-zk-text2"
              >
                Severity
              </label>
              <select
                id="severity"
                name="severity"
                value={draft.severity}
                onChange={(event) => set("severity", event.target.value)}
                className={selectClass}
              >
                {severities.map((value) => (
                  <option key={value} value={value}>
                    {severityLabel[value]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="categoryId"
                className="mb-1 block text-xs font-medium text-zk-text2"
              >
                Platform
              </label>
              <select
                id="categoryId"
                name="categoryId"
                value={draft.categoryId}
                onChange={(event) => set("categoryId", event.target.value)}
                className={selectClass}
              >
                <option value="">None</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="areaId" className="mb-1 block text-xs font-medium text-zk-text2">
                Area
              </label>
              <select
                id="areaId"
                name="areaId"
                value={draft.areaId}
                onChange={(event) => set("areaId", event.target.value)}
                className={selectClass}
              >
                <option value="">None</option>
                {areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
              </select>
            </div>
            <div>
              <label
                htmlFor="milestoneId"
                className="mb-1 block text-xs font-medium text-zk-text2"
              >
                Milestone
              </label>
              <select
                id="milestoneId"
                name="milestoneId"
                value={draft.milestoneId}
                onChange={(event) => set("milestoneId", event.target.value)}
                className={selectClass}
              >
                <option value="">None</option>
                {milestones.map((m) => (
                  <option key={m.id} value={m.id} disabled={m.isClosed && m.id !== milestoneId}>
                    {m.title}
                    {m.isClosed ? " (closed)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="assigneeId"
                className="mb-1 block text-xs font-medium text-zk-text2"
              >
                Assignee
              </label>
              <AssigneeCombobox
                id="assigneeId"
                name="assigneeId"
                people={users}
                value={draft.assigneeId}
                onChange={(next) => set("assigneeId", next)}
              />
            </div>
          </>
        ) : assigneeId ? (
          <div>
            <label
              htmlFor="assigneeId"
              className="mb-1 block text-xs font-medium text-zk-text2"
            >
              Assignee
            </label>
            <select
              id="assigneeId"
              name="assigneeId"
              value={draft.assigneeId}
              onChange={(event) => set("assigneeId", event.target.value)}
              className={selectClass}
            >
              <option value={assigneeId}>Assigned to you</option>
              <option value="">Unassign myself</option>
            </select>
          </div>
        ) : null}
      </div>

      {asksForNote ? (
        <div>
          <label htmlFor="resolutionNote" className="mb-1 block text-xs font-medium text-zk-text2">
            Resolution note <span className="font-normal text-zk-muted">(optional)</span>
          </label>
          <Textarea
            id="resolutionNote"
            name="resolutionNote"
            rows={3}
            maxLength={RESOLUTION_NOTE_MAX}
            value={note}
            onChange={(event) => {
              markSaved(false);
              setNote(event.target.value);
            }}
            placeholder="What happened? e.g. Fixed in the 2.4 release. Clear your cache if you still see it."
          />
          <p className="mt-1 text-xs text-zk-muted">
            Shown at the top of the issue and sent to the reporter and watchers.{" "}
            {[...note].length}/{RESOLUTION_NOTE_MAX}
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {/* Announced, so the result of a save isn't visual-only. */}
      <p role="status" aria-live="polite" className="text-sm text-zk-ok-fg empty:hidden">
        {saved ? (
          <>
            Saved.{" "}
            {savedAt ? (
              <span className="text-xs text-emerald-600">
                {savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
              </span>
            ) : null}
          </>
        ) : ""}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        {dirty && !pending ? (
          <span className="text-xs text-amber-700">Unsaved changes</span>
        ) : null}
      </div>
    </form>
  );
}

export { UpdateIssueForm as UpdateBugForm };
