import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const requireUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/components/display-name-form", () => ({
  DisplayNameForm: ({ initialName }: { initialName: string }) => <input aria-label="Display name" defaultValue={initialName} />,
}));

import ProfilePage from "./page";

beforeEach(() => {
  vi.resetAllMocks();
  requireUser.mockResolvedValue({ id: "user-1", name: "Ada Lovelace", email: "ada@example.com", image: null });
});

describe("Profile settings (#576)", () => {
  it("uses the signed-in person's name and email and links to settings and their public profile", async () => {
    const markup = renderToStaticMarkup(await ProfilePage());
    expect(requireUser).toHaveBeenCalledTimes(1);
    expect(markup).toContain('aria-label="Display name" value="Ada Lovelace"');
    expect(markup).toContain("ada@example.com");
    expect(markup).not.toMatch(/<input[^>]*(?:type="email"|name="email")/);
    expect(markup).toContain('href="/settings?section=account"');
    expect(markup).toContain('href="/users/user-1"');
    expect(markup).not.toMatch(/>Remove</);
  });

  it("offers to remove the photo when the user already has an image", async () => {
    requireUser.mockResolvedValue({
      id: "user-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      image: "https://example.com/ada.png",
    });
    const markup = renderToStaticMarkup(await ProfilePage());
    expect(markup).toMatch(/>Remove</);
  });

  it("allows a missing display name to be edited", async () => {
    requireUser.mockResolvedValue({ id: "user-1", name: null, email: "ada@example.com", image: null });
    const markup = renderToStaticMarkup(await ProfilePage());
    expect(markup).toContain('aria-label="Display name" value=""');
  });

  it("requires authentication before rendering account details", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(ProfilePage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
