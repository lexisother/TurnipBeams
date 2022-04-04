import { Member, User, Server, Client } from 'revolt.js';
import { attachMessageHandlerToClient } from './handler';
// import {attachEventListenersToClient} from "./eventListeners";
import { NamedCommand } from './command';
import { loadCommands } from './loader';

interface PermissionLevel {
  name: string;
  check: (user: User, member: Member | null) => boolean;
}

type PrefixResolver = (server: Server | undefined) => string;
type CategoryTransformer = (text: string) => string;

interface LaunchSettings {
  permissionLevels?: PermissionLevel[];
  getPrefix?: PrefixResolver;
  categoryTransformer?: CategoryTransformer;
  useTSExtension?: boolean;
}

export async function launch(
  newClient: Client,
  commandsDirectory: string,
  settings?: LaunchSettings,
) {
  // Core Launch Parameters //
  client.reset(); // Release any resources/connections being used by the placeholder client.
  client = newClient;
  loadableCommands = loadCommands(commandsDirectory, !!settings?.useTSExtension);
  attachMessageHandlerToClient(newClient);
  // attachEventListenersToClient(newClient);

  // Additional Configuration //
  if (settings?.permissionLevels) {
    if (settings.permissionLevels.length > 0) permissionLevels = settings.permissionLevels;
    else console.warn('permissionLevels must have at least one element to work!');
  }
  if (settings?.getPrefix) getPrefix = settings.getPrefix;
  if (settings?.categoryTransformer) categoryTransformer = settings.categoryTransformer;
}

export let loadableCommands = (async () => new Map<string, NamedCommand>())();
export let client = new Client();
export let permissionLevels: PermissionLevel[] = [
  {
    name: 'User',
    check: () => true,
  },
];
export let getPrefix: PrefixResolver = () => '.';
export let categoryTransformer: CategoryTransformer = (text) => text;
