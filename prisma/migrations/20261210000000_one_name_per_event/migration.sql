-- One name for each thing (no aliases): a confirmation entry's event and
-- audit action are `issue.confirmation` (was `issue.validated`), an
-- importance mark's are `issue.importance` (was `issue.voted`). Stored events,
-- audit rows and webhook filters move to the new names, and payloads keep
-- one field per value: `confirmationId` (not also `validationId`), and
-- `important` / `importance` (not also `voted` / `voteCount`).

-- Events agents read from the feed and webhooks.
UPDATE "AgentEvent"
SET "type" = 'issue.confirmation',
    "payload" = ("payload" - 'validationId')
      || jsonb_build_object('confirmationId', COALESCE("payload"->'confirmationId', "payload"->'validationId'))
WHERE "type" = 'issue.validated';

UPDATE "AgentEvent"
SET "payload" = "payload" - 'validationId'
WHERE "type" = 'issue.confirmed' AND "payload" ? 'validationId';

UPDATE "AgentEvent"
SET "type" = 'issue.importance',
    "payload" = ("payload" - 'voted' - 'voteCount')
      || jsonb_build_object(
        'important', COALESCE("payload"->'important', "payload"->'voted'),
        'importance', COALESCE("payload"->'importance', "payload"->'voteCount')
      )
WHERE "type" = 'issue.voted';

-- The audit log (an undo reads `confirmationId`).
UPDATE "AgentAuditEvent"
SET "action" = 'issue.confirmation',
    "payload" = CASE
      WHEN "payload" IS NULL THEN NULL
      ELSE ("payload" - 'validationId')
        || jsonb_build_object('confirmationId', COALESCE("payload"->'confirmationId', "payload"->'validationId'))
    END
WHERE "action" = 'issue.validated';

UPDATE "AgentAuditEvent"
SET "action" = 'issue.importance'
WHERE "action" = 'issue.voted';

-- Webhook subscriptions that filter on the old names.
UPDATE "WebhookSubscription"
SET "events" = array_replace(array_replace("events", 'issue.validated', 'issue.confirmation'), 'issue.voted', 'issue.importance')
WHERE "events" && ARRAY['issue.validated', 'issue.voted']::text[];
