-- Issues live at /<project-slug>/<number> (#project-urls), so a project slug
-- may no longer be the name of a top-level route. Any project that already
-- uses one is renamed to <slug>-project (then <slug>-project-2, -3, ... if
-- that is taken in the same tenant), the rule lib/project-slug.ts applies to
-- new projects. The list matches RESERVED_PROJECT_SLUGS there.
--
-- Idempotent: once renamed, no project holds a reserved slug, so a second run
-- changes nothing. A renamed project's /<old-slug>/work URL stops answering;
-- its agents read the new work_url from GET /api/v1/agents/me.
DO $$
DECLARE
  project RECORD;
  candidate TEXT;
  attempt INT;
BEGIN
  FOR project IN
    SELECT "id", "tenantId", "slug"
    FROM "Project"
    WHERE "slug" IN (
      'actions', 'api', 'fonts', 'session-expired',
      'activity', 'admin', 'agents', 'dashboard', 'docs', 'escalations', 'feed',
      'ideas', 'issues', 'jobs', 'leaderboard', 'marketing', 'milestones', 'notes',
      'notifications', 'org', 'points', 'projects', 'questions', 'redesigns',
      'security', 'settings', 'team', 'tenants', 'users', 'workers',
      'forgot-password', 'join', 'login', 'reset-password', 'signup',
      'apple-icon', 'favicon', 'icon', 'icon1', 'icon2', 'llms', 'manifest',
      'opengraph-image', 'robots', 'sitemap', 'twitter-image',
      'bug-tracker', 'bugs',
      'brand', 'homepage', 'icons'
    )
    ORDER BY "createdAt", "id"
  LOOP
    candidate := project."slug" || '-project';
    attempt := 2;
    WHILE EXISTS (
      SELECT 1 FROM "Project" WHERE "tenantId" = project."tenantId" AND "slug" = candidate
    ) LOOP
      candidate := project."slug" || '-project-' || attempt;
      attempt := attempt + 1;
    END LOOP;
    UPDATE "Project" SET "slug" = candidate, "updatedAt" = NOW() WHERE "id" = project."id";
  END LOOP;
END $$;
