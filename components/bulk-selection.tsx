"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { bulkUpdateBugsAction } from "@/app/actions/issues-bulk";
import { MAX_BULK_IDS } from "@/lib/bulk-actions";
import { severities } from "@/lib/validations/issue";
import { severityLabel } from "@/lib/labels";

type Selection = {
  selected: ReadonlySet<string>;
  toggle: (id: string) => void;
  isSelected: (id: string) => boolean;
};

const SelectionContext = createContext<Selection | null>(null);

function useSelection(): Selection | null {
  return useContext(SelectionContext);
}

type Option = { id: string; name: string };

export function BulkSelectionProvider({
  pageIds,
  types,
  platforms,
  users,
  children,
}: {
  /** Ids on the page being shown, for "select all". */
  pageIds: string[];
  types: Option[];
  platforms: Option[];
  users: Option[];
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const value = useMemo<Selection>(
    () => ({ selected, toggle, isSelected: (id) => selected.has(id) }),
    [selected, toggle],
  );

  return (
    <SelectionContext.Provider value={value}>
      {children}
      <BulkBar
        selected={selected}
        setSelected={setSelected}
        pageIds={pageIds}
        types={types}
        platforms={platforms}
        users={users}
      />
    </SelectionContext.Provider>
  );
}

/** The checkbox on one row. Renders nothing outside a provider. */
export function BulkCheckbox({ id, title }: { id: string; title: string }) {
  const selection = useSelection();
  if (!selection) return null;
  return (
    <input
      type="checkbox"
      checked={selection.isSelected(id)}
      onChange={() => selection.toggle(id)}
      aria-label={`Select ${title}`}
      className="mt-1 h-4 w-4 shrink-0 self-start rounded border-slate-300 text-teal-600 focus:ring-teal-500"
    />
  );
}

const selectClass =
  "rounded-lg border border-slate-300 bg-card px-2.5 py-1.5 text-sm text-slate-900 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500";

function BulkBar({
  selected,
  setSelected,
  pageIds,
  types,
  platforms,
  users,
}: {
  selected: ReadonlySet<string>;
  setSelected: (next: ReadonlySet<string>) => void;
  pageIds: string[];
  types: Option[];
  platforms: Option[];
  users: Option[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [failures, setFailures] = useState<{ id: string; reason: string }[]>([]);

  const count = selected.size;
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const overLimit = count > MAX_BULK_IDS;

  function apply(field: string, value: string) {
    if (!value || count === 0) return;
    setMessage(null);
    setFailures([]);
    startTransition(async () => {
      const result = await bulkUpdateBugsAction([...selected], { [field]: value });
      if (result.error) {
        setMessage(result.error);
        setFailures(result.skipped ?? []);
        return;
      }
      setSelected(new Set());
      setFailures(result.skipped ?? []);
      setMessage(
        `Updated ${result.updated} issue${result.updated === 1 ? "" : "s"}.`,
      );
      // The rows on screen are server-rendered, so they only show the new
      // values once the page is refetched.
      router.refresh();
    });
  }

  // After a successful apply the selection clears, but the result still has
  // something to say — a count, and any issues that could not be changed.
  // Hiding the whole bar at count === 0 swallowed both.
  if (count === 0) {
    if (!message && failures.length === 0) {
      return <p className="sr-only" role="status" aria-live="polite" />;
    }
    return (
      <div
        role="region"
        aria-label="Bulk actions result"
        className="sticky bottom-3 z-30 mt-3 rounded-xl border border-slate-300 bg-card p-3 shadow-lg"
      >
        <p className="text-sm text-slate-700 empty:hidden" role="status" aria-live="polite">
          {message}
        </p>
        <Failures items={failures} />
        <button
          type="button"
          onClick={() => {
            setMessage(null);
            setFailures([]);
          }}
          className="mt-1 rounded-md text-xs font-medium text-slate-600 underline hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="sticky bottom-3 z-30 mt-3 rounded-xl border border-slate-300 bg-card p-3 shadow-lg"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm font-semibold text-slate-900">
          {count} selected
        </strong>

        <button
          type="button"
          onClick={() =>
            setSelected(
              allOnPage
                ? new Set([...selected].filter((id) => !pageIds.includes(id)))
                : new Set([...selected, ...pageIds]),
            )
          }
          className="rounded-md px-2 py-1 text-sm font-medium text-teal-700 underline hover:text-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
        >
          {allOnPage ? "Clear this page" : "Select all on this page"}
        </button>
        <button
          type="button"
          onClick={() => {
            setSelected(new Set());
            setMessage(null);
            setFailures([]);
          }}
          className="rounded-md px-2 py-1 text-sm font-medium text-slate-600 underline hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        >
          Clear selection
        </button>

        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Field label="Severity" disabled={pending || overLimit} onPick={(v) => apply("severity", v)}>
            {severities.map((s) => (
              <option key={s} value={s}>{severityLabel[s]}</option>
            ))}
          </Field>
          <Field label="Type" disabled={pending || overLimit} onPick={(v) => apply("typeId", v)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </Field>
          <Field label="Platform" disabled={pending || overLimit} onPick={(v) => apply("categoryId", v)}>
            {platforms.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Field>
          <Field label="Assignee" disabled={pending || overLimit} onPick={(v) => apply("assigneeId", v)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Field>
        </span>
      </div>

      {/*
        Selection is per page and is not carried across paging or filtering,
        which is easy to assume otherwise — so it is stated rather than left
        to be discovered.
      */}
      <p className="mt-2 text-xs text-slate-600">
        {overLimit
          ? `Select at most ${MAX_BULK_IDS} issues at a time.`
          : `Applies to the ${count} selected ${count === 1 ? "issue" : "issues"}. Changing page or filters clears the selection.`}
      </p>

      <p
        className="mt-1 text-sm text-slate-700 empty:hidden"
        role="status"
        aria-live="polite"
      >
        {message}
      </p>

      <Failures items={failures} />
    </div>
  );
}

function Failures({ items }: { items: { id: string; reason: string }[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-amber-800">
      {items.map((failure) => (
        <li key={failure.id}>
          <span className="font-mono">{failure.id}</span>: {failure.reason}
        </li>
      ))}
    </ul>
  );
}

function Field({
  label,
  children,
  onPick,
  disabled,
}: {
  label: string;
  children: React.ReactNode;
  onPick: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
      <span className="sr-only sm:not-sr-only">{label}</span>
      <select
        aria-label={`Set ${label.toLowerCase()} for the selected issues`}
        className={selectClass}
        disabled={disabled}
        value=""
        onChange={(event) => {
          const value = event.target.value;
          event.target.value = "";
          onPick(value);
        }}
      >
        <option value="">{label}…</option>
        {children}
      </select>
    </label>
  );
}
