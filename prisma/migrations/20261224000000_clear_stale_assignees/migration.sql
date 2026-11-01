-- Clear stale assignees (#stale-assignee). An Open issue is held only by an
-- active claim or by an offer still inside its project's offer window
-- (lib/issue-holders.ts liveHoldWhere / isLiveHold). An Open issue whose
-- assignee has neither was left assigned by work that was released, expired
-- or reset: the issue page showed that person as Assignee and an award was
-- refused with "This issue is already assigned to someone else." while the
-- work feed listed the issue as awardable. From now on the award and assign
-- routes clear such an assignee themselves; this clears the ones already there.
--
-- The rule, as the app decides it:
--   held  = an IssueClaim on the issue with "releasedAt" IS NULL and either
--           "status" = 'active', or "status" = 'offered' and
--           "offeredAt" > now() - the project's offerWindowSeconds
--   window = ProjectWorkflow."offerWindowSeconds", or 1800 when the project
--           has no row (DEFAULT_PROJECT_WORKFLOW, lib/workflow-config.ts)
-- An offer with no "offeredAt" is not held (isOfferExpired treats it as expired).
--
-- Only "assigneeId" changes: no status, no claims, no bids. Running it again
-- changes nothing, since a cleared issue no longer has an assignee.
UPDATE "Bug" AS b
SET "assigneeId" = NULL
WHERE b."status" = 'open'
  AND b."assigneeId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "IssueClaim" AS c
    LEFT JOIN "ProjectWorkflow" AS w ON w."projectId" = b."projectId"
    WHERE c."bugId" = b."id"
      AND c."releasedAt" IS NULL
      AND (
        c."status" = 'active'
        OR (
          c."status" = 'offered'
          AND c."offeredAt" IS NOT NULL
          -- "offeredAt" is a UTC timestamp without a zone, as Prisma writes it.
          AND c."offeredAt" > (now() AT TIME ZONE 'UTC') - make_interval(secs => COALESCE(w."offerWindowSeconds", 1800))
        )
      )
  );
