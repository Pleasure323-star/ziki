-- Canonical pull request links (#repair-pr-link). The repository was renamed
-- from Zedu-Endor/issue-tracker, zeduchat/bug-tracker and emerjent/bug-tracker
-- to emerjent/ziki. GitHub redirects a renamed repository, so pull request N
-- under an old name is pull request N under the new one. Links under the old
-- names are rewritten to https://github.com/emerjent/ziki/pull/N, keeping
-- anything after the number, on every table that holds one: the issue, its
-- delivery, its judgements, its merge reviews and its review offers. The same
-- rewrite on every table keeps a judgement on the issue's linked pull request
-- on it, so it keeps counting.
--
-- Only issues of a project whose repository is emerjent/ziki
-- (Project.repoUrl, any case, http(s) or git@, with or without .git and
-- trailing slashes). The former names are FORMER_REPOSITORY_NAMES in
-- lib/github/former-repos.ts; the app compares repositories case-insensitively,
-- and so does this. Safe to run again: a rewritten link no longer matches.

UPDATE "Bug" AS b
SET "pullRequestUrl" = regexp_replace(
  b."pullRequestUrl",
  '^https?://(www\.)?github\.com/(zedu-endor/issue-tracker|zeduchat/bug-tracker|emerjent/bug-tracker)/pull/',
  'https://github.com/emerjent/ziki/pull/',
  'i'
)
FROM "Project" AS p
WHERE p."id" = b."projectId"
  AND p."repoUrl" ~* '^\s*(https?://(www\.)?github\.com/|git@github\.com:)emerjent/ziki(\.git)?/*\s*$'
  AND b."pullRequestUrl" ~* '^https?://(www\.)?github\.com/(zedu-endor/issue-tracker|zeduchat/bug-tracker|emerjent/bug-tracker)/pull/[0-9]+';

UPDATE "Delivery" AS d
SET "pullRequestUrl" = regexp_replace(
  d."pullRequestUrl",
  '^https?://(www\.)?github\.com/(zedu-endor/issue-tracker|zeduchat/bug-tracker|emerjent/bug-tracker)/pull/',
  'https://github.com/emerjent/ziki/pull/',
  'i'
)
FROM "Bug" AS b
JOIN "Project" AS p ON p."id" = b."projectId"
WHERE b."id" = d."bugId"
  AND p."repoUrl" ~* '^\s*(https?://(www\.)?github\.com/|git@github\.com:)emerjent/ziki(\.git)?/*\s*$'
  AND d."pullRequestUrl" ~* '^https?://(www\.)?github\.com/(zedu-endor/issue-tracker|zeduchat/bug-tracker|emerjent/bug-tracker)/pull/[0-9]+';

UPDATE "TestVerdict" AS v
SET "pullRequestUrl" = regexp_replace(
  v."pullRequestUrl",
  '^https?://(www\.)?github\.com/(zedu-endor/issue-tracker|zeduchat/bug-tracker|emerjent/bug-tracker)/pull/',
  'https://github.com/emerjent/ziki/pull/',
  'i'
)
FROM "Bug" AS b
JOIN "Project" AS p ON p."id" = b."projectId"
WHERE b."id" = v."bugId"
  AND p."repoUrl" ~* '^\s*(https?://(www\.)?github\.com/|git@github\.com:)emerjent/ziki(\.git)?/*\s*$'
  AND v."pullRequestUrl" ~* '^https?://(www\.)?github\.com/(zedu-endor/issue-tracker|zeduchat/bug-tracker|emerjent/bug-tracker)/pull/[0-9]+';

UPDATE "MergeReview" AS r
SET "pullRequestUrl" = regexp_replace(
  r."pullRequestUrl",
  '^https?://(www\.)?github\.com/(zedu-endor/issue-tracker|zeduchat/bug-tracker|emerjent/bug-tracker)/pull/',
  'https://github.com/emerjent/ziki/pull/',
  'i'
)
FROM "Bug" AS b
JOIN "Project" AS p ON p."id" = b."projectId"
WHERE b."id" = r."bugId"
  AND p."repoUrl" ~* '^\s*(https?://(www\.)?github\.com/|git@github\.com:)emerjent/ziki(\.git)?/*\s*$'
  AND r."pullRequestUrl" ~* '^https?://(www\.)?github\.com/(zedu-endor/issue-tracker|zeduchat/bug-tracker|emerjent/bug-tracker)/pull/[0-9]+';

UPDATE "ReviewOffer" AS o
SET "pullRequestUrl" = regexp_replace(
  o."pullRequestUrl",
  '^https?://(www\.)?github\.com/(zedu-endor/issue-tracker|zeduchat/bug-tracker|emerjent/bug-tracker)/pull/',
  'https://github.com/emerjent/ziki/pull/',
  'i'
)
FROM "Bug" AS b
JOIN "Project" AS p ON p."id" = b."projectId"
WHERE b."id" = o."bugId"
  AND p."repoUrl" ~* '^\s*(https?://(www\.)?github\.com/|git@github\.com:)emerjent/ziki(\.git)?/*\s*$'
  AND o."pullRequestUrl" ~* '^https?://(www\.)?github\.com/(zedu-endor/issue-tracker|zeduchat/bug-tracker|emerjent/bug-tracker)/pull/[0-9]+';
