import { Client, Message, Member, User, Server, Channel } from 'revolt.js';
import { requireAllCasesHandledFor, parseVars } from './util';
import { getPermissionName, getPermissionLevel, hasPermission } from './permission';
import { SendFunction, getChannelByID, getGuildByID, getMessageByID, getUserByID } from './lib';
import { getPrefix } from './interface';

const patterns = {
  channel: /^<#(\w{26,})>$/,
  emote: /^:(\w+):$/,
  messageLink:
    /^https?:\/\/(?:nightly\.|app\.)?revolt\.chat\/(?:server|channel)\/(\w{26,})\/(\w{26,}|channel\/\w{26,}\/\w{7,})$/,
  user: /^<@?(\w{26,})>$/,
  id: /^(\w{26,})$/,
};

type ID = 'channel' | 'role' | 'emote' | 'message' | 'user' | 'server';

export type CHANNEL_TYPE = Channel['channel_type'];

interface CommandMenu {
  readonly args: any[];
  readonly client: Client;
  readonly message: Message;
  readonly channel: Channel;
  readonly server: Server | undefined;
  readonly author: User | undefined;
  readonly member: Member | undefined;
  readonly send: SendFunction;
}

interface CommandOptionsBase {
  readonly description?: string;
  readonly usage?: string;
  readonly permission?: number;
  readonly nsfw?: boolean;
  readonly channelType?: CHANNEL_TYPE;
}

interface CommandOptions extends CommandOptionsBase {
  readonly run?: (($: CommandMenu) => Promise<any>) | string;
  readonly subcommands?: { [key: string]: NamedCommand };
  readonly channel?: Command;
  readonly role?: Command;
  readonly emote?: Command;
  readonly message?: Command;
  readonly user?: Command;
  readonly guild?: Command; // Only available if an ID is set to reroute to it.
  readonly id?: ID;
  readonly number?: Command;
  readonly any?: Command | RestCommand;
}

interface NamedCommandOptions extends CommandOptions {
  readonly aliases?: string[];
  readonly nameOverride?: string;
}

interface RestCommandOptions extends CommandOptionsBase {
  readonly run?: (($: CommandMenu & { readonly combined: string }) => Promise<any>) | string;
}

interface ExecuteCommandMetadata {
  readonly header: string;
  readonly args: string[];
  permission: number;
  nsfw: boolean;
  channelType: CHANNEL_TYPE;
  symbolicArgs: string[]; // i.e. <channel> instead of <#...>
}

export interface CommandInfo {
  readonly type: 'info';
  readonly command: BaseCommand;
  readonly subcommandInfo: Map<string, BaseCommand>;
  readonly keyedSubcommandInfo: Map<string, BaseCommand>;
  readonly permission: number;
  readonly nsfw: boolean;
  readonly channelType: CHANNEL_TYPE;
  readonly args: string[];
  readonly header: string;
}

interface CommandInfoError {
  readonly type: 'error';
  readonly message: string;
}

interface CommandInfoMetadata {
  permission: number;
  nsfw: boolean;
  channelType: CHANNEL_TYPE;
  args: string[];
  usage: string;
  readonly originalArgs: string[];
  readonly header: string;
}

// Pure metadata command; intended for extension
abstract class BaseCommand {
  public readonly description: string;
  public readonly usage: string;
  public readonly permission: number; // -1 (default) indicates to inherit, 0 is the lowest rank, 1 is second lowest rank, and so on.
  public readonly nsfw: boolean | null; // null (default) indicates to inherit
  public readonly channelType: CHANNEL_TYPE | null; // null (default) indicates to inherit

  constructor(options?: CommandOptionsBase) {
    this.description = options?.description || 'No description.';
    this.usage = options?.usage ?? '';
    this.permission = options?.permission ?? -1;
    this.nsfw = options?.nsfw ?? null;
    this.channelType = options?.channelType ?? null;
  }
}

export class Command extends BaseCommand {
  // The execute and subcommand properties are restricted to the class because subcommand recursion could easily break when manually handled.
  // The class will handle checking for null fields.
  private run: (($: CommandMenu) => Promise<any>) | string;
  private readonly subcommands: Map<string, NamedCommand>; // This is the final data structure you'll actually use to work with the commands the aliases point to.
  private channel: Command | null;
  private role: Command | null;
  private emote: Command | null;
  private message: Command | null;
  private user: Command | null;
  private guild: Command | null;
  private id: Command | null;
  private idType: ID | null;
  private number: Command | null;
  private any: Command | RestCommand | null;

  constructor(options?: CommandOptions) {
    super(options);
    this.run = options?.run || 'No action was set on this command!';
    this.subcommands = new Map(); // Populate this collection after setting subcommands.
    this.channel = options?.channel || null;
    this.role = options?.role || null;
    this.emote = options?.emote || null;
    this.message = options?.message || null;
    this.user = options?.user || null;
    this.guild = options?.guild || null;
    this.id = null;
    this.idType = options?.id || null;
    this.number = options?.number || null;
    this.any = options?.any || null;

    if (options)
      switch (options.id) {
        case 'channel':
          this.id = this.channel;
          break;
        case 'role':
          this.id = this.role;
          break;
        case 'emote':
          this.id = this.emote;
          break;
        case 'message':
          this.id = this.message;
          break;
        case 'user':
          this.id = this.user;
          break;
        case 'server':
          this.id = this.guild;
          break;
        case undefined:
          break;
        default:
          requireAllCasesHandledFor(options.id);
      }

    if (options?.subcommands) {
      const baseSubcommands = Object.keys(options.subcommands);

      // Loop once to set the base subcommands.
      for (const name in options.subcommands) this.subcommands.set(name, options.subcommands[name]);

      // Then loop again to make aliases point to the base subcommands and warn if something's not right.
      // This shouldn't be a problem because I'm hoping that JS stores these as references that point to the same object.
      for (const name in options.subcommands) {
        const subcmd = options.subcommands[name];
        subcmd.name = name;
        const aliases = subcmd.aliases;

        for (const alias of aliases) {
          if (baseSubcommands.includes(alias))
            console.warn(
              `"${alias}" in subcommand "${name}" was attempted to be declared as an alias but it already exists in the base commands! (Look at the next "Loading Command" line to see which command is affected.)`,
            );
          else if (this.subcommands.has(alias))
            console.warn(
              `Duplicate alias "${alias}" at subcommand "${name}"! (Look at the next "Loading Command" line to see which command is affected.)`,
            );
          else this.subcommands.set(alias, subcmd);
        }
      }
    }
  }

  // Go through the arguments provided and find the right subcommand, then execute with the given arguments.
  // Will return null if it successfully executes, string if there's an error (to let the user know what it is).
  //
  // Calls the resulting subcommand's execute method in order to make more modular code, basically pushing the chain of execution to the subcommand.
  // For example, a numeric subcommand would accept args of [4] then execute on it.
  //
  // Because each Command instance is isolated from others, it becomes practically impossible to predict the total amount of subcommands when isolating the code to handle each individual layer of recursion.
  // Therefore, if a Command is declared as a rest type, any typed args that come at the end must be handled manually.
  public async execute(
    args: string[],
    menu: CommandMenu,
    metadata: ExecuteCommandMetadata,
  ): Promise<string | null> {
    // Update inherited properties if the current command specifies a property.
    // In case there are no initial arguments, these should go first so that it can register.
    if (this.permission !== -1) metadata.permission = this.permission;
    if (this.nsfw !== null) metadata.nsfw = this.nsfw;
    if (this.channelType !== null) metadata.channelType = this.channelType;

    // Take off the leftmost argument from the list.
    const param = args.shift();

    // If there are no arguments left, execute the current command. Otherwise, continue on.
    if (param === undefined) {
      const error = canExecute(menu, metadata);
      if (error) return error;

      if (typeof this.run === 'string') {
        // Although I *could* add an option in the launcher to attach arbitrary variables to this var string...
        // I'll just leave it like this, because instead of using var strings for user stuff, you could just make "run" a template string.
        await menu.send(
          parseVars(
            this.run,
            {
              author: menu.author!.toString(),
              prefix: getPrefix(menu.server),
              command: `${metadata.header} ${metadata.symbolicArgs.join(', ')}`,
            },
            '???',
          ),
        );
      } else {
        // Then capture any potential errors.
        try {
          await this.run(menu);
        } catch (error: any) {
          const errorMessage = error.stack ?? error;
          console.error(
            `Command Error: ${metadata.header} (${metadata.args.join(', ')})\n${errorMessage}`,
          );

          return `There was an error while trying to execute that command!\`\`\`${errorMessage}\`\`\``;
        }
      }

      return null;
    }

    // Resolve the value of the current command's argument (adding it to the resolved args),
    // then pass the thread of execution to whichever subcommand is valid (if any).
    const isMessageLink = patterns.messageLink.test(param);

    if (this.subcommands.has(param)) {
      metadata.symbolicArgs.push(param);
      return this.subcommands.get(param)!.execute(args, menu, metadata);
    } else if (this.channel && patterns.channel.test(param)) {
      const id = patterns.channel.exec(param)![1];
      const channel = await getChannelByID(id);

      // The channel could be of any type as long as it matches <#...>.
      // The user would have to specify the channel type themselves via instanceof.
      // No narrowing is done because it'd be too restrictive.
      if (typeof channel !== 'string') {
        metadata.symbolicArgs.push('<channel>');
        menu.args.push(channel);
        return this.channel.execute(args, menu, metadata);
      } else {
        return channel;
      }
    }
    // Role mentions are not a thing yet
    // else if (this.role && patterns.role.test(param)) {
    //   const id = patterns.role.exec(param)![1];
    //   if (!menu.guild) return "You can't use role parameters in DM channels!";
    //   const role = menu.guild.roles.cache.get(id);
    //
    //   if (role) {
    //     metadata.symbolicArgs.push('<role>');
    //     menu.args.push(role);
    //     return this.role.execute(args, menu, metadata);
    //   } else {
    //     return `\`${id}\` is not a valid role in this server!`;
    //   }
    // }
    // Emotes aren't a fetchable thing yet
    // else if (this.emote && patterns.emote.test(param)) {
    //   const id = patterns.emote.exec(param)![1];
    //   const emote = menu.client.emojis.cache.get(id);
    //
    //   if (emote) {
    //     metadata.symbolicArgs.push('<emote>');
    //     menu.args.push(emote);
    //     return this.emote.execute(args, menu, metadata);
    //   } else {
    //     return `\`${id}\` isn't a valid emote!`;
    //   }
    // }
    else if (this.message && isMessageLink) {
      let channelID = '';
      let messageID = '';

      if (isMessageLink) {
        const result = patterns.messageLink.exec(param)!;
        channelID = result[1];
        messageID = result[2];
      }

      const message = await getMessageByID(channelID, messageID);

      if (typeof message !== 'string') {
        metadata.symbolicArgs.push('<message>');
        menu.args.push(message);
        return this.message.execute(args, menu, metadata);
      } else {
        return message;
      }
    } else if (this.user && patterns.user.test(param)) {
      const id = patterns.user.exec(param)![1];
      const user = await getUserByID(id);

      if (typeof user !== 'string') {
        metadata.symbolicArgs.push('<user>');
        menu.args.push(user);
        return this.user.execute(args, menu, metadata);
      } else {
        return user;
      }
    } else if (this.id && this.idType && patterns.id.test(param)) {
      metadata.symbolicArgs.push('<id>');
      const id = patterns.id.exec(param)![1];

      switch (this.idType) {
        case 'channel':
          const channel = await getChannelByID(id);

          if (typeof channel !== 'string') {
            metadata.symbolicArgs.push('<channel>');
            menu.args.push(channel);
            return this.id.execute(args, menu, metadata);
          } else {
            return channel;
          }
        case 'role':
          if (!menu.server) return "You can't use role parameters in DM channels!";
          const role = menu.server.roles![id];

          if (role) {
            menu.args.push(role);
            return this.id.execute(args, menu, metadata);
          } else {
            return `\`${id}\` isn't a valid role in this server!`;
          }
        // Emotes aren't a thing yet.
        case 'emote':
          return "Emotes aren't implemented in Revolt yet.";
        // const emote = menu.client.emojis.cache.get(id);
        //
        // if (emote) {
        //   menu.args.push(emote);
        //   return this.id.execute(args, menu, metadata);
        // } else {
        //   return `\`${id}\` isn't a valid emote!`;
        // }
        case 'message':
          const message = await getMessageByID(menu.channel, id);

          if (typeof message !== 'string') {
            menu.args.push(message);
            return this.id.execute(args, menu, metadata);
          } else {
            return message;
          }
        case 'user':
          const user = await getUserByID(id);

          if (typeof user !== 'string') {
            menu.args.push(user);
            return this.id.execute(args, menu, metadata);
          } else {
            return user;
          }
        case 'server':
          const guild = getGuildByID(id);

          if (typeof guild !== 'string') {
            menu.args.push(guild);
            return this.id.execute(args, menu, metadata);
          } else {
            return guild;
          }
        default:
          requireAllCasesHandledFor(this.idType);
      }
    } else if (
      this.number &&
      !Number.isNaN(Number(param)) &&
      param !== 'Infinity' &&
      param !== '-Infinity'
    ) {
      metadata.symbolicArgs.push('<number>');
      menu.args.push(Number(param));
      return this.number.execute(args, menu, metadata);
    } else if (this.any instanceof Command) {
      metadata.symbolicArgs.push('<any>');
      menu.args.push(param);
      return this.any.execute(args, menu, metadata);
    } else if (this.any instanceof RestCommand) {
      metadata.symbolicArgs.push('<...>');
      args.unshift(param);
      menu.args.push(...args);
      return this.any.execute(args.join(' '), menu, metadata);
    } else {
      metadata.symbolicArgs.push(`"${param}"`);
      return `No valid command sequence matching \`${metadata.header} ${metadata.symbolicArgs.join(
        ' ',
      )}\` found.`;
    }
  }

  // What this does is resolve the resulting subcommand as well as the inherited properties and the available subcommands.
  public resolveInfo(args: string[], header: string): CommandInfo | CommandInfoError {
    return this.resolveInfoInternal(args, {
      permission: 0,
      nsfw: false,
      channelType: 'TextChannel',
      header,
      args: [],
      usage: '',
      originalArgs: [...args],
    });
  }

  private resolveInfoInternal(
    args: string[],
    metadata: CommandInfoMetadata,
  ): CommandInfo | CommandInfoError {
    // Update inherited properties if the current command specifies a property.
    // In case there are no initial arguments, these should go first so that it can register.
    if (this.permission !== -1) metadata.permission = this.permission;
    if (this.nsfw !== null) metadata.nsfw = this.nsfw;
    if (this.channelType !== null) metadata.channelType = this.channelType;
    if (this.usage !== '') metadata.usage = this.usage;

    // Take off the leftmost argument from the list.
    const param = args.shift();

    // If there are no arguments left, return the data or an error message.
    if (param === undefined) {
      const keyedSubcommandInfo = new Map<string, BaseCommand>();
      const subcommandInfo = new Map<string, BaseCommand>();

      // Get all the subcommands of the current command but without aliases.
      for (const [tag, command] of this.subcommands.entries()) {
        // Don't capture duplicates generated from aliases.
        if (tag === command.name) {
          keyedSubcommandInfo.set(tag, command);
        }
      }

      // Then get all the generic subcommands.
      if (this.channel) subcommandInfo.set('<channel>', this.channel);
      if (this.role) subcommandInfo.set('<role>', this.role);
      if (this.emote) subcommandInfo.set('<emote>', this.emote);
      if (this.message) subcommandInfo.set('<message>', this.message);
      if (this.user) subcommandInfo.set('<user>', this.user);
      if (this.id) subcommandInfo.set(`<id = <${this.idType}>>`, this.id);
      if (this.number) subcommandInfo.set('<number>', this.number);

      // The special case for a possible rest command.
      if (this.any) {
        if (this.any instanceof Command) subcommandInfo.set('<any>', this.any);
        else subcommandInfo.set('<...>', this.any);
      }

      return {
        type: 'info',
        command: this,
        keyedSubcommandInfo,
        subcommandInfo,
        ...metadata,
      };
    }

    const invalidSubcommandGenerator: () => CommandInfoError = () => ({
      type: 'error',
      message: `No subcommand found by the argument list: \`${metadata.originalArgs.join(' ')}\``,
    });

    // Then test if anything fits any hardcoded values, otherwise check if it's a valid keyed subcommand.
    if (param === '<channel>') {
      if (this.channel) {
        metadata.args.push('<channel>');
        return this.channel.resolveInfoInternal(args, metadata);
      } else {
        return invalidSubcommandGenerator();
      }
    } else if (param === '<role>') {
      if (this.role) {
        metadata.args.push('<role>');
        return this.role.resolveInfoInternal(args, metadata);
      } else {
        return invalidSubcommandGenerator();
      }
    } else if (param === '<emote>') {
      if (this.emote) {
        metadata.args.push('<emote>');
        return this.emote.resolveInfoInternal(args, metadata);
      } else {
        return invalidSubcommandGenerator();
      }
    } else if (param === '<message>') {
      if (this.message) {
        metadata.args.push('<message>');
        return this.message.resolveInfoInternal(args, metadata);
      } else {
        return invalidSubcommandGenerator();
      }
    } else if (param === '<user>') {
      if (this.user) {
        metadata.args.push('<user>');
        return this.user.resolveInfoInternal(args, metadata);
      } else {
        return invalidSubcommandGenerator();
      }
    } else if (param === '<id>') {
      if (this.id) {
        metadata.args.push(`<id = <${this.idType}>>`);
        return this.id.resolveInfoInternal(args, metadata);
      } else {
        return invalidSubcommandGenerator();
      }
    } else if (param === '<number>') {
      if (this.number) {
        metadata.args.push('<number>');
        return this.number.resolveInfoInternal(args, metadata);
      } else {
        return invalidSubcommandGenerator();
      }
    } else if (param === '<any>') {
      if (this.any instanceof Command) {
        metadata.args.push('<any>');
        return this.any.resolveInfoInternal(args, metadata);
      } else {
        return invalidSubcommandGenerator();
      }
    } else if (param === '<...>') {
      if (this.any instanceof RestCommand) {
        metadata.args.push('<...>');
        return this.any.resolveInfoFinale(metadata);
      } else {
        return invalidSubcommandGenerator();
      }
    } else if (this.subcommands?.has(param)) {
      metadata.args.push(param);
      return this.subcommands.get(param)!.resolveInfoInternal(args, metadata);
    } else {
      return invalidSubcommandGenerator();
    }
  }
}

export class NamedCommand extends Command {
  public readonly aliases: string[];
  private originalCommandName: string | null;

  constructor(options?: NamedCommandOptions) {
    super(options);
    this.aliases = options?.aliases || [];
    this.originalCommandName = options?.nameOverride ?? null;
  }

  public get name(): string {
    if (this.originalCommandName === null)
      throw new Error('originalCommandName must be set before accessing it!');
    else return this.originalCommandName;
  }

  public set name(value: string) {
    if (this.originalCommandName !== null)
      throw new Error(
        `originalCommandName cannot be set twice! Attempted to set the value to "${value}".`,
      );
    else this.originalCommandName = value;
  }

  public isNameSet(): boolean {
    return this.originalCommandName !== null;
  }
}

// RestCommand is a declarative version of the common "any: args.join(' ')" pattern, basically the Command version of a rest parameter.
// This way, you avoid having extra subcommands when using this pattern.
// I'm probably not going to add a transformer function (a callback to automatically handle stuff like searching for usernames).
// I don't think the effort to figure this part out via generics or something is worth it.
export class RestCommand extends BaseCommand {
  private run: (($: CommandMenu & { readonly combined: string }) => Promise<any>) | string;

  constructor(options?: RestCommandOptions) {
    super(options);
    this.run = options?.run || 'No action was set on this command!';
  }

  public async execute(
    combined: string,
    menu: CommandMenu,
    metadata: ExecuteCommandMetadata,
  ): Promise<string | null> {
    // Update inherited properties if the current command specifies a property.
    // In case there are no initial arguments, these should go first so that it can register.
    if (this.permission !== -1) metadata.permission = this.permission;
    if (this.nsfw !== null) metadata.nsfw = this.nsfw;
    if (this.channelType !== null) metadata.channelType = this.channelType;

    const error = canExecute(menu, metadata);
    if (error) return error;

    if (typeof this.run === 'string') {
      // Although I *could* add an option in the launcher to attach arbitrary variables to this var string...
      // I'll just leave it like this, because instead of using var strings for user stuff, you could just make "run" a template string.
      await menu.send(
        parseVars(
          this.run,
          {
            author: menu.author!.toString(),
            prefix: getPrefix(menu.server),
            command: `${metadata.header} ${metadata.symbolicArgs.join(', ')}`,
          },
          '???',
        ),
      );
    } else {
      // Then capture any potential errors.
      try {
        // Args will still be kept intact. A common pattern is popping some parameters off the end then doing some branching.
        // That way, you can still declaratively mark an argument list as continuing while also handling the individual args.
        await this.run({ ...menu, args: menu.args, combined });
      } catch (error: any) {
        const errorMessage = error.stack ?? error;
        console.error(
          `Command Error: ${metadata.header} (${metadata.args.join(', ')})\n${errorMessage}`,
        );

        return `There was an error while trying to execute that command!\`\`\`${errorMessage}\`\`\``;
      }
    }

    return null;
  }

  public resolveInfoFinale(metadata: CommandInfoMetadata): CommandInfo {
    if (this.permission !== -1) metadata.permission = this.permission;
    if (this.nsfw !== null) metadata.nsfw = this.nsfw;
    if (this.channelType !== null) metadata.channelType = this.channelType;
    if (this.usage !== '') metadata.usage = this.usage;

    return {
      type: 'info',
      command: this,
      keyedSubcommandInfo: new Map<string, BaseCommand>(),
      subcommandInfo: new Map<string, BaseCommand>(),
      ...metadata,
    };
  }
}

// See if there is anything that'll prevent the user from executing the command.
// Returns null if successful, otherwise returns a message with the error.
function canExecute(menu: CommandMenu, metadata: ExecuteCommandMetadata): string | null {
  // 1. Does this command specify a required channel type? If so, does the channel type match?
  if (
    metadata.channelType === 'TextChannel' &&
    (!(menu.channel.channel_type === 'TextChannel') || menu.server === null || menu.member === null)
  ) {
    return 'This command must be executed in a server.';
  } else if (
    metadata.channelType === 'DirectMessage' &&
    (menu.channel.channel_type !== 'DirectMessage' || menu.server !== null || menu.member !== null)
  ) {
    return 'This command must be executed as a direct message.';
  }

  // 2. Is this an NSFW command where the channel prevents such use? (DM channels bypass this requirement.)
  if (metadata.nsfw && menu.channel.channel_type !== 'DirectMessage' && !menu.channel) {
    return 'This command must be executed in either an NSFW channel or as a direct message.';
  }

  // 3. Does the user have permission to execute the command?
  if (!hasPermission(menu.author!, menu.member!, metadata.permission)) {
    const userPermLevel = getPermissionLevel(menu.author!, menu.member!);

    return `You don't have access to this command! Your permission level is \`${getPermissionName(
      userPermLevel,
    )}\` (${userPermLevel}), but this command requires a permission level of \`${getPermissionName(
      metadata.permission,
    )}\` (${metadata.permission}).`;
  }

  return null;
}
