-- Approval rules and their per-issue approvals are gone (#598 removed).
-- No other table has a foreign key to either; IssueApproval points at
-- ApprovalRule, so it goes first.

-- The approval gate notified tenant admins with kind 'approval_needed' and a
-- link built as '/redesigns/<approval id>', which never resolved. Redesign
-- notifications share the kind, so only rows whose link names an approval go.
DELETE FROM "Notification" AS n
USING "IssueApproval" AS a
WHERE n."kind" = 'approval_needed'
  AND n."url" = '/redesigns/' || a."id";

DROP TABLE IF EXISTS "IssueApproval";
DROP TABLE IF EXISTS "ApprovalRule";
