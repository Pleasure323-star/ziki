-- New projects take up to 10 active claims per person (was 2), and so does
-- the Ziki project, so ten
-- awarded bids can be offered and accepted. Only raises it: a value already
-- at 10 or more is kept. A project with no workflow row gets one, the other
-- settings at their defaults. Safe to run again.
INSERT INTO "ProjectWorkflow" ("projectId", "maxActiveClaims", "updatedAt")
SELECT p."id", 10, NOW() FROM "Project" p WHERE p."slug" = 'ziki'
ON CONFLICT ("projectId") DO UPDATE
  SET "maxActiveClaims" = 10, "updatedAt" = NOW()
  WHERE "ProjectWorkflow"."maxActiveClaims" < 10;
ALTER TABLE "ProjectWorkflow" ALTER COLUMN "maxActiveClaims" SET DEFAULT 10;
