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
