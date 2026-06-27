import type { AppCommand } from "./command.js";

/**
 * Split commands into the global set and the dev-guild-only set based on each
 * command's `registration` marker (unset / "global" => global).
 */
export function partitionCommandsByScope(commands: AppCommand[]): {
  global: AppCommand[];
  devGuild: AppCommand[];
} {
  const global: AppCommand[] = [];
  const devGuild: AppCommand[] = [];
  for (const command of commands) {
    if (command.registration === "devGuild") {
      devGuild.push(command);
    } else {
      global.push(command);
    }
  }
  return { global, devGuild };
}

/**
 * Execution-time authorization guard for dev-guild-only commands. Registration
 * scope is only a visibility hint; this guard is the actual boundary, so a stale
 * / cached / failed registration cannot let a mod command run outside the dev
 * guild. Fails closed when the dev guild id is unset.
 */
export function isDevGuildCommandAllowed({
  registration,
  guildId,
  devGuildId,
}: {
  registration: AppCommand["registration"];
  guildId: string | null;
  devGuildId: string | undefined;
}): boolean {
  if (registration !== "devGuild") return true;
  if (!devGuildId) return false;
  return guildId === devGuildId;
}
