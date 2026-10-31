import { z } from "zod";

/**
 * Archiving an obsolete idea (#idea-archive). A manager agent's disposition,
 * whatever the idea's votes: it is already implemented, a duplicate of another
 * idea or issue, or filed in the wrong project. Each reason needs evidence.
 * The idea's owner may also withdraw their own open idea (#idea-withdraw):
 * reason `withdrawn`, evidence optional, only through
 * `POST /api/v1/ideas/{id}/withdraw` or the idea page, never the archive route.
 * An archived idea leaves the open list and conversion, takes no more
 * verdicts, and shows under Rejected ideas with an "Archived" label and its reason.
 */

/** Every reason an archived idea can carry. */
export const IDEA_ARCHIVE_REASONS = ["already_implemented", "duplicate", "wrong_project", "withdrawn"] as const;
export type IdeaArchiveReason = (typeof IDEA_ARCHIVE_REASONS)[number];

/** The owner's own withdrawal: the one reason the archive route refuses. */
export const IDEA_WITHDRAWN_REASON = "withdrawn" satisfies IdeaArchiveReason;

export const withdrawnNotArchivableMessage =
  "Only the idea's owner withdraws it, with POST /api/v1/ideas/{id}/withdraw. Archive with already_implemented, duplicate or wrong_project.";

const number = z.number().int().positive();

export const archiveIdeaSchema = z
  .object({
    projectId: z.string().trim().min(1).max(191).optional(),
    reason: z.enum(IDEA_ARCHIVE_REASONS),
    /** What shows it: the commit or pull request that implemented it, the duplicate, the right project. */
    evidence: z.string().trim().min(1, "Add the evidence.").max(10_000),
    /** For `duplicate`: the idea it duplicates, by number. */
    duplicateOfIdea: number.optional(),
    /** For `duplicate`: the issue it duplicates, by number. */
    duplicateOfIssue: number.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.reason === IDEA_WITHDRAWN_REASON) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: withdrawnNotArchivableMessage });
    }
    const named = (value.duplicateOfIdea === undefined ? 0 : 1) + (value.duplicateOfIssue === undefined ? 0 : 1);
    if (value.reason === "duplicate" && named !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["duplicateOfIdea"],
        message: "A duplicate names the idea (duplicateOfIdea) or the issue (duplicateOfIssue) it duplicates: one of them.",
      });
    }
    if (value.reason !== "duplicate" && named > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["duplicateOfIdea"],
        message: "Only a duplicate names what it duplicates.",
      });
    }
  });

export type ArchiveIdeaInput = z.infer<typeof archiveIdeaSchema>;

/** The owner's withdrawal (#idea-withdraw): the reason is fixed, the evidence optional. */
export const withdrawIdeaSchema = z
  .object({
    projectId: z.string().trim().min(1).max(191).optional(),
    /** Why it is obsolete, when the owner says. */
    evidence: z.string().trim().max(10_000).optional(),
  })
  .strict();

export type WithdrawIdeaInput = z.infer<typeof withdrawIdeaSchema>;

/** What `Idea.archiveDuplicateOf` holds: `idea:12` or `issue:34`. */
export function duplicateRef(input: Pick<ArchiveIdeaInput, "duplicateOfIdea" | "duplicateOfIssue">): string | null {
  if (input.duplicateOfIdea !== undefined) return `idea:${input.duplicateOfIdea}`;
  if (input.duplicateOfIssue !== undefined) return `issue:${input.duplicateOfIssue}`;
  return null;
}

/** "Already implemented", "Duplicate of idea #12", "Wrong project", "Withdrawn by its owner": how the lists name the reason. */
export function archiveReasonLabel(reason: string | null | undefined, duplicateOf?: string | null): string {
  if (reason === "already_implemented") return "Already implemented";
  if (reason === "wrong_project") return "Wrong project";
  if (reason === "withdrawn") return "Withdrawn by its owner";
  if (reason === "duplicate") {
    const match = /^(idea|issue):(\d+)$/.exec(duplicateOf ?? "");
    return match ? `Duplicate of ${match[1]} #${match[2]}` : "Duplicate";
  }
  return "Archived";
}
