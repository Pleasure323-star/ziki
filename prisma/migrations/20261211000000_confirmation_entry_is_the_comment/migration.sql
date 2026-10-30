-- A Neutral confirmation made from a comment written before confirmations
-- took entries (20261209000000) showed the comment twice: a generic entry,
-- and the comment as its first reply. The entry is the comment now: its
-- summary is the comment's first sentence and its description the whole
-- comment, and that comment row goes. Later comments by the same person, and
-- every reply, stay replies under the entry. Nothing anyone wrote is lost.
--
-- Safe to run again: each step finds the copied comment by its text matching
-- the entry's description, so a rerun never takes another comment.

-- 1. The entry takes its author's first comment under it.
WITH firsts AS (
  SELECT DISTINCT ON (c."confirmationId") c."confirmationId", c."body"
  FROM "Comment" c
  JOIN "IssueConfirmation" ic ON ic."id" = c."confirmationId"
  WHERE ic."id" LIKE 'cnfc%'
    AND ic."summary" = 'Commented before confirmations took entries.'
    AND c."authorId" = ic."onBehalfOfUserId"
    AND c."parentId" IS NULL
    AND c."deletedAt" IS NULL
  ORDER BY c."confirmationId", c."createdAt", c."id"
),
-- The summary comes from the first line that says something: a line that is
-- only a heading or only bold (a title) is skipped.
texts AS (
  SELECT
    f."confirmationId",
    f."body",
    COALESCE(
      (
        SELECT btrim(regexp_replace(l.line, '[*_#>`]', '', 'g'))
        FROM regexp_split_to_table(f."body", E'\n') WITH ORDINALITY AS l(line, n)
        WHERE btrim(l.line) <> ''
          AND btrim(l.line) !~ '^#'
          AND btrim(l.line) !~ '^\*\*[^*]+\*\*$'
        ORDER BY l.n
        LIMIT 1
      ),
      btrim(regexp_replace(substring(btrim(f."body") from '^[^\n]*'), '[*_#>`]', '', 'g'))
    ) AS "line"
  FROM firsts f
)
UPDATE "IssueConfirmation" ic
SET "summary" = COALESCE(
      NULLIF(left(btrim(COALESCE(substring(t."line" from '^(.*?[.!?])(\s|$)'), t."line")), 300), ''),
      'Comment.'
    ),
    "description" = t."body"
FROM texts t
WHERE ic."id" = t."confirmationId";

-- 2. Replies to that comment stay under the entry, without it as their parent.
UPDATE "Comment" child
SET "parentId" = NULL
FROM "Comment" c
JOIN "IssueConfirmation" ic ON ic."id" = c."confirmationId"
WHERE child."parentId" = c."id"
  AND ic."id" LIKE 'cnfc%'
  AND c."authorId" = ic."onBehalfOfUserId"
  AND c."parentId" IS NULL
  AND c."body" = ic."description";

-- 3. Its files stay on the issue.
UPDATE "Attachment" a
SET "commentId" = NULL
FROM "Comment" c
JOIN "IssueConfirmation" ic ON ic."id" = c."confirmationId"
WHERE a."commentId" = c."id"
  AND ic."id" LIKE 'cnfc%'
  AND c."authorId" = ic."onBehalfOfUserId"
  AND c."parentId" IS NULL
  AND c."body" = ic."description";

-- 4. Inbox items that pointed at it point at the issue only.
UPDATE "AgentInboxItem" i
SET "commentId" = NULL
FROM "Comment" c
JOIN "IssueConfirmation" ic ON ic."id" = c."confirmationId"
WHERE i."commentId" = c."id"
  AND ic."id" LIKE 'cnfc%'
  AND c."authorId" = ic."onBehalfOfUserId"
  AND c."parentId" IS NULL
  AND c."body" = ic."description";

-- 5. The comment itself: its text is the entry now.
DELETE FROM "Comment" c
USING "IssueConfirmation" ic
WHERE ic."id" = c."confirmationId"
  AND ic."id" LIKE 'cnfc%'
  AND c."authorId" = ic."onBehalfOfUserId"
  AND c."parentId" IS NULL
  AND c."body" = ic."description";
