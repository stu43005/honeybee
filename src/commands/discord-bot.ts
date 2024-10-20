import assert from "assert";
import {
  Client,
  DiscordAPIError,
  Events,
  InteractionType,
  REST,
  RESTJSONErrorCodes,
  Routes,
  type Interaction,
  type RESTPutAPIApplicationCommandsJSONBody,
} from "discord.js";
import { commands } from "../discord/commands";
import { initMongo } from "../modules/db";
import type { AppCommand } from "../discord/commands/command";

const DISCORD_ID = process.env.DISCORD_ID!;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;

const IGNORED_ERRORS: (string | number)[] = [
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.UnknownGuild,
  RESTJSONErrorCodes.UnknownUser,
  RESTJSONErrorCodes.UnknownInteraction,
  RESTJSONErrorCodes.CannotSendMessagesToThisUser, // User blocked bot or DM disabled
  RESTJSONErrorCodes.ReactionWasBlocked, // User blocked bot or DM disabled
];

async function registerCommands(commands: AppCommand[]): Promise<void> {
  const cmdDatas: RESTPutAPIApplicationCommandsJSONBody = commands.map(
    (cmd) => cmd.metadata
  );
  const cmdNames = cmdDatas.map((cmdData) => cmdData.name);

  console.log(
    `Registering commands: ${cmdNames
      .map((cmdName) => `'${cmdName}'`)
      .join(", ")}.`
  );

  try {
    const rest = new REST({ version: "9" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(DISCORD_ID), { body: cmdDatas });
  } catch (error) {
    console.error(`An error occurred while registering commands.`, error);
    return;
  }

  console.log(`Commands registered.`);
}

export async function runDiscordBot() {
  assert(DISCORD_ID);
  assert(DISCORD_TOKEN);

  await registerCommands(commands);

  const disconnectFromMongo = await initMongo();
  const client = new Client({
    intents: [],
  });

  process.on("SIGTERM", async () => {
    console.log("quitting discord bot (SIGTERM) ...");

    try {
      await client.destroy();
      await disconnectFromMongo();
    } catch (err) {
      console.log("discord bot failed to shut down gracefully", err);
    }
    process.exit(0);
  });

  client.on(Events.ClientReady, () => {
    console.log(`Client logged in as ${client.user?.username}.`);
    const serverCount = client.guilds.cache.size;
    console.log(`Client is ready! Serve on ${serverCount} servers.`);
  });

  client.on(Events.InteractionCreate, async (intr: Interaction) => {
    try {
      if (
        intr.type === InteractionType.ApplicationCommand ||
        intr.type === InteractionType.ApplicationCommandAutocomplete
      ) {
        console.debug(
          `Receiving interaction: ${intr.id}, type: ${intr.type}, commandType: ${intr.commandType}, commandName: ${intr.commandName}`
        );

        // Don't respond to self, or other bots
        if (intr.user.id === intr.client.user?.id || intr.user.bot) {
          return;
        }

        const command = commands.find(
          (command) => command.metadata.name === intr.commandName
        );
        if (!command) {
          console.error(
            `[${intr.id}] A command with the name '${intr.commandName}' could not be found.`
          );
          return;
        }

        try {
          // Execute the command
          if (intr.type === InteractionType.ApplicationCommandAutocomplete) {
            if (command.autocomplete) {
              await command.autocomplete(intr);
            }
          } else {
            await command.execute(intr);
          }
        } catch (error) {
          // Log command error
          console.error(
            `[${intr.id}] An error occurred while executing the '${command.metadata.name}' command for user '${intr.user.username}' (${intr.user.id}).`,
            error
          );
        }
      }
    } catch (error) {
      if (
        error instanceof DiscordAPIError &&
        IGNORED_ERRORS.includes(error.code)
      ) {
        return;
      } else {
        console.error(
          "An error occurred while processing a command interaction.",
          error
        );
      }
    }
  });

  client.on(Events.Debug, (message) => console.debug(message));
  client.on(Events.Warn, (message) => console.warn(message));

  await client.login(DISCORD_TOKEN);
}
