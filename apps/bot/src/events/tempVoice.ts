/**
 * Salons vocaux temporaires : création, panneau de gestion, nettoyage.
 *
 * Les règles de création viennent de `tempVoiceService` ; cet écouteur les
 * traduit en appels Discord. Deux invariants le portent :
 *
 * 1. Un salon n'est jamais plus ouvert que sa catégorie. Seule exception
 *    assumée, le mode de chat « ouvert », qui ne touche qu'à l'écriture et que
 *    `grantableBits` rattrape si la catégorie la refuse à @everyone.
 * 2. Ce que le bot annonce doit s'être produit : le résultat de chaque appel
 *    est vérifié avant la réponse.
 */
import {
  Client,
  Events,
  VoiceState,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
  OverwriteType,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  GuildMember,
  type CategoryChannel,
  type Guild as DiscordGuild,
  type RepliableInteraction,
  type VoiceChannel,
} from 'discord.js';
import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { RENAME_TIMEOUT_MS, settleWithin } from '../utils/discord.js';
import { getCachedGuild } from '../utils/cache.js';
import {
  buildCreationOverwrites,
  CHANNEL_PATCHES,
  requiredBotPermissions,
  resolveReservationRoleId,
  categoryTrustPatch,
  MAX_USER_LIMIT,
  defaultTempVoicePolicy,
  TRUST_BIT_COUNT,
  ownerPermissionPatch,
  ownerPowersFromBits,
  ownerRevokedPermissions,
  renderChannelName,
  resolveTempVoiceGenerators,
  toOverwriteDrafts,
  type TempVoiceGenerator,
  type TempVoiceGuildConfig,
  type TempVoicePolicy,
} from '../services/features/tempVoiceService.js';

/** Salons temporaires ouverts : identifiant du salon -> propriétaire courant. */
export const tempChannels = new Map<string, { creatorId: string }>();

/**
 * Sérialise les changements de propriétaire, salon par salon : deux transferts
 * simultanés liraient le même propriétaire sortant et n'en révoqueraient qu'un.
 */
const ownershipQueue = new Map<string, Promise<unknown>>();

function serializeByChannel<T>(channelId: string, task: () => Promise<T>): Promise<T> {
  const previous = ownershipQueue.get(channelId) ?? Promise.resolve();
  const next = previous.then(task, task);
  // La file ne retient que l'ordre : une erreur ne doit pas la bloquer.
  const settled = next.then(() => undefined, () => undefined);
  ownershipQueue.set(channelId, settled);
  void settled.then(() => {
    if (ownershipQueue.get(channelId) === settled) ownershipQueue.delete(channelId);
  });
  return next;
}

/** Membres pour qui une création est en cours : sans quoi entrer et sortir du
 *  générateur en rafale créerait autant de salons que d'aller-retours. */
const creationInFlight = new Set<string>();

/** Libellés des droits cités au membre, dans la langue de l'interface Discord. */
const PERMISSION_LABELS: Record<string, string> = {
  [String(PermissionFlagsBits.ManageChannels)]: 'Gérer les salons',
  [String(PermissionFlagsBits.MoveMembers)]: 'Déplacer les membres',
  [String(PermissionFlagsBits.MuteMembers)]: 'Rendre muet',
  [String(PermissionFlagsBits.DeafenMembers)]: 'Rendre sourd',
  [String(PermissionFlagsBits.ManageMessages)]: 'Gérer les messages',
  [String(PermissionFlagsBits.SendMessages)]: 'Envoyer des messages',
  [String(PermissionFlagsBits.ReadMessageHistory)]: 'Voir les anciens messages',
  [String(PermissionFlagsBits.ManageRoles)]: 'Gérer les rôles',
  [String(PermissionFlagsBits.ViewChannel)]: 'Voir le salon',
  [String(PermissionFlagsBits.Connect)]: 'Se connecter',
  [String(PermissionFlagsBits.Speak)]: 'Parler',
};

/** Droits manquants au bot : Discord refuse un salon dont une surcharge accorde
 *  un droit que le bot n'a pas lui-même, la liste suit donc les pouvoirs cochés. */
function missingBotPermissions(
  guild: DiscordGuild,
  policy: TempVoicePolicy,
  parent?: CategoryChannel,
): string[] {
  const me = guild.members.me;
  // Discord évalue les droits dans la catégorie, pas au niveau du serveur.
  // Membre bot non résolu : aucun droit ne peut être confirmé, donc tous sont
  // déclarés manquants - une vérification censée fermer la porte ne l'ouvre pas.
  const effective = me ? (parent ? parent.permissionsFor(me) : me.permissions) : null;

  return requiredBotPermissions(policy)
    .filter((permission) => !effective?.has(permission))
    .map((permission) => PERMISSION_LABELS[String(permission)] ?? String(permission));
}

/** Le staff pilote n'importe quel salon : sans cette porte, un salon renommé en
 *  insulte ne se reprend que depuis le dashboard. */
async function isStaff(guildId: string, member: GuildMember | null): Promise<boolean> {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.id === member.guild.ownerId) return true;

  const guildConfig = await getCachedGuild(guildId);
  if (!guildConfig) return false;

  return Boolean(
    (guildConfig.baseStaffRoleId && member.roles.cache.has(guildConfig.baseStaffRoleId)) ||
    (guildConfig.moderatorRoleId && member.roles.cache.has(guildConfig.moderatorRoleId)) ||
    (guildConfig.testStaffRoleId && member.roles.cache.has(guildConfig.testStaffRoleId)),
  );
}

/** Un membre du staff ne peut être ni expulsé ni banni de son propre serveur. */
async function isProtectedTarget(guildId: string, target: GuildMember): Promise<boolean> {
  if (target.id === process.env.DISCORD_CLIENT_OWNER_ID) return true;
  return isStaff(guildId, target);
}

/** Ferme un salon temporaire et oublie tout ce qui s'y rapporte. */
async function closeTempChannel(channel: VoiceChannel, reason: string): Promise<boolean> {
  // Discord d'abord : l'état n'est purgé que si la suppression a abouti, sans
  // quoi un salon refusé survivrait sans que rien ne le référence - pas même le
  // balayage, qui lit la base.
  const deleted = await channel.delete(reason).then(() => true).catch((err: unknown) => {
    logger.warn('TempVoice', `Impossible de supprimer le salon ${channel.id} :`, err);
    return false;
  });

  if (!deleted) return false;

  tempChannels.delete(channel.id);
  await prisma.tempVoiceChannel.delete({ where: { id: channel.id } }).catch(() => null);
  return true;
}

/** Salons laissés par la session précédente : un salon ne disparaît qu'au départ
 *  de son dernier occupant, ceux déjà vides resteraient donc ouverts. */
async function sweepOrphanChannels(client: Client): Promise<void> {
  const guildIds = [...client.guilds.cache.keys()];
  if (guildIds.length === 0) return;

  const stored = await prisma.tempVoiceChannel
    .findMany({ where: { guildId: { in: guildIds } } })
    .catch((err: unknown) => {
      logger.error('TempVoice', 'Erreur lors de la lecture des salons temporaires :', err);
      return [] as Array<{ id: string; creatorId: string; guildId: string }>;
    });

  let restored = 0;
  let removed = 0;

  let skipped = 0;

  for (const entry of stored) {
    const guild = client.guilds.cache.get(entry.guildId);

    // Un serveur indisponible (panne Discord) reste en cache, mais sans ses
    // salons : conclure « le salon n'existe plus » effacerait la ligne en base
    // alors que le salon, lui, existe toujours. Plus rien ne le référencerait,
    // et il ne serait jamais nettoyé.
    if (!guild || guild.available === false) {
      skipped += 1;
      continue;
    }

    const channel = guild.channels.cache.get(entry.id);

    if (!channel || channel.type !== ChannelType.GuildVoice) {
      // Le salon a été supprimé sur Discord : la ligne ne désigne plus rien.
      tempChannels.delete(entry.id);
      await prisma.tempVoiceChannel
        .delete({ where: { id: entry.id } })
        .catch((err: unknown) => logger.error('TempVoice', 'Impossible de supprimer la ligne du salon temporaire :', err));
      removed += 1;
      continue;
    }

    if (channel.members.size === 0) {
      await closeTempChannel(channel, 'Salon vocal temporaire vide au démarrage');
      removed += 1;
      continue;
    }

    tempChannels.set(entry.id, { creatorId: entry.creatorId });
    restored += 1;
  }

  logger.success(
    'TempVoice',
    `${restored} salon(s) temporaire(s) repris, ${removed} nettoyé(s) au démarrage`
      + (skipped > 0 ? `, ${skipped} laissé(s) de côté (serveur indisponible).` : '.'),
  );
}

/** Panneau de gestion posté dans le salon fraîchement créé. */
function buildControlPanel(ownerId: string) {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Gestion de votre salon vocal')
    .setDescription(
      `Bonjour <@${ownerId}> !\nVous venez de créer votre salon temporaire. Utilisez les boutons ci-dessous pour le configurer.\n\n` +
      '🔒 **Verrouiller** : Interdit l\'accès au salon\n' +
      '🔓 **Déverrouiller** : Rend l\'accès au salon à sa configuration d\'origine\n' +
      '👥 **Limite** : Modifie le nombre maximum de places\n' +
      '✏️ **Renommer** : Modifie le nom du salon\n' +
      '💬 **Chat** : Ouvre ou ferme le chat textuel du salon\n' +
      '👢 **Expulser** : Expulse un membre du salon\n' +
      '🚫 **Bannir** : Interdit le salon à un membre, chat textuel compris\n' +
      '➕ **Ajouter** : Autorise un membre à rejoindre\n' +
      '👑 **Transférer** : Transfère la propriété du salon\n' +
      '🙋 **Récupérer** : Récupère la propriété (si le propriétaire a quitté)\n' +
      '🛡️ **Réserver** : Réserve le salon pour un rôle spécifique',
    )
    .setColor('#5865F2')
    .setTimestamp();

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('tempvoice:lock').setLabel('Verrouiller').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('tempvoice:unlock').setLabel('Déverrouiller').setStyle(ButtonStyle.Success).setEmoji('🔓'),
    new ButtonBuilder().setCustomId('tempvoice:limit').setLabel('Limite').setStyle(ButtonStyle.Primary).setEmoji('👥'),
    new ButtonBuilder().setCustomId('tempvoice:rename').setLabel('Renommer').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
    new ButtonBuilder().setCustomId('tempvoice:chat').setLabel('Chat').setStyle(ButtonStyle.Secondary).setEmoji('💬'),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('tempvoice:kick').setLabel('Expulser').setStyle(ButtonStyle.Danger).setEmoji('👢'),
    new ButtonBuilder().setCustomId('tempvoice:ban').setLabel('Bannir').setStyle(ButtonStyle.Danger).setEmoji('🚫'),
    new ButtonBuilder().setCustomId('tempvoice:trust').setLabel('Ajouter').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('tempvoice:transfer').setLabel('Transférer').setStyle(ButtonStyle.Primary).setEmoji('👑'),
    new ButtonBuilder().setCustomId('tempvoice:claim').setLabel('Récupérer').setStyle(ButtonStyle.Secondary).setEmoji('🙋'),
  );

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('tempvoice:reserve').setLabel('Réserver').setStyle(ButtonStyle.Secondary).setEmoji('🛡️'),
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

/** Crée le salon d'un membre qui vient de rejoindre un générateur. */
async function createTempChannel(
  state: VoiceState,
  member: GuildMember,
  generator: TempVoiceGenerator,
): Promise<void> {
  const guild = member.guild;

  const policy = generator.policy;

  // La catégorie configurée peut avoir été supprimée ou recréée autrement :
  // sans parent, il n'y a rien à hériter.
  const parent = generator.categoryId ? guild.channels.cache.get(generator.categoryId) : undefined;
  const parentCategory = parent?.type === ChannelType.GuildCategory ? parent : undefined;

  const missing = missingBotPermissions(guild, policy, parentCategory);
  if (missing.length > 0) {
    // Sans ces droits, `channels.create` échoue et le membre reste dans le
    // générateur sans la moindre explication.
    logger.warn('TempVoice', `Droits manquants sur ${guild.name} (${guild.id}) : ${missing.join(', ')}`);
    await member
      .send(
        `❌ Le salon temporaire n'a pas pu être créé sur **${guild.name}** : il manque au bot ${missing.length > 1 ? 'les droits' : 'le droit'} « ${missing.join(' » et « ')} ».`,
      )
      .catch(() => null);
    return;
  }

  // Le générateur peut ne pas être rangé dans une catégorie, et l'identifiant
  // configuré peut pointer sur un salon supprimé ou recréé autrement : sans
  // catégorie parente, il n'y a rien à hériter.
  const inherited = parentCategory
    ? toOverwriteDrafts(parentCategory.permissionOverwrites.cache.values())
    : [];

  const tempChannel = await guild.channels
    .create({
      name: renderChannelName(generator.nameTemplate, member.displayName || member.user.username),
      type: ChannelType.GuildVoice,
      parent: generator.categoryId,
      userLimit: generator.policy.userLimit,
      permissionOverwrites: buildCreationOverwrites({
        everyoneRoleId: guild.id,
        ownerId: member.id,
        inherited,
        policy: generator.policy,
      }),
      reason: `Création de salon temporaire pour ${member.user.tag}`,
    })
    .catch((err: unknown) => {
      logger.error('TempVoice', `Impossible de créer le salon temporaire sur ${guild.id} :`, err);
      return null;
    });

  if (!tempChannel) return;

  // Le déplacement échoue si le membre a déjà quitté le vocal. La suppression
  // n'étant déclenchée que par le départ d'un occupant, un salon que personne
  // n'a rejoint ne serait jamais nettoyé.
  const moved = await state.setChannel(tempChannel).then(() => true).catch(() => false);
  if (!moved) {
    await tempChannel.delete('Déplacement vers le salon temporaire impossible').catch(() => null);
    logger.warn('TempVoice', `Déplacement impossible pour ${member.user.tag}, salon temporaire annulé.`);
    return;
  }

  tempChannels.set(tempChannel.id, { creatorId: member.id });

  await prisma.tempVoiceChannel
    .create({ data: { id: tempChannel.id, guildId: guild.id, creatorId: member.id } })
    .catch((err: unknown) => logger.error('TempVoice', "Erreur lors de l'enregistrement du salon temporaire :", err));

  await tempChannel
    .send({ content: `<@${member.id}>`, ...buildControlPanel(member.id) })
    .catch(() => null);

  logger.info('TempVoice', `Salon créé : ${tempChannel.name} (${tempChannel.id})`);
}

export function registerTempVoiceListener(client: Client): void {
  // Le balayage a besoin du cache des salons, donc d'un client prêt. Les
  // serveurs arrivent avec l'événement `ClientReady`, pas avant.
  const scheduleSweep = () => {
    void sweepOrphanChannels(client).catch((err: unknown) => {
      logger.error('TempVoice', 'Erreur lors du balayage des salons temporaires :', err);
    });
  };

  if (client.isReady()) scheduleSweep();
  else client.once(Events.ClientReady, scheduleSweep);

  client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
    const { member, guild } = newState;
    if (!member || member.user.bot) return;

    try {
      const guildConfig = await getCachedGuild(guild.id);
      if (!guildConfig || !guildConfig.tempVoiceEnabled) return;

      // 1. Création : le membre vient de rejoindre un générateur.
      if (newState.channelId) {
        const generators = resolveTempVoiceGenerators(guildConfig as unknown as TempVoiceGuildConfig, guild.id);
        const generator = generators.find((entry) => entry.channelId === newState.channelId);

        if (generator) {
          if (generator.requiredRoleId && !member.roles.cache.has(generator.requiredRoleId)) {
            await newState.disconnect('Accès au salon générateur restreint').catch(() => null);
            await member
              .send(`❌ Vous n'avez pas le rôle requis pour utiliser le salon générateur de salons temporaires sur le serveur **${guild.name}**.`)
              .catch(() => null);
            return;
          }

          const inFlightKey = `${guild.id}:${member.id}`;
          if (creationInFlight.has(inFlightKey)) return;
          creationInFlight.add(inFlightKey);
          try {
            await createTempChannel(newState, member, generator);
          } finally {
            creationInFlight.delete(inFlightKey);
          }
        }
      }

      // 2. Suppression : le dernier occupant vient de partir.
      if (oldState.channelId && oldState.channelId !== newState.channelId) {
        const oldChannel = oldState.channel;
        if (
          oldChannel &&
          oldChannel.type === ChannelType.GuildVoice &&
          tempChannels.has(oldChannel.id) &&
          oldChannel.members.size === 0
        ) {
          const closed = await closeTempChannel(oldChannel, 'Salon vocal temporaire vide');
          if (closed) {
            logger.info('TempVoice', `Salon supprimé car vide : ${oldChannel.name} (${oldChannel.id})`);
          }
        }
      }
    } catch (err) {
      logger.error('TempVoice', 'Erreur lors de la gestion voiceStateUpdate :', err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.guildId) return;
    if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isRoleSelectMenu() && !interaction.isUserSelectMenu()) return;
    if (!interaction.customId.startsWith('tempvoice:')) return;

    const { channel, user, guild, guildId } = interaction;
    if (!guild || !channel || channel.type !== ChannelType.GuildVoice) return;

    const cache = tempChannels.get(channel.id);
    if (!cache) {
      await interaction
        .reply({ content: "❌ Ce salon n'est plus enregistré comme temporaire.", flags: [MessageFlags.Ephemeral] })
        .catch(() => null);
      return;
    }

    const action = interaction.customId.split(':')[1] ?? '';
    const actingMember = interaction.member instanceof GuildMember
      ? interaction.member
      : await guild.members.fetch(user.id).catch(() => null);

    // `claim` est la seule action ouverte à autrui : c'est elle qui rend un
    // salon dont le propriétaire est parti.
    if (action !== 'claim' && cache.creatorId !== user.id && !(await isStaff(guildId, actingMember))) {
      await interaction
        .reply({ content: '❌ Seul le propriétaire du salon peut effectuer cette action.', flags: [MessageFlags.Ephemeral] })
        .catch(() => null);
      return;
    }

    try {
      await handleTempVoiceAction({ interaction, action, channel, cache, guild, guildId, actingMember });
    } catch (err) {
      logger.error('TempVoice', `Erreur lors de l'action « ${action} » :`, err);
      const message = { content: "❌ L'action n'a pas pu être appliquée.", flags: [MessageFlags.Ephemeral] as const };
      await (interaction.isRepliable() && (interaction.replied || interaction.deferred)
        ? interaction.followUp(message).catch(() => null)
        : interaction.reply(message).catch(() => null));
    }
  });

  logger.success('TempVoice', 'Écouteur Vocal Temporaire enregistré');
}

/**
 * Discord ferme une interaction non acquittée au bout de trois secondes : toute
 * action qui touche Discord ou la base passe par ici avant son premier appel.
 *
 * `showModal` et les réponses à composants font exception, l'API les exigeant
 * sur une interaction non acquittée.
 */
async function deferIfNeeded(interaction: RepliableInteraction): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => null);
}

/**
 * Répond au membre, quel que soit l'état de l'interaction. Les réponses du
 * panneau sont toutes privées ; ce que le salon doit voir passe par `send`.
 */
async function respond(interaction: RepliableInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content }).catch(() => null);
    return;
  }
  await interaction.reply({ content, flags: [MessageFlags.Ephemeral] }).catch(() => null);
}

interface ActionContext {
  interaction: RepliableInteraction & { customId: string };
  action: string;
  channel: VoiceChannel;
  cache: { creatorId: string };
  guild: DiscordGuild;
  guildId: string;
  actingMember: GuildMember | null;
}

/** Ouvre une fenêtre de saisie à une seule ligne. */
function textModal(customId: string, title: string, label: string, placeholder: string, maxLength: number) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(placeholder)
          .setMaxLength(maxLength)
          .setRequired(true),
      ),
    );
}

/** Choisit un membre dans une liste plutôt que de le chercher par son pseudo. */
function userPicker(customId: string, placeholder: string) {
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1),
  );
}

async function handleTempVoiceAction(ctx: ActionContext): Promise<void> {
  const { interaction, action, channel, cache, guild, guildId } = ctx;
  const user = interaction.user;

  const ephemeral = { flags: [MessageFlags.Ephemeral] as const };
  const reply = (content: string) => respond(interaction, content);

  // ==========================================================================
  // BOUTONS QUI AGISSENT DIRECTEMENT
  // ==========================================================================
  if (interaction.isButton()) {
    // `showModal` et les réponses à composants exigent une interaction non
    // acquittée ; les autres touchent Discord avant de répondre.
    const ACKNOWLEDGE_FIRST = new Set(['lock', 'unlock', 'chat', 'claim']);
    if (ACKNOWLEDGE_FIRST.has(action)) await deferIfNeeded(interaction);

    switch (action) {
      case 'lock': {
        await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.lock);
        await reply('🔒 Le salon a été verrouillé : seuls vous, les rôles autorisés d\'office et les membres que vous avez ajoutés peuvent encore le rejoindre.');
        return;
      }

      case 'unlock': {
        await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.unlock);
        await reply("🔓 Le salon a été déverrouillé : il retrouve l'accès prévu par sa catégorie.");
        return;
      }

      case 'chat': {
        // L'état courant décide du sens de la bascule. Il faut le relire :
        // `PermissionOverwriteManager.upsert` ne met pas `permissionOverwrites`
        // à jour, seul `CHANNEL_UPDATE` le fait.
        await guild.channels.fetch(channel.id, { force: true }).catch(() => null);

        const everyoneOverwrite = channel.permissionOverwrites.cache.get(guildId);
        const chatIsOpen = !everyoneOverwrite?.deny.has(PermissionFlagsBits.SendMessages);

        if (chatIsOpen) {
          await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.closeChat);
          // Le propriétaire porte « Envoyer des messages » depuis la création :
          // fermer le chat à @everyone ne le rend pas muet chez lui.
          await reply("💬 Le chat textuel du salon est fermé : seuls vous et les membres autorisés peuvent y écrire.");
        } else {
          await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.openChat);
          await reply("💬 Le chat textuel du salon retrouve l'accès prévu par sa catégorie.");
        }
        return;
      }

      case 'claim': {
        if (channel.members.has(cache.creatorId)) {
          await reply('❌ Le propriétaire actuel du salon vocal est toujours présent.');
          return;
        }
        // On ne reprend que le salon où l'on se trouve : le panneau reste
        // lisible depuis l'extérieur.
        if (!channel.members.has(user.id)) {
          await reply("❌ Rejoignez le salon vocal avant d'en récupérer la propriété.");
          return;
        }
        if (!ctx.actingMember) {
          await reply("❌ Votre profil sur ce serveur n'a pas pu être lu : réessayez dans un instant.");
          return;
        }
        await transferOwnership(ctx, ctx.actingMember, 'claim');
        return;
      }

      case 'limit': {
        await interaction.showModal(
          textModal(
            'tempvoice:limit_modal',
            "👥 Limite d'utilisateurs",
            `Nombre max (0 pour illimité, max ${MAX_USER_LIMIT})`,
            'Ex: 5',
            2,
          ),
        );
        return;
      }

      case 'rename': {
        await interaction.showModal(
          textModal('tempvoice:rename_modal', '✏️ Renommer le salon', 'Nouveau nom du salon', 'Ex: Blabla Gaming', 50),
        );
        return;
      }

      case 'kick':
      case 'ban':
      case 'trust':
      case 'transfer': {
        // Un sélecteur plutôt qu'une saisie : chercher par pseudo prend le
        // premier résultat, donc parfois le mauvais membre.
        const labels: Record<string, string> = {
          kick: '👢 Sélectionnez le membre à expulser du salon.',
          ban: '🚫 Sélectionnez le membre à bannir du salon.',
          trust: '➕ Sélectionnez le membre à autoriser.',
          transfer: '👑 Sélectionnez le nouveau propriétaire du salon.',
        };
        await interaction.reply({
          content: labels[action] ?? 'Sélectionnez un membre.',
          components: [userPicker(`tempvoice:${action}_select`, 'Choisissez un membre')],
          ...ephemeral,
        });
        return;
      }

      case 'reserve': {
        await interaction.reply({
          content: '🛡️ **Réserver le salon pour un rôle** :\nSélectionnez le rôle qui sera autorisé à rejoindre votre salon vocal. Ne sélectionnez rien pour réinitialiser.',
          components: [
            new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
              new RoleSelectMenuBuilder()
                .setCustomId('tempvoice:reserve_select')
                .setPlaceholder('Sélectionnez un rôle pour réserver le salon')
                .setMinValues(0)
                .setMaxValues(1),
            ),
          ],
          ...ephemeral,
        });
        return;
      }

      default:
        return;
    }
  }

  // ==========================================================================
  // RÉSERVATION PAR RÔLE
  // ==========================================================================
  if (interaction.isRoleSelectMenu() && action === 'reserve_select') {
    // Une lecture en base, trois à quatre surcharges et une écriture précédent
    // la réponse.
    await deferIfNeeded(interaction);

    // Le menu de Discord ne propose pas @everyone, mais la valeur reçue reste
    // une donnée du client : elle est vérifiée comme celle de la route.
    const chosen = interaction.values[0] ?? null;
    const selectedRoleId = chosen
      ? resolveReservationRoleId(chosen, guildId, new Set(guild.roles.cache.keys()))
      : null;

    if (chosen && !selectedRoleId) {
      await reply('❌ Ce rôle ne peut pas être utilisé pour réserver le salon.');
      return;
    }
    const stored = await prisma.tempVoiceChannel.findUnique({ where: { id: channel.id } }).catch(() => null);

    /** Ce que la catégorie laisse réellement accorder à un rôle. */
    const grantForRole = (id: string): Record<string, true> | null =>
      categoryTrustPatch(channel, guild.roles.cache.get(id) ?? null);

    // Réserver accorde, donc la catégorie fait foi ici aussi : sans cette
    // confrontation, une réservation ouvrirait à un rôle que la catégorie
    // refuse - le même travers que « Ajouter ». Le refus est constaté avant
    // toute écriture, sans quoi le verrou resterait pose sur un salon que plus
    // personne ne peut rejoindre.
    const rolePatch = selectedRoleId ? grantForRole(selectedRoleId) : null;
    if (selectedRoleId && !rolePatch) {
      await reply("❌ La catégorie du salon refuse l'accès à ce rôle : réservation impossible.");
      return;
    }

    // Sans ce retrait, le salon porte au bout de quelques changements la liste
    // de tous les rôles réservés depuis sa création. Le retrait peut échouer, et
    // le membre doit l'apprendre plutôt que de lire une exclusivité fausse.
    let previousCleared = true;
    if (stored?.roleId && stored.roleId !== selectedRoleId) {
      previousCleared = await channel.permissionOverwrites
        .delete(stored.roleId, 'Réservation précédente levée')
        .then(() => true)
        .catch((err: unknown) => {
          logger.warn('TempVoice', `Impossible de lever la réservation précédente sur ${channel.id} :`, err);
          return false;
        });
    }

    if (selectedRoleId && rolePatch) {
      // Le propriétaire n'est pas toujours en cache : un salon se réserve depuis
      // le panneau alors qu'il l'a déjà quitté.
      const owner = guild.members.cache.get(cache.creatorId)
        ?? await guild.members.fetch(cache.creatorId).catch(() => null);
      const ownerPatch = categoryTrustPatch(channel, owner);

      // Les autorisations d'abord, le verrou ensuite : dans l'ordre inverse, un
      // appel refusé entre les deux laisse un salon fermé à tout le monde et
      // sans réservation, que rien ne vient rouvrir.
      if (ownerPatch && owner) await channel.permissionOverwrites.edit(owner, ownerPatch);
      await channel.permissionOverwrites.edit(selectedRoleId, rolePatch);
      await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.lock);

      const saved = await prisma.tempVoiceChannel
        .update({ where: { id: channel.id }, data: { roleId: selectedRoleId } })
        .then(() => true)
        .catch((err: unknown) => {
          logger.error('TempVoice', "Erreur lors de l'enregistrement de la réservation :", err);
          return false;
        });

      // Sans la ligne en base, le prochain changement ne saura pas quelle
      // surcharge lever : elles s'accumuleraient sans que personne ne le voie.
      await reply(previousCleared && saved
        ? `🛡️ Le salon est réservé au rôle <@&${selectedRoleId}>. Seuls ses membres, les membres que vous avez ajoutés et vous pouvez le rejoindre.`
        : `🛡️ Le salon est réservé au rôle <@&${selectedRoleId}>, mais la réservation précédente n'a pas pu être entièrement levée : signalez-le au staff.`);
      return;
    }

    await channel.permissionOverwrites.edit(guildId, CHANNEL_PATCHES.clearReservation);
    await prisma.tempVoiceChannel
      .update({ where: { id: channel.id }, data: { roleId: null } })
      .catch((err: unknown) => logger.error('TempVoice', "Erreur lors de l'enregistrement de la réservation :", err));
    await reply(previousCleared
      ? "🔓 Réservation annulée : le salon retrouve l'accès prévu par sa catégorie."
      : "🔓 Réservation annulée, mais la surcharge du rôle précédent n'a pas pu être retirée : il garde l'accès.");
    return;
  }

  // ==========================================================================
  // ACTIONS VISANT UN MEMBRE
  // ==========================================================================
  if (interaction.isUserSelectMenu()) {
    // Jusqu'à cinq appels réseau suivent avant la réponse (recherche du membre,
    // surcharges, écriture en base) : sans acquittement, l'interaction expire.
    await deferIfNeeded(interaction);

    const targetId = interaction.values[0];
    if (!targetId) {
      await reply('❌ Aucun membre sélectionné.');
      return;
    }

    const target = await guild.members.fetch(targetId).catch(() => null);
    if (!target) {
      await reply('❌ Membre introuvable sur le serveur.');
      return;
    }

    // Le bot doit garder l'accès au salon : banni, il ne pourrait plus le
    // supprimer quand il se vide, et le salon resterait ouvert indéfiniment.
    if (target.user.bot) {
      await reply('❌ Un bot ne peut pas être ciblé par cette action.');
      return;
    }

    // Le propriétaire est protégé de ses propres invités, pas du staff : le
    // salon renommé en insulte est précisément le cas où la modération doit
    // pouvoir agir sur lui.
    const actingAsStaff = await isStaff(guildId, ctx.actingMember);
    if (target.id === cache.creatorId && !actingAsStaff) {
      await reply('❌ Le propriétaire du salon ne peut pas être ciblé.');
      return;
    }

    switch (action) {
      case 'transfer_select': {
        await transferOwnership(ctx, target, 'transfer');
        return;
      }

      case 'trust_select': {
        // On lit les droits *effectifs* de la cible : une catégorie restreinte
        // se configure par un refus à @everyone et une autorisation à un rôle,
        // que personne ne porte nommément.
        // Catégorie configurée mais introuvable : le dire, plutôt que de laisser
        // le refus générique ci-dessous parler d'un accès refusé.
        if (channel.parentId && !channel.parent) {
          await reply("❌ La catégorie du salon est introuvable : impossible de vérifier l'accès.");
          return;
        }

        const patch = categoryTrustPatch(channel, target);
        if (!patch) {
          await reply(`❌ La catégorie du salon refuse l'accès à **${target.displayName}**.`);
          return;
        }

        await channel.permissionOverwrites.edit(target.id, patch);

        // Un patch partiel n'est pas un accès : le dire plutôt que d'annoncer
        // une réussite que la catégorie contredit.
        const fullAccess = Object.keys(patch).length === TRUST_BIT_COUNT;
        await reply(fullAccess
          ? `➕ **${target.displayName}** a été autorisé à rejoindre le salon.`
          : `⚠️ **${target.displayName}** n'a reçu qu'un accès partiel : la catégorie lui refuse le reste.`);
        return;
      }

      case 'kick_select': {
        if (await isProtectedTarget(guildId, target)) {
          await reply('❌ Vous ne pouvez pas exclure un membre du staff.');
          return;
        }
        if (target.voice.channelId !== channel.id) {
          await reply("❌ Ce membre n'est pas dans votre salon vocal.");
          return;
        }
        await target.voice.disconnect('Expulsé du salon vocal temporaire par le propriétaire.');
        await reply(`👢 **${target.displayName}** a été expulsé du salon vocal.`);
        return;
      }

      case 'ban_select': {
        if (await isProtectedTarget(guildId, target)) {
          await reply('❌ Vous ne pouvez pas bannir un membre du staff.');
          return;
        }
        await channel.permissionOverwrites.edit(target.id, CHANNEL_PATCHES.ban);
        if (target.voice.channelId === channel.id) {
          await target.voice.disconnect('Banni du salon vocal temporaire par le propriétaire.').catch(() => null);
        }
        await reply(`🚫 **${target.displayName}** a été banni du salon, chat textuel compris.`);
        return;
      }

      default:
        return;
    }
  }

  // ==========================================================================
  // SAISIES
  // ==========================================================================
  if (interaction.isModalSubmit()) {
    await deferIfNeeded(interaction);

    const value = interaction.fields.getTextInputValue('value').trim();

    if (action === 'limit_modal') {
      // La borne est celle de la politique : l'écrire ici la figerait au jour
      // où elle a été écrite, comme le nombre de droits d'un accès complet.
      const limit = Number.parseInt(value, 10);
      if (!Number.isFinite(limit) || limit < 0 || limit > MAX_USER_LIMIT) {
        await reply(`❌ Nombre invalide (doit être entre 0 et ${MAX_USER_LIMIT}).`);
        return;
      }
      await channel.setUserLimit(limit);
      await reply(limit === 0 ? '👥 Limite de places retirée.' : `👥 Limite fixée à ${limit} membres.`);
      return;
    }

    if (action === 'rename_modal') {
      if (!value) {
        await reply('❌ Le nom ne peut pas être vide.');
        return;
      }

      // Discord n'accepte que deux renommages par tranche de dix minutes, et
      // `@discordjs/rest` ne rejette pas au-delà : il attend la fin de la
      // fenêtre puis rejoue la requête. Un `.catch` ne voit donc jamais ce cas.
      // On borne l'attente pour pouvoir répondre - la requête, elle, suit son
      // cours, d'où la formulation : « pas confirmé », et non « échoue ».
      const newName = value.slice(0, 100);
      const renamed = await settleWithin(channel.setName(newName), RENAME_TIMEOUT_MS);

      if (renamed.status === 'failed') {
        // Un vrai refus : nom invalide, salon disparu, droits perdus. Annoncer
        // une attente serait faux - il ne s'appliquera jamais.
        logger.warn('TempVoice', `Impossible de renommer le salon ${channel.id} :`, renamed.error);
        await reply('❌ Discord a refusé ce nom.');
        return;
      }

      await reply(
        renamed.status === 'done'
          ? `✏️ Salon renommé en : **${newName}**`
          : "⏳ Discord n'a pas confirmé le renommage : un salon ne peut changer de nom que deux fois par tranche de dix minutes. Le nouveau nom s'appliquera peut-être d'ici quelques minutes.",
      );
      return;
    }
  }
}

/** Passe la propriété d'un salon : le nouveau est écrit en base, sans quoi un
 *  redémarrage rendrait le salon à son créateur d'origine. */
function transferOwnership(
  ctx: ActionContext,
  target: GuildMember | null,
  kind: 'claim' | 'transfer',
): Promise<void> {
  return serializeByChannel(ctx.channel.id, () => applyOwnershipTransfer(ctx, target, kind));
}

async function applyOwnershipTransfer(
  ctx: ActionContext,
  target: GuildMember | null,
  kind: 'claim' | 'transfer',
): Promise<void> {
  const { interaction, channel, cache, guild, guildId } = ctx;
  if (!target) return;

  // La garde de « Récupérer » a été évaluée avant la mise en file : deux
  // réclamations simultanées la passent toutes les deux. Elle est revue ici.
  if (kind === 'claim' && channel.members.has(cache.creatorId)) {
    await respond(interaction, '❌ Le propriétaire actuel du salon vocal est toujours présent.');
    return;
  }

  // Relu ici, et non avant la mise en file : un transfert précédent a pu changer
  // le propriétaire pendant l'attente.
  const previousOwnerId = cache.creatorId;

  // Les pouvoirs suivent le salon, pas la configuration courante : la politique
  // du générateur a pu changer depuis, ou le générateur disparaître.
  //
  // Le salon est relu avant : une surcharge que nous venons d'écrire n'est pas
  // dans le cache, `PermissionOverwriteManager.upsert` n'y touchant pas. Deux
  // transferts qui se suivent liraient sinon une absence, et le nouveau
  // propriétaire recevrait la politique du générateur au lieu des pouvoirs que
  // le salon portait réellement.
  await guild.channels.fetch(channel.id, { force: true }).catch(() => null);

  const previousOverwrite = channel.permissionOverwrites.cache.get(previousOwnerId);
  let powers = previousOverwrite ? ownerPowersFromBits(previousOverwrite.allow.bitfield) : [];

  if (!previousOverwrite) {
    // Repli quand la surcharge a été effacée à la main : seul le générateur
    // principal fait autorité, sinon la politique par défaut. Un additionnel ne
    // régit que ses propres salons.
    const guildConfig = await getCachedGuild(guildId);
    const generators = guildConfig
      ? resolveTempVoiceGenerators(guildConfig as unknown as TempVoiceGuildConfig, guildId)
      : [];
    const mainGenerator = generators.find((entry) => entry.primary);
    powers = mainGenerator?.policy.ownerPowers ?? defaultTempVoicePolicy().ownerPowers;
  }

  // La catégorie fait foi ici aussi : sans cette confrontation, recevoir un
  // salon rendait à la cible les droits que la catégorie lui refuse nommément -
  // « Parler » compris, alors que c'est une sanction posée par le staff.
  const grantable = channel.parentId && !channel.parent
    ? 0n
    : channel.parent
      ? channel.parent.permissionsFor(target)?.bitfield ?? 0n
      : null;

  await channel.permissionOverwrites.edit(target.id, ownerPermissionPatch(powers, grantable));

  if (previousOwnerId !== target.id) {
    // Type explicite : sans lui, `upsert` cherche la cible dans `roles.cache`
    // puis `users.cache` et lève avant tout appel réseau si aucun ne la connaît.
    // Un ancien propriétaire hors cache garderait ses pouvoirs.
    await channel.permissionOverwrites
      .edit(previousOwnerId, ownerRevokedPermissions(), { type: OverwriteType.Member })
      .catch((err: unknown) => logger.warn('TempVoice', `Impossible de retirer les pouvoirs de l'ancien propriétaire sur ${channel.id} :`, err));
  }

  cache.creatorId = target.id;
  await prisma.tempVoiceChannel
    .update({ where: { id: channel.id }, data: { creatorId: target.id } })
    .catch((err: unknown) => logger.error('TempVoice', "Erreur lors de l'enregistrement du propriétaire :", err));

  const message = kind === 'claim'
    ? `👑 **${target.displayName}** a récupéré la propriété du salon vocal !`
    : `👑 La propriété du salon a été transférée à **${target.displayName}**.`;

  await respond(interaction, message);

  // « Récupérer » est ouvert à tous : la réponse reste privée pour qu'un refus
  // ne s'affiche pas devant le salon, la reprise est annoncée dans le salon.
  if (kind === 'claim') {
    await channel.send({ content: message }).catch(() => null);
  }
}
