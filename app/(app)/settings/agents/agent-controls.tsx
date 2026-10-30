"use client";

import type { AgentLevel } from "@prisma/client";
import { useState, useTransition } from "react";
import { deleteAgentAction, regenerateAgentKeyAction, revokeAgentAction, setAgentBurstAction, setAgentLevelAction } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { AGENT_LEVEL_LABELS } from "@/lib/agents/levels";
import { LocalTime } from "@/components/local-time";
import type { AgentProjectChoice } from "./create-agent-form";
import {
  agentsDangerBtn,
  agentsInputClass,
  agentsPrimaryBtn,
  agentsSecondaryBtn,
} from "./agents-ui";

type BurstExpiryChoice = "keep" | "none" | "2h" | "8h" | "24h" | "custom";

function expiryHours(choice: BurstExpiryChoice): number | null {
  if (choice === "2h") return 2;
  if (choice === "8h") return 8;
  if (choice === "24h") return 24;
  return null;
}

/** Change an agent's level or revoke it, as its owner or a team admin (#427). */
export function AgentControls({
  agentId,
  agentName,
  level,
  levels,
  projects,
  currentProjectId,
  burst = false,
  burstUntil = null,
  now,
  canSetBurst = false,
  revoked = false,
  personal = false,
}: {
  agentId: string;
  agentName: string;
  level: AgentLevel;
  /** The levels this person may set. */
  levels: AgentLevel[];
  projects: AgentProjectChoice[];
  /** The project the live key is limited to, when it has one. */
  currentProjectId?: string | null;
  /** Whether this agent uses the higher hourly write budget. */
  burst?: boolean;
  /** When the higher budget lapses; null means no expiry (#596). */
  burstUntil?: string | Date | null;
  /** Server request time, used to label an expired grant without reading the clock during render. */
  now: string | Date;
  /** Admins may raise the budget. */
  canSetBurst?: boolean;
  /** A revoked agent only offers delete. */
  revoked?: boolean;
  /** The automatic personal agent is created again on the next visit. */
  personal?: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [current, setCurrent] = useState(level);
  const initialUntil = burstUntil ? new Date(burstUntil) : null;
  const initialUntilIso =
    initialUntil && Number.isFinite(initialUntil.getTime()) ? initialUntil.toISOString() : null;
  const [burstOn, setBurstOn] = useState(burst);
  const [savedUntil, setSavedUntil] = useState<string | null>(initialUntilIso);
  const [expiryChoice, setExpiryChoice] = useState<BurstExpiryChoice>(initialUntilIso ? "keep" : "none");
  const [customUntil, setCustomUntil] = useState("");
  // A regenerated key stays on the project the current key is limited to.
  const projectId = currentProjectId || projects[0]?.id || "";
  const [issued, setIssued] = useState<{ rawKey: string; prefix: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function changeLevel(next: AgentLevel) {
    const previous = current;
    setCurrent(next);
    startTransition(async () => {
      const result = await setAgentLevelAction(agentId, next);
      if (result.ok) {
        toast(`${agentName} is now a ${AGENT_LEVEL_LABELS[next].toLowerCase()}.`, "success");
      } else {
        setCurrent(previous);
        toast(result.error, "error");
      }
    });
  }

  async function regenerate() {
    const projectName = projects.find((project) => project.id === projectId)?.name ?? "the chosen project";
    const ok = await confirm({
      title: `Regenerate the key for ${agentName}?`,
      body: `The current key stops working immediately. The new key only works in ${projectName}, and it stays on this agent's row.`,
      confirmLabel: "Regenerate key",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await regenerateAgentKeyAction(agentId, projectId);
      if (result.ok) {
        setIssued({ rawKey: result.rawKey, prefix: result.prefix });
        toast("New key issued. Copy it now.", "success");
      } else {
        toast(result.error, "error");
      }
    });
  }

  async function copyIssued() {
    if (!issued) return;
    toast((await copyText(issued.rawKey)) ? "Key copied." : "Couldn't copy. Select the key and copy it.");
  }

  async function remove() {
    const ok = await confirm({
      title: `Delete ${agentName}?`,
      body: personal
        ? "The agent is removed from this list and its key stops working. A new personal agent is created the next time its owner opens Agents. Issues it filed stay. This can't be undone."
        : "The agent is removed from this list. Its key stops working, and any offer, claim, or bid it held is handed back. Issues it filed stay. This can't be undone.",
      confirmLabel: "Delete agent",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await deleteAgentAction(agentId);
      toast(result.ok ? `${agentName} was deleted.` : result.error, result.ok ? "success" : "error");
    });
  }

  async function revoke() {
    const ok = await confirm({
      title: `Revoke ${agentName}?`,
      body: "Its keys stop working immediately. This can't be undone; register a new agent to replace it.",
      confirmLabel: "Revoke agent",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await revokeAgentAction(agentId);
      toast(result.ok ? `${agentName} was revoked.` : result.error, result.ok ? "success" : "error");
    });
  }

  /**
   * Resolves the selected expiry to an ISO timestamp. `keep` leaves the
   * existing grant alone; `custom` needs a valid future value from the input.
   */
  function resolvedUntil(choice: BurstExpiryChoice): string | null | "invalid" {
    if (choice === "none") return null;
    if (choice === "keep") return savedUntil;
    if (choice === "custom") {
      if (!customUntil) return "invalid";
      const date = new Date(customUntil);
      return Number.isFinite(date.getTime()) && date.getTime() > Date.now() ? date.toISOString() : "invalid";
    }
    const hours = expiryHours(choice);
    if (!hours) return null;
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  }

  function saveBurst(next: boolean, choice: BurstExpiryChoice = expiryChoice) {
    let until: string | null = null;
    if (next) {
      const resolved = resolvedUntil(choice);
      if (resolved === "invalid") {
        toast("Choose an expiry time in the future, or choose no expiry.", "error");
        return;
      }
      until = resolved;
    }

    const previous = { on: burstOn, until: savedUntil };
    setBurstOn(next);
    setSavedUntil(until);
    startTransition(async () => {
      const result = await setAgentBurstAction(agentId, next, until);
      if (result.ok) {
        setSavedUntil(until);
        if (until) {
          setExpiryChoice("keep");
          setCustomUntil("");
        } else {
          setExpiryChoice("none");
          setCustomUntil("");
        }
        toast(
          !next
            ? `${agentName} is back to 600 reads an hour.`
            : until
              ? `${agentName} has the high-volume budget until ${new Date(until).toLocaleString()}.`
              : `${agentName} can now make 4000 reads an hour, with no expiry.`,
          "success",
        );
      } else {
        setBurstOn(previous.on);
        setSavedUntil(previous.until);
        toast(result.error, "error");
      }
    });
  }

  function changeExpiry(next: BurstExpiryChoice) {
    setExpiryChoice(next);
    if (next === "keep" || next === "custom") return;
    if (burstOn) saveBurst(true, next);
  }

  const burstExpiresAt = savedUntil ? Date.parse(savedUntil) : null;
  const burstExpired = burstOn && burstExpiresAt !== null && burstExpiresAt <= new Date(now).getTime();

  if (revoked) {
    return (
      <Button type="button" onClick={remove} disabled={pending} className={agentsDangerBtn}>
        Delete
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`level-${agentId}`} className="sr-only">
          Agent class for {agentName}
        </label>
        <Select
          id={`level-${agentId}`}
          value={current}
          disabled={pending}
          onChange={(event) => changeLevel(event.target.value as AgentLevel)}
          className={`${agentsInputClass} w-auto min-w-[8rem]`}
        >
          {[...new Set([current, ...levels])].map((option) => (
            <option key={option} value={option} disabled={!levels.includes(option)}>
              {AGENT_LEVEL_LABELS[option]}
            </option>
          ))}
        </Select>
        {canSetBurst ? (
          <>
            <label className="flex min-h-10 items-center gap-1.5 rounded-full bg-zk-chip px-3 text-xs font-semibold text-zk-text2">
              <input
                type="checkbox"
                checked={burstOn}
                disabled={pending}
                onChange={(event) => saveBurst(event.target.checked)}
              />
              High-volume
            </label>
            {burstOn ? (
              <>
                <label htmlFor={`burst-expiry-${agentId}`} className="sr-only">
                  High-volume expiry for {agentName}
                </label>
                <Select
                  id={`burst-expiry-${agentId}`}
                  value={expiryChoice}
                  disabled={pending}
                  onChange={(event) => changeExpiry(event.target.value as BurstExpiryChoice)}
                  className={`${agentsInputClass} w-auto`}
                >
                  {savedUntil ? <option value="keep">Keep current expiry</option> : null}
                  <option value="none">No expiry</option>
                  <option value="2h">2 hours</option>
                  <option value="8h">8 hours</option>
                  <option value="24h">24 hours</option>
                  <option value="custom">Custom…</option>
                </Select>
                {expiryChoice === "custom" ? (
                  <>
                    <label htmlFor={`burst-custom-${agentId}`} className="sr-only">
                      Custom high-volume expiry for {agentName}
                    </label>
                    <Input
                      id={`burst-custom-${agentId}`}
                      type="datetime-local"
                      value={customUntil}
                      disabled={pending}
                      onChange={(event) => setCustomUntil(event.target.value)}
                      className={`${agentsInputClass} w-auto text-xs`}
                    />
                    <Button
                      type="button"
                      disabled={pending || !customUntil}
                      onClick={() => saveBurst(true, "custom")}
                      className={agentsSecondaryBtn}
                    >
                      Save expiry
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}
          </>
        ) : burstOn ? (
          <span className="text-xs font-semibold text-zk-muted">High-volume</span>
        ) : null}
        <Button
          type="button"
          onClick={regenerate}
          disabled={pending || !projectId}
          className={agentsSecondaryBtn}
        >
          Regenerate key
        </Button>
        <Button type="button" onClick={revoke} disabled={pending} className={agentsDangerBtn}>
          Revoke
        </Button>
        <Button type="button" onClick={remove} disabled={pending} className={agentsDangerBtn}>
          Delete
        </Button>
      </div>
      {canSetBurst || burstOn ? (
        <p className="text-xs text-zk-muted" suppressHydrationWarning>
          {!burstOn ? (
            "Standard budget: 600 reads an hour."
          ) : burstExpired ? (
            "High-volume expired; standard budget: 600 reads an hour."
          ) : savedUntil ? (
            <>
              High-volume (4000 reads an hour), ends <LocalTime date={savedUntil} />.
            </>
          ) : (
            "High-volume active with no expiry (4000 reads an hour)."
          )}
        </p>
      ) : null}
      {issued ? (
        <div
          className="w-full space-y-2 rounded-[16px] border border-zk-warn-bd bg-zk-warn-bg/40 p-3 sm:max-w-md"
          role="status"
        >
          <p className="text-sm font-semibold text-zk-text">
            New key for {agentName} ({issued.prefix}…). Copy it now. It stays on this agent&apos;s row.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              readOnly
              value={issued.rawKey}
              aria-label={`New key for ${agentName}`}
              className={`${agentsInputClass} font-mono text-xs`}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button type="button" onClick={copyIssued} className={agentsPrimaryBtn}>
              Copy key
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
