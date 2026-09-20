import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type CommandInteraction,
  type RESTPostAPIApplicationCommandsJSONBody,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

export interface AppCommand<
  Intr extends CommandInteraction = CommandInteraction,
  Meta extends RESTPostAPIApplicationCommandsJSONBody =
    RESTPostAPIApplicationCommandsJSONBody,
> {
  metadata: Meta;
  /**
   * Registration / execution scope.
   * - "global" (or unset): registered as a global application command.
   * - "devGuild": registered only to DISCORD_DEV_GUILD_ID and only executable there.
   */
  registration?: "global" | "devGuild";
  execute(intr: Intr): Promise<void>;
  autocomplete?: (intr: AutocompleteInteraction) => Promise<void>;
}

export type Command = AppCommand<
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody
>;
