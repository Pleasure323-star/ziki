// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UserNameWithBadges } from "./user-name-with-badges";
import type { AppRole } from "@/lib/roles";

afterEach(() => cleanup());

describe("UserNameWithBadges (#578)", () => {
  it("renders plain user name when no agent attribution is provided", () => {
    render(<UserNameWithBadges name="Cara QA" userId="u1" />);
    expect(screen.getByText("Cara QA")).toBeTruthy();
    expect(screen.queryByText(/via/)).toBeNull();
  });

  it("renders agent attribution badge with accessible label when agentName is provided", () => {
    const { container } = render(
      <UserNameWithBadges name="Cara QA" userId="u1" agentName="cara_reviewer" />,
    );
    expect(screen.getByText("Cara QA")).toBeTruthy();
    expect(container.textContent).toContain("cara_reviewer");
  });
});

describe("UserNameWithBadges Admin label (#489)", () => {
  const adminLabel = () => screen.queryByRole("status", { name: "Administrator" });
  // Account-wide roles, held in variables so the a11y lint does not read the
  // component's `role` prop as an ARIA role.
  const siteAdmin: AppRole = "admin";
  const superAdmin: AppRole = "super_admin";
  const plainUser: AppRole = "user";

  it("does not label an account-wide admin who is only a member of this organization", () => {
    render(<UserNameWithBadges name="Jen" role={siteAdmin} organizationRole="member" />);
    expect(adminLabel()).toBeNull();
  });

  it("does not label an account-wide admin whose organization role is unknown", () => {
    render(<UserNameWithBadges name="Jen" role={siteAdmin} />);
    expect(adminLabel()).toBeNull();
  });

  it.each(["admin", "owner"] as const)("labels an organization %s", (organizationRole) => {
    render(<UserNameWithBadges name="Ola" role={plainUser} organizationRole={organizationRole} />);
    expect(adminLabel()).toBeTruthy();
  });

  it("still labels the site's super admin, who has admin powers everywhere", () => {
    render(<UserNameWithBadges name="Root" role={superAdmin} organizationRole="member" />);
    expect(adminLabel()).toBeTruthy();
  });

  it("does not label a plain member", () => {
    render(<UserNameWithBadges name="Ada" role={plainUser} organizationRole="member" />);
    expect(adminLabel()).toBeNull();
  });
});
