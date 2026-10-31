-- Organizations are joined only by an email invite or a share link (#org-admin).
-- Workspace discovery and join requests are removed outright: the table, its
-- status type, the Tenant.discoverable flag, and the notifications they sent.
DELETE FROM "Notification" WHERE "kind" IN ('tenant_join_request', 'tenant_join_request_result');

DROP TABLE IF EXISTS "TenantJoinRequest";
DROP TYPE IF EXISTS "TenantJoinRequestStatus";

ALTER TABLE "Tenant" DROP COLUMN IF EXISTS "discoverable";
