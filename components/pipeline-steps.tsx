import Link from "next/link";

/**
 * The three stages of the work across the top of the Issues page: Ideas,
 * Working, Delivered, each with its count. The picked stage is filled in;
 * its statuses are listed down the left of the panel.
 */
export type PipelineStage = { label: string; count: number; href: string; selected: boolean };

export function PipelineSteps({ stages }: { stages: PipelineStage[] }) {
  return (
    <nav aria-label="Stages" className="grid w-full max-w-[400px] grid-cols-3 gap-x-1.5">
      {stages.map((stage) => (
        <Link
          key={stage.label}
          href={stage.href}
          aria-current={stage.selected ? "page" : undefined}
          className="group flex flex-col items-center gap-1.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zk-accent"
        >
          <span className={`flex items-center gap-1 text-xs ${stage.selected ? "font-bold text-zk-text" : "font-medium text-zk-text2 group-hover:text-zk-text"}`}>
            {stage.label}
            <span className="font-mono text-[11px] font-medium tabular-nums text-zk-muted">{stage.count}</span>
          </span>
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${stage.selected ? "bg-electric-blue-strong" : "bg-electric-blue-strong/15"}`} />
          <span
            aria-hidden="true"
            className={`h-2 w-full rounded-full ${stage.selected ? "bg-electric-blue-strong" : "bg-electric-blue-strong/15 group-hover:bg-electric-blue-strong/30"}`}
          />
        </Link>
      ))}
    </nav>
  );
}
