import { mergeReviewBodySchema } from "@/lib/agent-api/merge";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOLS } from "../../packages/mcp-server/src/tools";
import { agentEscalationSchema, agentQuestionSchema } from "@/lib/agent-questions";
import { commentSchema, createBugSchema } from "@/lib/validations/issue";
import { createGoalSchema, splitGoalPoolSchema, updateGoalStatusSchema } from "@/lib/validations/goal";
import { createJobSchema, jobReviewSchema, submitJobSchema } from "@/lib/validations/job";
import { redesignSchema } from "@/lib/redesigns";
import { missionCoverageSchema, nextMissionSchema } from "@/lib/missions";
import { bidSchema } from "./bid";
import { claimSchema } from "./claim";
import { extendSchema } from "./deadline";
import { releaseSchema } from "./offer";
import { structureInputSchema } from "./structure";
import { testVerdictBodySchema } from "./test-verdict";
import { confirmationSchema } from "./confirmations";
import { ideaVerdictFields } from "./idea-verdicts";
import { recordMistakeSchema } from "./mistakes";
import { assignSchema } from "./assign";

/**
 * The MCP server (packages/mcp-server) builds its tool inputs from its own zod
 * shapes. These checks fail when a route's body schema gains, renames or
 * requires a field the matching tool doesn't have, so the tools can't drift
 * from the API (#612).
 */
const ROUTE_SCHEMAS: Record<string, z.ZodType> = {
  ziki_assign_issue: assignSchema,
  ziki_create_idea: createBugSchema,
  ziki_comment: commentSchema,
  ziki_volunteer: bidSchema,
  ziki_extend_deadline: extendSchema,
  ziki_confirm_issue: confirmationSchema,
  ziki_give_idea_verdict: ideaVerdictFields,
  ziki_submit_test_result: testVerdictBodySchema,
  ziki_merge_fix: mergeReviewBodySchema,
  ziki_ask_owner: agentQuestionSchema,
  ziki_escalate: agentEscalationSchema,
  ziki_claim_issue: claimSchema,
  ziki_release_claim: releaseSchema,
  ziki_structure_issue: structureInputSchema,
  ziki_create_goal: createGoalSchema,
  ziki_update_goal: updateGoalStatusSchema,
  ziki_split_goal: splitGoalPoolSchema,
  ziki_create_job: createJobSchema,
  ziki_submit_job: submitJobSchema,
  ziki_review_job_submission: jobReviewSchema,
  ziki_propose_redesign: redesignSchema,
  ziki_next_mission: nextMissionSchema,
  ziki_cover_mission: missionCoverageSchema.extend({ projectId: z.string().trim().min(1) }),
  ziki_record_project_mistake: recordMistakeSchema,
};

// The agent routes extend the shared issue and comment schemas with attachmentIds, and
// idea creation with acknowledgeSimilar (lib/agent-api/ideas.ts `createIdeaSchema`).
const AGENT_LAYER_FIELDS = new Set(["attachmentIds", "acknowledgeSimilar"]);

// Fields on the shared schema that the agent route deliberately does not take (it picks only some of
// them, and severity is set by reviewers), so a tool must not offer them.
const NOT_OFFERED_TO_AGENTS: Record<string, readonly string[]> = {
  ziki_create_idea: ["severity", "typeId", "assigneeId"],
  // `action` is the older name for `verdict`, kept for old clients only.
  ziki_merge_fix: ["action"],
};

// Fields the route doesn't take from the body: the tool puts them in the path or query.
const NOT_BODY = new Set(["projectId", "id"]);

/** Zod objects and objects wrapped in superRefine both expose the field map. */
const shapeOf = (schema: z.ZodType) => {
  let current: unknown = schema;
  for (let hop = 0; hop < 4 && current && typeof current === "object" && !("shape" in current); hop += 1) {
    current = (current as { def?: { schema?: unknown }; _def?: { schema?: unknown } }).def?.schema
      ?? (current as { _def?: { schema?: unknown } })._def?.schema;
  }
  return (current as { shape: Record<string, z.ZodType> }).shape;
};
const isRequired = (field: z.ZodType) => !field.safeParse(undefined).success;

describe("MCP tools match the route body schemas", () => {
  for (const [name, schema] of Object.entries(ROUTE_SCHEMAS)) {
    const tool = TOOLS.find((candidate) => candidate.name === name)!;

    it(`${name} only sends fields the route accepts`, () => {
      const routeKeys = [...Object.keys(shapeOf(schema)), ...AGENT_LAYER_FIELDS];
      for (const key of tool.body ?? []) {
        expect(routeKeys, `${name} sends ${key}, which the route rejects`).toContain(key);
      }
    });

    it(`${name} requires everything the route requires`, () => {
      for (const [key, field] of Object.entries(shapeOf(schema))) {
        if (NOT_BODY.has(key) || !isRequired(field)) continue;
        expect(tool.body ?? [], `${name} never sends required ${key}`).toContain(key);
        expect(isRequired(tool.input[key] as z.ZodType), `${name} must require ${key}`).toBe(true);
      }
    });
  }

  for (const [name, schema] of Object.entries(ROUTE_SCHEMAS)) {
    it(`${name} offers every field the route accepts, optional ones too (#969)`, () => {
      const tool = TOOLS.find((candidate) => candidate.name === name)!;
      const left = Object.keys(shapeOf(schema)).filter(
        (key) => !NOT_BODY.has(key) && !(NOT_OFFERED_TO_AGENTS[name] ?? []).includes(key) && !(tool.body ?? []).includes(key),
      );
      expect(left, `${name} cannot send ${left.join(", ")}`).toEqual([]);
    });
  }

  it("covers every tool that posts a JSON body to a route with an exported schema", () => {
    const bodyTools = TOOLS.filter((tool) => tool.body?.length).map((tool) => tool.name);
    // These bodies are declared on the route file, not as an exported schema.
    const unchecked = bodyTools.filter((name) => !(name in ROUTE_SCHEMAS));
    expect(unchecked.sort()).toEqual([
      "ziki_collect_pairing_token",
      "ziki_create_webhook",
      "ziki_link_pull_request",
      "ziki_mark_inbox_read",
      "ziki_pair",
      "ziki_update_webhook",
    ]);
  });
});
