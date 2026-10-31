// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  startTwoFactorAction: vi.fn(),
  confirmTwoFactorAction: vi.fn(),
  disableTwoFactorAction: vi.fn(),
  regenerateBackupCodesAction: vi.fn(),
  refresh: vi.fn(),
}));
const copyTextMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./actions", () => ({
  startTwoFactorAction: actions.startTwoFactorAction,
  confirmTwoFactorAction: actions.confirmTwoFactorAction,
  disableTwoFactorAction: actions.disableTwoFactorAction,
  regenerateBackupCodesAction: actions.regenerateBackupCodesAction,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh }) }));
vi.mock("@/lib/clipboard", () => ({ copyText: copyTextMock }));

import { TwoFactorSettings } from "./two-factor-settings";

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("TwoFactorSettings (#648)", () => {
  it("walks setup: password, scan and confirm, then shows the backup codes once", async () => {
    const user = userEvent.setup({ delay: null });
    actions.startTwoFactorAction.mockResolvedValue({ ok: true, secret: "JBSWY3DPEHPK3PXP", qr: "data:image/png;base64,AAAA" });
    actions.confirmTwoFactorAction.mockResolvedValue({ ok: true, codes: ["AAAAA-BBBBB", "CCCCC-DDDDD"] });
    render(<TwoFactorSettings enabled={false} backupCodesLeft={0} />);

    expect(screen.getByText("Off")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Set up two-factor sign-in" }));
    await user.type(screen.getByLabelText("Confirm your password to continue"), "pw");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByAltText("QR code for your authenticator app")).toBeInTheDocument();
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Enter the 6-digit code/), "123456");
    await user.click(screen.getByRole("button", { name: "Turn on" }));

    const list = await screen.findByRole("list", { name: "Backup codes" });
    expect(list).toHaveTextContent("AAAAA-BBBBB");
    expect(screen.getByRole("status")).toHaveTextContent(/signed out/i);
    await user.click(screen.getByRole("button", { name: "I've saved them" }));
    expect(actions.refresh).toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: "Backup codes" })).toBeNull();
  });

  it("shows the reason when the password or code is wrong and stays on the step", async () => {
    const user = userEvent.setup({ delay: null });
    actions.startTwoFactorAction.mockResolvedValue({ ok: false, error: "That password isn't right." });
    render(<TwoFactorSettings enabled={false} backupCodesLeft={0} />);
    await user.click(screen.getByRole("button", { name: "Set up two-factor sign-in" }));
    await user.type(screen.getByLabelText("Confirm your password to continue"), "bad");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That password isn't right.");
    expect(screen.getByLabelText("Confirm your password to continue")).toBeInTheDocument();
  });

  it("when on, shows the backup codes left and asks for password and code to turn off", async () => {
    const user = userEvent.setup({ delay: null });
    actions.disableTwoFactorAction.mockResolvedValue({ ok: true });
    render(<TwoFactorSettings enabled backupCodesLeft={1} />);

    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText(/1 backup code left/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    await user.type(screen.getByLabelText("Password"), "pw");
    await user.type(screen.getByLabelText("Authenticator or backup code"), "123456");
    await user.click(screen.getByRole("button", { name: "Turn off" }));

    await waitFor(() => expect(actions.disableTwoFactorAction).toHaveBeenCalled());
    const sent = actions.disableTwoFactorAction.mock.calls[0][0] as FormData;
    expect(sent.get("password")).toBe("pw");
    expect(sent.get("code")).toBe("123456");
    await waitFor(() => expect(actions.refresh).toHaveBeenCalled());
    expect(screen.getByRole("status")).toHaveTextContent(/signed out/i);
  });

  it("makes new backup codes after re-authentication and shows them", async () => {
    const user = userEvent.setup({ delay: null });
    actions.regenerateBackupCodesAction.mockResolvedValue({ ok: true, codes: ["XXXXX-YYYYY"] });
    render(<TwoFactorSettings enabled backupCodesLeft={5} />);
    await user.click(screen.getByRole("button", { name: "Make new backup codes" }));
    await user.type(screen.getByLabelText("Password"), "pw");
    await user.type(screen.getByLabelText("Authenticator or backup code"), "123456");
    await user.click(screen.getByRole("button", { name: "Make new codes" }));
    expect(await screen.findByRole("list", { name: "Backup codes" })).toHaveTextContent("XXXXX-YYYYY");
    expect(screen.getByRole("status")).toHaveTextContent(/signed out/i);
  });

  it("drops the signed-out notice when the next change fails or is cancelled", async () => {
    const user = userEvent.setup({ delay: null });
    actions.regenerateBackupCodesAction
      .mockResolvedValueOnce({ ok: true, codes: ["XXXXX-YYYYY"] })
      .mockResolvedValueOnce({ ok: false, error: "That code isn't right." });
    render(<TwoFactorSettings enabled backupCodesLeft={5} />);
    const makeCodes = async () => {
      await user.click(screen.getByRole("button", { name: "Make new backup codes" }));
      await user.type(screen.getByLabelText("Password"), "pw");
      await user.type(screen.getByLabelText("Authenticator or backup code"), "123456");
      await user.click(screen.getByRole("button", { name: "Make new codes" }));
    };

    await makeCodes();
    await user.click(await screen.findByRole("button", { name: "I've saved them" }));
    expect(screen.getByRole("status")).toHaveTextContent(/signed out/i);

    await makeCodes();
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't right.");
    expect(screen.queryByRole("status")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("explains when copying backup codes fails and keeps them available", async () => {
    const user = userEvent.setup({ delay: null });
    copyTextMock.mockResolvedValueOnce(false);
    actions.regenerateBackupCodesAction.mockResolvedValue({ ok: true, codes: ["XXXXX-YYYYY"] });
    render(<TwoFactorSettings enabled backupCodesLeft={5} />);
    await user.click(screen.getByRole("button", { name: "Make new backup codes" }));
    await user.type(screen.getByLabelText("Password"), "pw");
    await user.type(screen.getByLabelText("Authenticator or backup code"), "123456");
    await user.click(screen.getByRole("button", { name: "Make new codes" }));
    await screen.findByRole("list", { name: "Backup codes" });

    await user.click(screen.getByRole("button", { name: "Copy codes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/copy/i);
    expect(screen.getByRole("list", { name: "Backup codes" })).toHaveTextContent("XXXXX-YYYYY");
  });

  it("can be cancelled without calling anything", async () => {
    const user = userEvent.setup({ delay: null });
    render(<TwoFactorSettings enabled backupCodesLeft={5} />);
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(actions.disableTwoFactorAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
