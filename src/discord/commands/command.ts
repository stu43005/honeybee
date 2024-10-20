import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type CommandInteraction,
  type RESTPostAPIApplicationCommandsJSONBody,
  type RESTPostAPIChatInputApplicationCommandsJSONBody
} from 'discord.js';

export interface AppCommand<
    Intr extends CommandInteraction = CommandInteraction,
    Meta extends RESTPostAPIApplicationCommandsJSONBody = RESTPostAPIApplicationCommandsJSONBody,
> {
    metadata: Meta;
    execute(intr: Intr): Promise<void>;
    autocomplete?: (intr: AutocompleteInteraction) => Promise<void>;
}

export type Command = AppCommand<
    ChatInputCommandInteraction,
    RESTPostAPIChatInputApplicationCommandsJSONBody
>;
