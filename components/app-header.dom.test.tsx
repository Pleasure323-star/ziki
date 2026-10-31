// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { switchActiveRoleAction } from "@/app/actions/auth";
import { selectTenantAction } from "@/app/(app)/tenants/actions";
import { labelInNameMismatches } from "@/lib/a11y/label-in-name";
import { AppHeader } from "./app-header";
import { recentNotificationsAction } from "@/app/actions/notifications";
import { BASE_PATH } from "@/lib/base-path";

vi.mock("@/app/actions/notifications", () => ({ recentNotificationsAction: vi.fn() }));

vi.mock("next/image", () => ({
  default: (props: { alt?: string }) => <span data-testid="img" aria-hidden={props.alt === ""} />,
}));

const navigation = vi.hoisted(() => ({ pathname: "/issues" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

vi.mock("@/app/(app)/tenants/actions", () => ({
  selectTenantAction: vi.fn(),
}));

vi.mock("@/app/actions/auth", () => ({
  switchActiveRoleAction: vi.fn(),
  logoutAction: vi.fn(),
}));

vi.mock("@/app/actions/settings", () => ({
  setThemeAction: vi.fn(),
}));

const switchRole = vi.mocked(switchActiveRoleAction);
const selectTenant = vi.mocked(selectTenantAction);

afterEach(() => cleanup());

beforeEach(() => {
  vi.mocked(recentNotificationsAction).mockReset().mockResolvedValue([]);
  navigation.pathname = "/issues";
  switchRole.mockReset();
  switchRole.mockResolvedValue({ error: "refused" });
});

describe("notification preview (#615)", () => {
  it("toggles without navigation and names the unread count", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader({ unreadCount: 3 });
    const bell = screen.getByRole("button", { name: /inbox.*3/i });
    const location = window.location.href;
    expect(recentNotificationsAction).not.toHaveBeenCalled();
    await user.click(bell);
    expect(bell.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText(/no notifications/i)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Recent notifications" }));
    expect(window.location.href).toBe(location);
    expect(screen.getByRole("link", { name: "Open inbox" }).getAttribute("href")).toBe("/inbox");
    await user.click(bell);
    expect(bell.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders summaries, timestamps, unread state and the existing read-on-open links", async () => {
    vi.mocked(recentNotificationsAction).mockResolvedValue([
      { id: "n1", title: "Issue assigned to you", createdAt: new Date("2026-10-22T12:00:00Z"), readAt: null },
      { id: "n2", title: "New comment", createdAt: new Date("2026-10-21T12:00:00Z"), readAt: new Date() },
    ]);
    renderHeader();
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Inbox" }));
    const link = await screen.findByRole("link", { name: /Unread: Issue assigned to you/ });
    expect(link.getAttribute("href")).toBe(`${BASE_PATH}/inbox/notifications/n1`);
    expect(link.querySelector("time")?.dateTime).toBe("2026-10-22T12:00:00.000Z");
    expect(screen.getByRole("link", { name: /New comment/ }).textContent).not.toContain("Unread:");
    expect(recentNotificationsAction).toHaveBeenCalledTimes(1);
  });

  it("supports keyboard opening, Escape focus restoration and outside dismissal", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader();
    const bell = screen.getByRole("button", { name: "Inbox" });
    bell.focus();
    await user.keyboard("{Enter}");
    await screen.findByText(/no notifications/i);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(bell);
    expect(screen.queryByRole("region", { name: "Recent notifications" })).toBeNull();
    await user.click(bell);
    fireEvent.pointerDown(document.body);
    expect(bell.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows loading and allows retry after failure", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(recentNotificationsAction).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const user = userEvent.setup({ delay: null });
    renderHeader();
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    expect(screen.getByRole("status")).toBeTruthy();
    reject(new Error("offline"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/no notifications/i)).toBeTruthy();
  });

  it("lets Tab leave the preview and clears it when the workspace changes", async () => {
    const user = userEvent.setup({ delay: null });
    // The bell is the last control in the bar, so Tab leaves the preview for
    // the page content after the header, as on a real page.
    const view = render(
      <>
        <AppHeader userName="Ada Lovelace" workspaces={[{ id: "t1", name: "Ziki", slug: "ziki" }]} activeTenantId="t1" />
        <a href="#main">Page content</a>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await screen.findByText(/no notifications/i);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Open inbox" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Page content" }));
    expect(screen.queryByRole("region", { name: "Recent notifications" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    view.rerender(
      <>
        <AppHeader activeTenantId="t2" />
        <a href="#main">Page content</a>
      </>,
    );
    expect(screen.queryByRole("region", { name: "Recent notifications" })).toBeNull();
  });

  it("ignores an obsolete request after closing and reopening", async () => {
    let resolve!: (items: Awaited<ReturnType<typeof recentNotificationsAction>>) => void;
    vi.mocked(recentNotificationsAction).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const user = userEvent.setup({ delay: null });
    renderHeader();
    const bell = screen.getByRole("button", { name: "Inbox" });
    await user.click(bell);
    await user.click(bell);
    await user.click(bell);
    await screen.findByText(/no notifications/i);
    await act(async () => {
      resolve([{ id: "old", title: "Stale alert", createdAt: new Date(), readAt: null }]);
    });
    expect(screen.queryByText("Stale alert")).toBeNull();
  });
});

function renderHeader(props?: Partial<Parameters<typeof AppHeader>[0]>) {
  const shared = {
    userName: "Ada Lovelace",
    role: "super_admin" as const,
    isRealSuperAdmin: true,
    isRealAdmin: true,
    workspaces: [{ id: "t1", name: "Ziki", slug: "ziki" }],
    activeTenantId: "t1",
    ...props,
  };
  return render(<AppHeader {...shared} />);
}

describe("account menu role switch", () => {
  it("leaves View as out of the account menu", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader();

    await user.click(screen.getByRole("button", { name: /account menu/i }));

    expect(screen.queryByRole("group", { name: /view as/i })).toBeNull();
    expect(switchRole).not.toHaveBeenCalled();
  });

  it("puts Product, Marketing and Security in the top bar; the logo goes to the Dashboard", () => {
    renderHeader();
    const nav = screen.getByRole("navigation", { name: "Workspace" });
    expect(nav.closest("header")).not.toBeNull();
    expect([...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/issues", "/marketing", "/security"]);
    const product = screen.getByRole("link", { name: "Product" });
    expect(product.getAttribute("href")).toBe("/issues");
    expect(product.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Marketing" }).getAttribute("href")).toBe("/marketing");
    expect(screen.getByRole("link", { name: "Security" }).getAttribute("href")).toBe("/security");
    expect(screen.getByRole("link", { name: "Ziki" }).getAttribute("href")).toBe("/dashboard");
  });

  it("opens each agent in the Agents menu on that agent's own page", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader({
      agents: [
        { id: "agent_1", name: "Pixel", level: "working" },
        { id: "agent_2", name: "Scout Two", level: "working" },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByRole("link", { name: /Pixel/ }).getAttribute("href")).toBe("/settings/agent/Pixel");
    expect(screen.getByRole("link", { name: /Scout Two/ }).getAttribute("href")).toBe("/settings/agent/Scout%20Two");
    // Each agent wears the same robot avatar it has everywhere else, and can be sent to earn.
    const row = screen.getByRole("link", { name: /Pixel/ }).parentElement!;
    expect(row.querySelector('[data-testid="agent-avatar"]')).toBeTruthy();
    expect(within(row).getByRole("link", { name: /earn/i }).getAttribute("href")).toBe("/settings/agent/Pixel");
  });

  it("has one way to manage agents", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader();
    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByRole("link", { name: /manage agents/i }).getAttribute("href")).toBe("/agents");
    expect(screen.queryByRole("link", { name: /create agent/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /get started/i })).toBeNull();
  });

  it("closes the Agents menu when a destination is chosen", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader();
    await user.click(screen.getByRole("button", { name: "Agents" }));
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("link", { name: "Manage agents" }));
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("counts unread notifications and waiting escalations on one envelope, which leads to the Inbox (#inbox)", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader({ unreadCount: 2, pendingEscalationsCount: 5 });
    const envelope = screen.getByRole("button", { name: /inbox.*7/i });
    expect(envelope.textContent).toContain("7");
    await user.click(envelope);
    expect(screen.getByRole("link", { name: /5 escalations/i }).getAttribute("href")).toBe("/inbox?tab=escalations");
    expect(screen.getByRole("link", { name: "Open inbox" }).getAttribute("href")).toBe("/inbox");
  });

  it("keeps New issue and the theme toggle out of the bar", () => {
    renderHeader();
    expect(screen.queryByRole("link", { name: /new issue/i })).toBeNull();
    expect(screen.queryByTestId("theme-toggle")).toBeNull();
  });

  it("does not put a Workspace menu in the bar", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Workspace" })).toBeNull();
  });

  it("shows the balance as dollars on the Agents button, links it to the ranking, and keeps it off the account chip", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader({ userId: "ada", points: 128, solvedTasks: 4 });
    // 100 points = $1.
    const agents = screen.getByRole("button", { name: /agents/i });
    expect(agents.textContent).toContain("$1.28");
    const account = screen.getByRole("button", { name: /account menu for ada lovelace/i });
    expect(account.textContent).not.toContain("128");
    expect(account.textContent).not.toContain("$1.28");
    expect(screen.queryByRole("link", { name: /\$1\.28/ })).toBeNull();

    await user.click(agents);
    const ranking = screen.getByRole("link", { name: /\$1\.28/ });
    expect(ranking.getAttribute("href")).toBe("/workers");
    expect(ranking.textContent).toContain("128");
  });

  it("keeps each control's visible text inside its accessible name", () => {
    const { container } = renderHeader({
      userId: "ada",
      points: 0,
      solvedTasks: 0,
      unreadCount: 3,
      pendingEscalationsCount: 5,
    });
    expect(labelInNameMismatches(container)).toEqual([]);
    const workspace = screen.getByRole("button", { name: /active workspace, ziki/i });
    expect(workspace.getAttribute("aria-label")).toBeNull();
    expect(workspace.textContent).toContain("Ziki");
  });

  it("switches the active workspace as soon as one is chosen", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader({
      workspaces: [
        { id: "t1", name: "Ziki", slug: "ziki" },
        { id: "t2", name: "Acme", slug: "acme" },
      ],
      activeTenantId: "t1",
    });

    await user.click(screen.getByRole("button", { name: /active workspace, ziki/i }));
    await user.click(screen.getByRole("option", { name: "Acme" }));

    expect(selectTenant).toHaveBeenCalledTimes(1);
    const data = selectTenant.mock.calls[0][0] as FormData;
    expect(data.get("tenantId")).toBe("t2");
  });

  it("links to workspaces when the person has none", () => {
    renderHeader({ workspaces: [], activeTenantId: null });
    expect(screen.queryByRole("button", { name: /active workspace/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Workspaces" }).getAttribute("href")).toBe("/tenants");
  });

  it("shows the slug when two workspaces share a name", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader({
      workspaces: [
        { id: "t1", name: "Acme", slug: "acme" },
        { id: "t2", name: "Acme", slug: "acme-eu" },
      ],
      activeTenantId: "t1",
    });
    const trigger = screen.getByRole("button", { name: /active workspace, acme \(acme\)/i });
    expect(trigger.getAttribute("aria-label")).toBeNull();
    await user.click(trigger);
    expect(screen.getByRole("option", { name: "Acme (acme)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Acme (acme-eu)" })).toBeTruthy();
  });

  it("puts Profile and Documentation in the account menu, no Dashboard or Switch workspace (#625)", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader({ userId: "ada", points: 128 });

    await user.click(screen.getByRole("button", { name: /account menu/i }));

    const menu = document.getElementById("account-menu")!;
    const links = [...menu.querySelectorAll("a")].map((a) => a.textContent);
    expect(menu.querySelector('a[href="/settings/profile"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: "Documentation" }).getAttribute("href")).toBe("/docs");
    expect(links).not.toContain("Dashboard");
    expect(links.some((text) => text?.startsWith("Switch workspace"))).toBe(false);
    // Points are beside the bell, and the menu shows no points or rank.
    expect(menu.textContent).not.toContain("128");
    expect(menu.textContent).not.toMatch(/Rank #/);
  });
});

describe("theme preference (#659)", () => {
  it("renders the theme options in the account menu", async () => {
    const user = userEvent.setup({ delay: null });
    renderHeader();

    await user.click(screen.getByRole("button", { name: /account menu/i }));

    expect(screen.getByRole("group", { name: /theme preference/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dark" })).toBeTruthy();
  });
});


describe("Profile account navigation (#576)", () => {
  it("links to Activity & Approvals and marks it current", async () => {
    navigation.pathname = "/activity";
    renderHeader();
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: /account menu/i }));
    const activity = screen.getByRole("link", { name: "Activity & Approvals" });
    expect(activity.getAttribute("href")).toBe("/activity");
    expect(activity.getAttribute("aria-current")).toBe("page");
  });

  it.each([
    ["/settings/profile", "Profile"],
    ["/settings", "Settings"],
    ["/settings/security", "Settings"],
  ])("marks only %s current in both account menus", async (pathname, currentLabel) => {
    navigation.pathname = pathname;
    const user = userEvent.setup({ delay: null });
    const { container } = renderHeader();

    for (const [buttonName, panelId] of [[/account menu/i, "account-menu"]] as const) {
      await user.click(screen.getByRole("button", { name: buttonName }));
      const panel = container.querySelector(`#${panelId}`)!;
      const profile = panel.querySelector('a[href="/settings/profile"]')!;
      const settings = panel.querySelector('a[href="/settings"]')!;
      expect(profile.getAttribute("aria-current")).toBe(currentLabel === "Profile" ? "page" : null);
      expect(settings.getAttribute("aria-current")).toBe(currentLabel === "Settings" ? "page" : null);
    }
  });
});
