import { Message, Channel, Client } from 'revolt.js';
import { loadableCommands, getPrefix } from './interface';
import { CHANNEL_TYPE } from './command';

// For custom message events that want to cancel the command handler on certain conditions.
const interceptRules: ((message: Message) => boolean)[] = [
  (message) => message.author!.bot !== null,
];

export function addInterceptRule(handler: (message: Message) => boolean) {
  interceptRules.push(handler);
}

// The reason no rejection handler will be added by OnionLasers is because doing so would be far too restrictive.
// The resulting being that users wanting to add their own rejection handler would essentially have to work around the library rather than work with it.
interface ExecutedCommandInfo {
  header: string;
  args: string[];
  channel: Channel;
}

let executedCommandListener = (_executedCommandInfo: ExecutedCommandInfo) => {};

/**
 * This will allow you to capture the command and command arguments for keeping track of the last command or to do something whenever a command is executed.
 */
export function setExecuteCommandListener(
  listener: (executedCommandInfo: ExecutedCommandInfo) => void,
) {
  executedCommandListener = listener;
}

const defaultMetadata = {
  permission: 0,
  nsfw: false,
  channelType: 'TextChannel' as CHANNEL_TYPE,
};

// Note: client.user is only undefined before the bot logs in, so by this point, client.user cannot be undefined.
// Note: guild.available will never need to be checked because the message starts in either a DM channel or an already-available guild.
export function attachMessageHandlerToClient(client: Client) {
  client.on('message', async (message) => {
    for (const shouldIntercept of interceptRules) {
      if (shouldIntercept(message)) {
        return;
      }
    }

    const commands = await loadableCommands;
    const { author, content, member } = message;

    const channel = message.channel!;
    const server = channel!.server;
    const send = channel!.sendMessage.bind(channel);
    const text = content.toString();
    const menu = {
      author,
      channel,
      client,
      member,
      message,
      server,
      args: [],
      send,
    };

    // Execute a dedicated block for messages in DM channels.
    if (channel?.channel_type === 'DirectMessage') {
      // In a DM channel, simply forget about the prefix and execute any message as a command.
      const [header, ...args] = text.split(/ +/);

      if (commands.has(header)) {
        const command = commands.get(header)!;

        // Set last command info in case of unhandled rejections.
        executedCommandListener({
          header,
          args: [...args],
          channel,
        });

        // Send the arguments to the command to resolve and execute.
        const result = await command.execute(args, menu, {
          header,
          args: [...args],
          ...defaultMetadata,
          symbolicArgs: [],
        });

        // If something went wrong, let the user know (like if they don't have permission to use a command).
        if (result) {
          send(result);
        }
      } else {
        send(
          `I couldn't find the command or alias that starts with \`${header}\`. To see the list of commands, type \`help\``,
        );
      }
    } else {
      const prefix = getPrefix(server);
      // Revolt.JS does not have an easy way to check for member permissions yet. {{{
      // const hasPermissionToSend = channel
      //   .permissionsFor(client.user!)!
      //   .has(Permissions.FLAGS.SEND_MESSAGES);
      // const noPermissionToSendMessage = `I don't have permission to send messages in ${channel}. ${
      //   member!.hasPermission(Permissions.FLAGS.ADMINISTRATOR)
      //     ? "Because you're a server admin, you have the ability to change that channel's permissions to match if that's what you intended."
      //     : "Try using a different channel or contacting a server admin to change permissions of that channel if you think something's wrong."
      // }`;
      // }}}

      // First, test if the message is just a ping to the bot.
      if (new RegExp(`^<@!?${client.user!._id}>$`).test(text)) {
        // Let the user know the guild's prefix either through the channel or DMs if the bot can't send the message.
        // if (hasPermissionToSend)
        send(`My prefix on this server is \`${prefix}\`.`);
        // else author.send(noPermissionToSendMessage);
      }
      // Then check if it's a normal command.
      else if (text.startsWith(prefix)) {
        const [header, ...args] = text.substring(prefix.length).split(/ +/);

        if (commands.has(header)) {
          // If it's a valid command, check if the bot has permissions to send in that channel.
          // if (hasPermissionToSend) {
          const command = commands.get(header)!;

          // Set last command info in case of unhandled rejections.
          executedCommandListener({
            header,
            args: [...args],
            channel,
          });

          // Send the arguments to the command to resolve and execute.
          const result = await command.execute(args, menu, {
            header,
            args: [...args],
            ...defaultMetadata,
            symbolicArgs: [],
          });

          // If something went wrong, let the user know (like if they don't have permission to use a command).
          if (result) {
            send(result);
          }
          // }
          // Otherwise, let the sender know that the bot doesn't have permission to send messages.
          // else {
          //   author.send(noPermissionToSendMessage);
          // }
        }
      }
    }
  });
}
