/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { ApplicationIntegrationType } from "discord.js";
import { buildUserInstallHint } from "./install-hint.js";

describe("buildUserInstallHint", () => {
  it("returns null when the user already user-installed the app", () => {
    const owners = { [ApplicationIntegrationType.UserInstall]: "u1" };
    expect(buildUserInstallHint(owners, "app123")).toBeNull();
  });

  it("returns an install hint with the user-install link when only guild-installed", () => {
    const owners = { [ApplicationIntegrationType.GuildInstall]: "g1" };
    const hint = buildUserInstallHint(owners, "app123");
    expect(hint).not.toBeNull();
    expect(hint).toContain(
      "https://discord.com/oauth2/authorize?client_id=app123"
    );
    expect(hint).toContain("integration_type=1");
    expect(hint).toContain("scope=applications.commands");
  });

  it("returns a hint when owners is undefined (defensive)", () => {
    const hint = buildUserInstallHint(undefined, "app123");
    expect(hint).toContain("integration_type=1");
  });

  it("returns a hint when owners is an empty map (no UserInstall key)", () => {
    const hint = buildUserInstallHint({}, "app123");
    expect(hint).toContain("integration_type=1");
  });
});
