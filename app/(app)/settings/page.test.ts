import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const mockCurrentTenantIdFor = vi.hoisted(() => vi.fn());
const mockIsTenantAdmin = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor: mockCurrentTenantIdFor }));
vi.mock("@/lib/agents/membership", () => ({ isTenantAdmin: mockIsTenantAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    project: {
      findMany: vi.fn(),
    },
  },
}));
vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@/components/account-data-settings", () => ({
  AccountDataSettings: () => null,
}));

import { prisma } from "@/lib/prisma";
import SettingsPage from "./page";
import { DisplayNameForm } from "@/components/display-name-form";

function collectHrefs(node: unknown, hrefs: string[] = []): string[] {
  if (!node || typeof node !== "object") return hrefs;
  const anyNode = node as { props?: { href?: string; children?: unknown } };
  if (anyNode.props?.href) hrefs.push(anyNode.props.href);
  if (Array.isArray(anyNode.props?.children)) {
    for (const child of anyNode.props.children) collectHrefs(child, hrefs);
  } else if (anyNode.props?.children) {
    collectHrefs(anyNode.props.children, hrefs);
  }
  return hrefs;
}

function visitNodes(
  node: unknown,
  nodes: Array<{ type?: unknown; props?: { href?: string; children?: unknown } }> = [],
) {
  if (Array.isArray(node)) {
    node.forEach((child) => visitNodes(child, nodes));
    return nodes;
  }
  if (!node || typeof node !== "object") return nodes;
  const element = node as (typeof nodes)[number];
  nodes.push(element);
  visitNodes(element.props?.children, nodes);
  return nodes;
}

describe("SettingsPage resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1", name: "Ada Lovelace", email: "ada@example.com", role: "user" });
  });

  it("renders cleanly with full user settings", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      name: "Ada Lovelace",
      email: "ada@example.com",
      theme: "dark",
      emailNotifications: true,
      notifyMentions: true,
      notifyAssignments: true,
      notifyStatusChanges: true,
      keyboardShortcuts: true,
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

    const element = await SettingsPage({});
    expect(element).toBeDefined();
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("falls back gracefully when full settings query throws due to missing columns", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockRejectedValueOnce(new Error("The column User.theme does not exist in the current database."))
      .mockResolvedValueOnce({
        name: "Ada Lovelace",
        email: "ada@example.com",
      } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

    const element = await SettingsPage({});
    expect(element).toBeDefined();
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it("renders agent audit log and manage agents links when agent platform is enabled (#628)", async () => {
    process.env.AGENT_PLATFORM = "true";
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      name: "Ada Lovelace",
      email: "ada@example.com",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

    const element = await SettingsPage({
      searchParams: Promise.resolve({ section: "agents" }),
    });
    expect(element).toBeDefined();

    const hrefs = collectHrefs(element);
    expect(hrefs).toContain("/settings/audit");
    expect(hrefs).toContain("/agents");
    expect(hrefs).toContain("/settings/agents/pair");
    expect(hrefs).toContain("/settings/webhooks");
    delete process.env.AGENT_PLATFORM;
  });

  it("renders agent links by default without explicit env vars", async () => {
    delete process.env.AGENT_PLATFORM;
    delete process.env.NEXT_PUBLIC_AGENT_PLATFORM;

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      name: "Ada Lovelace",
      email: "ada@example.com",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

    const element = await SettingsPage({
      searchParams: Promise.resolve({ section: "agents" }),
    });
    expect(element).toBeDefined();

    const hrefs = collectHrefs(element);
    expect(hrefs).toContain("/agents");
    expect(hrefs).toContain("/settings/agents/pair");
    expect(hrefs).toContain("/settings/audit");
  });

  it("hides agent links when agent platform is explicitly disabled via AGENT_PLATFORM=false", async () => {
    process.env.AGENT_PLATFORM = "false";
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      name: "Ada Lovelace",
      email: "ada@example.com",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

    const element = await SettingsPage({
      searchParams: Promise.resolve({ section: "agents" }),
    });
    expect(element).toBeDefined();

    const hrefs = collectHrefs(element);
    expect(hrefs).not.toContain("/agents");
    expect(hrefs).not.toContain("/settings/agents/pair");
    expect(hrefs).not.toContain("/settings/audit");
    expect(hrefs).toContain("/workers");
    delete process.env.AGENT_PLATFORM;
  });
});


it("renders the display-name form on Account and keeps the profile route (#576)", async () => {
  requireUser.mockResolvedValue({ id: "user-1", name: "Ada", email: "ada@example.com", role: "user" });
  vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ name: "Ada", email: "ada@example.com" } as never);
  const page = await SettingsPage({
    searchParams: Promise.resolve({ section: "account" }),
  });
  const nodes = visitNodes(page);
  expect(nodes.some((node) => node.props?.href === "/settings/profile")).toBe(true);
  expect(nodes.some((node) => node.type === DisplayNameForm)).toBe(true);
  expect(nodes.some((node) => node.props?.href === "/settings/security")).toBe(true);
});

describe("SettingsPage and the organization's projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1", name: "Ada", email: "ada@example.com", role: "admin" });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ name: "Ada", email: "ada@example.com" } as never);
  });

  it("no longer has a Projects section: ?section=projects opens Account", async () => {
    const page = await SettingsPage({
      searchParams: Promise.resolve({ section: "projects" }),
    });
    const nodes = visitNodes(page);
    expect(nodes.some((node) => node.type === DisplayNameForm)).toBe(true);
    expect(prisma.project.findMany).not.toHaveBeenCalled();
    const hrefs = collectHrefs(page);
    expect(hrefs).not.toContain("/settings?section=projects");
    expect(hrefs).not.toContain("/projects");
  });

  it("points project settings and members at the organization admin in /org", async () => {
    const page = await SettingsPage({
      searchParams: Promise.resolve({ section: "agents" }),
    });
    const hrefs = collectHrefs(page);
    expect(hrefs).toContain("/org/projects");
    expect(hrefs).toContain("/org/members");
    expect(hrefs).not.toContain("/settings?section=projects");
  });
});
