import { mergeReviewBodySchema } from "@/lib/agent-api/merge";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { agentQuestionSchema } from "@/lib/agent-questions";
import { redesignSchema } from "@/lib/redesigns";
import { commentSchema, statusSchema } from "@/lib/validations/issue";
import { bidSchema } from "@/lib/agent-api/bid";
import { extendSchema } from "@/lib/agent-api/deadline";
import { createIdeaSchema } from "@/lib/agent-api/ideas";
import { testVerdictBodySchema } from "@/lib/agent-api/test-verdict";
import { confirmationSchema } from "@/lib/agent-api/confirmations";
import { pullRequestReportSchema } from "@/lib/validations/pull-request-report";
import { closeIssueSchema, closeSuggestionSchema, reopenIssueSchema, withdrawIssueSchema } from "@/lib/agent-api/close-suggestions";

/**
 * The request bodies in llms.txt must be ones the routes accept (#555).
 * Each documented example is parsed with the same zod schema the route uses.
 */
const doc = readFileSync("docs/ziki-for-agents.md", "utf8").replace(/\r\n/g, "\n");

/** The text of one `### METHOD /path` section of the reference. */
function section(heading: string): string {
  const start = doc.indexOf(`\n### ${heading}\n`);
  expect(start, `missing section "${heading}"`).toBeGreaterThan(-1);
  const rest = doc.slice(start + 1);
  const next = rest.slice(4).search(/\n(### |## )/);
  return next === -1 ? rest : rest.slice(0, next + 4);
}

/** The JSON block that follows **Request Body:** (or **Request:**) in a section, without `// comments`. */
function requestBody(heading: string): unknown {
  const text = section(heading);
  const marker = Math.max(text.indexOf("**Request Body:**"), text.indexOf("**Request:**"));
  expect(marker, `"${heading}" has no Request Body`).toBeGreaterThan(-1);
  const block = /```json\n([\s\S]*?)```/.exec(text.slice(marker));
  expect(block, `"${heading}" has no JSON example`).not.toBeNull();
  return JSON.parse(block![1].replace(/\s\/\/[^\n]*/g, ""));
}

const EXAMPLES: Array<[string, z.ZodType]> = [
  ["POST /api/v1/ideas", createIdeaSchema],
  ["POST /api/v1/issues/{id}/comments", commentSchema],
  ["POST /api/v1/issues/{id}/bid", bidSchema],
  ["POST /api/v1/issues/{id}/extend", extendSchema],
  ["POST /api/v1/issues/{id}/confirmations", confirmationSchema],
  ["POST /api/v1/issues/{id}/test-results", testVerdictBodySchema],
  ["POST /api/v1/issues/{id}/merge", mergeReviewBodySchema],
  ["POST /api/v1/issues/{id}/pull-request-status", pullRequestReportSchema],
  ["POST /api/v1/issues/{id}/close-suggestions", closeSuggestionSchema],
  ["POST /api/v1/issues/{id}/close", closeIssueSchema],
  ["POST /api/v1/issues/{id}/reopen", reopenIssueSchema],
  ["POST /api/v1/issues/{id}/withdraw", withdrawIssueSchema],
  ["POST /api/v1/questions", agentQuestionSchema],
  ["POST /api/v1/redesigns", redesignSchema],
];

describe("llms.txt request examples are accepted by the routes (#555)", () => {
  it.each(EXAMPLES)("%s", (heading, schema) => {
    const result = schema.safeParse(requestBody(heading));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("sends the idempotency key as a header on create, never in the body", () => {
    expect(requestBody("POST /api/v1/ideas")).not.toHaveProperty("idempotencyKey");
    expect(createIdeaSchema.safeParse({ title: "A title", description: "A long enough description", idempotencyKey: "k" }).success).toBe(false);
  });

  it("documents a confirmation the route accepts, and the route refuses a severity or a bare verdict", () => {
    // Confirmations take no severity, and the route refuses one.
    expect(confirmationSchema.safeParse({ verdict: "confirm", summary: "Reproduced it.", description: "Followed the steps.", severity: "high" }).success).toBe(false);
    expect(requestBody("POST /api/v1/issues/{id}/confirmations")).toMatchObject({ verdict: "confirm" });
    // A bare verdict is refused, as the route refuses it.
    expect(confirmationSchema.safeParse({ verdict: "confirm" }).success).toBe(false);
  });

  it("documents a merge review the route accepts, and the routes refuse bare verdicts (#review-entries)", () => {
    expect(mergeReviewBodySchema.safeParse(requestBody("POST /api/v1/issues/{id}/merge")).success).toBe(true);
    // A bare review is refused, as the route refuses it.
    expect(mergeReviewBodySchema.safeParse({ verdict: "reject" }).success).toBe(false);
    expect(testVerdictBodySchema.safeParse({ goodToMerge: true }).success).toBe(false);
  });

  it("lists only status values the routes accept", () => {
    const filter = /- `status` \(optional\): ([^\n]+)/.exec(section("GET /api/v1/issues"));
    expect(filter).not.toBeNull();
    const documented = [...filter![1].matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
    expect(documented.length).toBeGreaterThan(0);
    for (const value of documented) expect(statusSchema.safeParse(value).success, value).toBe(true);
  });
});
