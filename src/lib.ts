import { Channel, Message, User, Server } from 'revolt.js';
import { client } from './interface';

export type SendFunction = Channel['sendMessage'];

export function getGuildByID(id: string): Server | string {
  const guild = client.servers.get(id);
  if (guild) {
    return guild;
  } else {
    return `No guild found by the ID of \`${id}\`!`;
  }
}

export async function getChannelByID(id: string): Promise<Channel | string> {
  try {
    return await client.channels.fetch(id);
  } catch {
    return `No channel found by the ID of \`${id}\`!`;
  }
}

export async function getMessageByID(
  channel: Channel | string,
  id: string,
): Promise<Message | string> {
  if (typeof channel === 'string') {
    const targetChannel = await getChannelByID(channel);
    if (targetChannel instanceof Channel)
      if (
        targetChannel.channel_type === 'TextChannel' ||
        targetChannel.channel_type === 'DirectMessage'
      )
        channel = targetChannel;
      else return `\`${id}\` isn't a valid text-based channel!`;
    else return targetChannel;
  }

  try {
    return await channel.fetchMessage(id);
  } catch {
    return `\`${id}\` isn't a valid message of the channel ${channel}!`;
  }
}

export async function getUserByID(id: string): Promise<User | string> {
  try {
    return await client.users.fetch(id);
  } catch {
    return `No user found by the ID of \`${id}\`!`;
  }
}
