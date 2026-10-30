import Link from "next/link";

/**
 * The statuses in the picked stage, down the left of the Issues panel, each
 * with its count. Only the selected one is highlighted. On narrow screens the
 * list runs across the top of the panel instead.
 */
export type SidebarStep = { label: string; count: number; href: string; selected: boolean };

export function StageSidebar({ steps }: { steps: SidebarStep[] }) {
  return (
    <nav aria-label="Status" className="shrink-0 max-lg:w-full max-lg:overflow-x-auto max-lg:border-b max-lg:border-zk-divider max-lg:pb-3 lg:w-40 lg:py-1">
      <ol className="m-0 flex list-none p-0 max-lg:gap-5 lg:flex-col">
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          return (
            <li key={step.label} className="flex shrink-0 gap-3">
              <div className="flex flex-col items-center">
                {/* The count sits in the box; the selected one is filled blue. */}
                <span
                  aria-hidden="true"
                  className={`flex h-7 min-w-7 shrink-0 items-center justify-center rounded-lg px-1 font-mono text-[11px] font-semibold tabular-nums ${
                    step.selected
                      ? "bg-electric-blue-strong text-white ring-4 ring-electric-blue-strong/20"
                      : "border-2 border-zk-border bg-zk-surface text-zk-muted"
                  }`}
                >
                  {step.count}
                </span>
                {last ? null : <span aria-hidden="true" className="my-1 min-h-5 w-0.5 flex-1 rounded-full bg-zk-border max-lg:hidden" />}
              </div>
              <Link
                href={step.href}
                aria-current={step.selected ? "page" : undefined}
                className={`flex min-h-7 min-w-0 flex-1 items-center leading-tight max-lg:whitespace-nowrap rounded-md text-sm hover:text-zk-accent ${last ? "" : "lg:mb-5"} ${
                  step.selected ? "font-bold text-zk-text" : "font-medium text-zk-text2"
                }`}
              >
                {step.label}
                <span className="sr-only">, {step.count}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
