import { ApplicationIntegrationType } from "discord.js";

/**
 * Build a user-install nudge for the youtube-dm command. Returns null when the
 * invoking interaction was already authorized via user install. Otherwise (only
 * guild-installed, or owners missing) returns a hint plus the user-install link
 * so the DM path survives leaving the shared guild / the bot being removed.
 *
 * Link form (Discord install link, command-only, no token exchange):
 *   integration_type=1 => user install; scope=applications.commands => commands.
 */
export function buildUserInstallHint(
  owners: Partial<Record<ApplicationIntegrationType, string>> | undefined,
  applicationId: string
): string | null {
  const hasUserInstall =
    owners != null &&
    owners[ApplicationIntegrationType.UserInstall] !== undefined;
  if (hasUserInstall) return null;

  const url = `https://discord.com/oauth2/authorize?client_id=${applicationId}&integration_type=1&scope=applications.commands`;
  return (
    "💡 將本 App 安裝到你的帳號，即可在任何 DM 使用本指令（不受退出伺服器或移除 Bot 影響）：\n" +
    url
  );
}
