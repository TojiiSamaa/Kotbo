import { Collection, Guild, GuildMember } from 'discord.js';
import { logger } from './logger.js';

/**
 * Reliable helper to fetch all guild members, paging through Discord's REST API
 * if the gateway chunking fails, is disabled, or gets truncated.
 */
export async function fetchAllMembers(guild: Guild): Promise<Collection<string, GuildMember>> {
  try {
    // Try to fetch via gateway chunking first
    const members = await guild.members.fetch();
    if (members && members.size > 0 && members.size >= (guild.memberCount ?? 0)) {
      return members;
    }
    logger.warn('DiscordUtils', `Gateway member fetch returned ${members?.size} out of ${guild.memberCount} members for guild ${guild.id}. Falling back to paginated fetch.`);
  } catch (err) {
    logger.warn('DiscordUtils', `Gateway member fetch failed or timed out for guild ${guild.id}: ${String(err)}. Falling back to paginated fetch.`);
  }

  // Fallback: paginated REST fetch
  const allMembers = new Collection<string, GuildMember>();
  let lastId: string | undefined = undefined;

  for (;;) {
    try {
      const options: Record<string, unknown> = { limit: 1000 };
      if (lastId) {
        options.after = lastId;
      }
      
      const chunk = await guild.members.list(options);
      if (!chunk || chunk.size === 0) {
        break;
      }

      for (const [id, member] of chunk.entries()) {
        allMembers.set(id, member);
        guild.members.cache.set(id, member);
      }

      // Collect the keys to find the last ID in lexicographical (snowflake) order
      const sortedKeys = Array.from(chunk.keys()).sort() as string[];
      lastId = sortedKeys[sortedKeys.length - 1];

      if (chunk.size < 1000) {
        break;
      }
    } catch (restErr) {
      logger.error('DiscordUtils', `Error in paginated REST member fetch: ${String(restErr)}`);
      break;
    }
  }

  if (allMembers.size > 0) {
    return allMembers;
  }
  
  return guild.members.cache;
}

/**
 * Issue d'un appel Discord attendu avec une borne de temps.
 *
 * Les trois cas sont distincts : `done` (la requête a abouti), `failed`
 * (Discord a refusé, et c'est définitif) et `pending` (pas de réponse dans le
 * délai, mais la requête suit son cours). Les confondre fait annoncer une
 * attente là où il y a un refus, ou l'inverse.
 */
export type Settled<T> = { status: 'done'; value: T } | { status: 'failed'; error: unknown } | { status: 'pending' };

/**
 * Attend un appel Discord sans s'y suspendre indéfiniment, et dit laquelle des
 * trois issues s'est produite.
 *
 * Le dépôt compte déjà trois `withTimeout` locaux, qui rejettent, rendent `null`
 * ou fabriquent un signal d'abandon : celui-ci porte un autre nom parce qu'il a
 * un autre contrat - il ne tranche rien, il rapporte.
 *
 * `@discordjs/rest` ne rejette pas sur une limite de débit : `rejectOnRateLimit`
 * n'étant pas configuré, il attend la fin de la fenêtre - jusqu'à plusieurs
 * minutes pour un renommage de salon - puis rejoue la requête. Un `.catch` ne
 * voit donc jamais ce cas : c'est l'interaction Discord, ou la requête HTTP du
 * dashboard, qui expire en premier.
 */
export async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'pending' }), timeoutMs);
  });

  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: 'done', value } as const),
        (error: unknown) => ({ status: 'failed', error } as const),
      ),
      pending,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Au-delà, mieux vaut dire que Discord temporise que faire attendre. */
export const RENAME_TIMEOUT_MS = 2_500;
