/**
 * Règles de création des salons vocaux temporaires.
 *
 * Une politique par générateur, normalisée ici et nulle part ailleurs. Les
 * fonctions sont pures pour que le calcul des surcharges se vérifie sans client
 * Discord, et la politique par défaut laisse les serveurs configurés inchangés.
 */
import { OverwriteType, PermissionFlagsBits, type OverwriteResolvable } from 'discord.js';

/** Pouvoir accordé au propriétaire sur son salon, au-delà d'y parler. */
export type TempVoiceOwnerPower = 'mute' | 'deafen' | 'move' | 'manageChannel' | 'manageMessages';

/**
 * Sort du chat texte intégré au salon vocal.
 *
 * `inherit` ne pose rien, `locked` refuse l'écriture à @everyone, `open` la lui
 * autorise - seule autorisation explicite du module, assumée, et que
 * `grantableBits` empêche de dépasser un refus de la catégorie.
 */
export type TempVoiceTextChatMode = 'inherit' | 'open' | 'locked';

export const TEMP_VOICE_OWNER_POWERS: readonly TempVoiceOwnerPower[] = [
  'mute',
  'deafen',
  'move',
  'manageChannel',
  'manageMessages',
] as const;

export const TEMP_VOICE_TEXT_CHAT_MODES: readonly TempVoiceTextChatMode[] = [
  'inherit',
  'open',
  'locked',
] as const;

/** Les trois pouvoirs historiques, retenus quand rien n'est configuré. */
export const LEGACY_OWNER_POWERS: readonly TempVoiceOwnerPower[] = ['mute', 'deafen', 'move'] as const;

/** Un salon Discord n'accepte pas plus de 99 places. */
export const MAX_USER_LIMIT = 99;

/** Au-delà, la liste des rôles autorisés d'office n'est plus lisible en page. */
export const MAX_AUTO_ALLOW_ROLES = 10;

export interface TempVoicePolicy {
  /** Places du salon à la création ; 0 laisse le salon sans limite. */
  userLimit: number;
  /** Crée le salon verrouillé : seuls le propriétaire et les rôles autorisés entrent. */
  lockOnCreate: boolean;
  /** Rôles qui reçoivent l'accès sans que le propriétaire ait à les ajouter. */
  autoAllowRoleIds: string[];
  textChat: TempVoiceTextChatMode;
  ownerPowers: TempVoiceOwnerPower[];
}

export interface TempVoiceGenerator {
  channelId: string;
  categoryId?: string;
  nameTemplate: string;
  requiredRoleId?: string;
  policy: TempVoicePolicy;
  /** Générateur porté par les colonnes à plat : un serveur peut n'avoir que des
   *  additionnels, donc `generators[0]` n'est pas forcément le principal. */
  primary: boolean;
}

/** Forme stockée d'un générateur additionnel, telle qu'elle vit dans le JSON. */
export interface StoredTempVoiceGenerator {
  channelId: string;
  categoryId?: string;
  nameTemplate?: string;
  requiredRoleId?: string | null;
  userLimit?: number;
  lockOnCreate?: boolean;
  autoAllowRoleIds?: string[];
  textChat?: TempVoiceTextChatMode;
  ownerPowers?: TempVoiceOwnerPower[];
}

export const DEFAULT_NAME_TEMPLATE = '🔊 Salon de {user}';

/**
 * Politique d'un serveur qui n'a rien configuré : le comportement d'avant ce
 * panneau, pour que les serveurs déjà en place ne bougent pas.
 */
export function defaultTempVoicePolicy(): TempVoicePolicy {
  return {
    userLimit: 0,
    lockOnCreate: false,
    autoAllowRoleIds: [],
    textChat: 'inherit',
    ownerPowers: [...LEGACY_OWNER_POWERS],
  };
}

function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

/** Identifiants de rôle plausibles, dédoublonnés et plafonnés. `everyoneRoleId`
 *  est écarté : il passe la validation de format, et l'autoriser d'office
 *  viderait le verrouillage de son sens. */
function normalizeRoleIds(value: unknown, max: number, everyoneRoleId?: string): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter(isSnowflake).filter((id) => id !== everyoneRoleId);
  return [...new Set(ids)].slice(0, max);
}

function normalizeUserLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(Math.trunc(parsed), 0), MAX_USER_LIMIT);
}

function normalizeOwnerPowers(value: unknown): TempVoiceOwnerPower[] {
  // `undefined` n'est pas « aucun pouvoir », c'est « rien n'a été dit » : le
  // champ absent rend les pouvoirs historiques, la liste vide n'en rend aucun.
  if (!Array.isArray(value)) return [...LEGACY_OWNER_POWERS];
  return TEMP_VOICE_OWNER_POWERS.filter((power) => value.includes(power));
}

function normalizeTextChat(value: unknown): TempVoiceTextChatMode {
  return TEMP_VOICE_TEXT_CHAT_MODES.includes(value as TempVoiceTextChatMode)
    ? (value as TempVoiceTextChatMode)
    : 'inherit';
}

/** Ramène une valeur de la base ou du dashboard à une politique complète :
 *  personne d'autre ne valide ce JSON. */
export function normalizeTempVoicePolicy(raw: unknown, everyoneRoleId?: string): TempVoicePolicy {
  if (!raw || typeof raw !== 'object') return defaultTempVoicePolicy();
  const source = raw as Record<string, unknown>;

  return {
    userLimit: normalizeUserLimit(source.userLimit),
    lockOnCreate: source.lockOnCreate === true,
    autoAllowRoleIds: normalizeRoleIds(source.autoAllowRoleIds, MAX_AUTO_ALLOW_ROLES, everyoneRoleId),
    textChat: normalizeTextChat(source.textChat),
    ownerPowers: normalizeOwnerPowers(source.ownerPowers),
  };
}

/** Nombre maximum de générateurs additionnels acceptés pour un serveur. */
export const MAX_ADDITIONAL_GENERATORS = 25;

/** Valide les générateurs additionnels reçus : une entrée sans salon est
 *  écartée, elle ne déclencherait jamais rien. */
export function normalizeTempVoiceGeneratorsInput(
  raw: unknown,
  everyoneRoleId?: string,
  mainChannelId?: string | null,
): StoredTempVoiceGenerator[] {
  if (!Array.isArray(raw)) return [];

  const normalized: StoredTempVoiceGenerator[] = [];
  // Le générateur principal occupe déjà son salon : un additionnel posé dessus
  // ne serait jamais atteint, la résolution le plaçant en tête.
  const seen = new Set<string>(mainChannelId ? [mainChannelId] : []);

  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (!isSnowflake(entry.channelId)) continue;
    // Deux générateurs sur le même salon : le second ne serait jamais atteint,
    // la recherche s'arrêtant au premier.
    if (seen.has(entry.channelId)) continue;
    seen.add(entry.channelId);

    const policy = normalizeTempVoicePolicy(entry, everyoneRoleId);
    const nameTemplate = typeof entry.nameTemplate === 'string' && entry.nameTemplate.trim()
      ? entry.nameTemplate.trim().slice(0, 100)
      : DEFAULT_NAME_TEMPLATE;

    normalized.push({
      channelId: entry.channelId,
      ...(isSnowflake(entry.categoryId) ? { categoryId: entry.categoryId } : {}),
      nameTemplate,
      requiredRoleId: isSnowflake(entry.requiredRoleId) ? entry.requiredRoleId : null,
      userLimit: policy.userLimit,
      lockOnCreate: policy.lockOnCreate,
      autoAllowRoleIds: policy.autoAllowRoleIds,
      textChat: policy.textChat,
      ownerPowers: policy.ownerPowers,
    });

    if (normalized.length >= MAX_ADDITIONAL_GENERATORS) break;
  }

  return normalized;
}

/** Colonnes du serveur que la résolution des générateurs consulte. */
export interface TempVoiceGuildConfig {
  tempVoiceEnabled: boolean;
  tempVoiceChannelId: string | null;
  tempVoiceCategoryId: string | null;
  tempVoiceNameTemplate: string;
  tempVoiceRequiredRoleId?: string | null;
  tempVoiceDefaults?: unknown;
  tempVoiceGenerators?: unknown;
}

/**
 * Générateurs actifs d'un serveur, politique résolue.
 *
 * Le principal vit dans des colonnes à plat et les suivants dans un JSON : la
 * différence s'arrête ici. `everyoneRoleId` descend jusqu'à la normalisation,
 * une base écrite à la main pouvant en contenir.
 */
export function resolveTempVoiceGenerators(
  guildConfig: TempVoiceGuildConfig,
  everyoneRoleId?: string,
): TempVoiceGenerator[] {
  const generators: TempVoiceGenerator[] = [];

  if (guildConfig.tempVoiceChannelId) {
    generators.push({
      channelId: guildConfig.tempVoiceChannelId,
      categoryId: guildConfig.tempVoiceCategoryId || undefined,
      nameTemplate: guildConfig.tempVoiceNameTemplate || DEFAULT_NAME_TEMPLATE,
      requiredRoleId: guildConfig.tempVoiceRequiredRoleId || undefined,
      policy: normalizeTempVoicePolicy(guildConfig.tempVoiceDefaults, everyoneRoleId),
      primary: true,
    });
  }

  if (Array.isArray(guildConfig.tempVoiceGenerators)) {
    for (const value of guildConfig.tempVoiceGenerators) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.channelId !== 'string') continue;

      generators.push({
        channelId: entry.channelId,
        categoryId: typeof entry.categoryId === 'string' ? entry.categoryId : undefined,
        nameTemplate: typeof entry.nameTemplate === 'string' ? entry.nameTemplate : DEFAULT_NAME_TEMPLATE,
        requiredRoleId: typeof entry.requiredRoleId === 'string' ? entry.requiredRoleId : undefined,
        policy: normalizeTempVoicePolicy(entry, everyoneRoleId),
        primary: false,
      });
    }
  }

  return generators;
}

const OWNER_POWER_BITS: Record<TempVoiceOwnerPower, bigint> = {
  mute: PermissionFlagsBits.MuteMembers,
  deafen: PermissionFlagsBits.DeafenMembers,
  move: PermissionFlagsBits.MoveMembers,
  manageChannel: PermissionFlagsBits.ManageChannels,
  manageMessages: PermissionFlagsBits.ManageMessages,
};

/**
 * Droits posés sur le propriétaire d'un salon.
 *
 * Le chat textuel suit l'accès : verrouiller ferme l'écriture à @everyone, donc le
 * propriétaire porte toujours l'écriture et la lecture, sans quoi « Verrouiller »
 * le rendrait muet chez lui. `grantableBits` confronte ces bits à la catégorie.
 */
export function ownerAllowBits(policy: TempVoicePolicy): bigint[] {
  const bits = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  for (const power of policy.ownerPowers) bits.push(OWNER_POWER_BITS[power]);

  return bits;
}

/**
 * Droits que le bot doit posséder pour appliquer cette politique.
 *
 * Discord refuse un salon dont une surcharge accorde un droit que le bot n'a pas
 * lui-même : la liste suit les pouvoirs cochés, plus `ManageChannels`,
 * `MoveMembers` et `ManageRoles`, que le module emploie toujours.
 */
export function requiredBotPermissions(policy: TempVoicePolicy): bigint[] {
  return [
    ...new Set([
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.MoveMembers,
      // Toutes les écritures du module sont des surcharges de permissions, et
      // créer un salon avec des surcharges l'exige aussi.
      PermissionFlagsBits.ManageRoles,
      ...ownerAllowBits(policy),
    ]),
  ];
}

export interface OverwriteDraft {
  id: string;
  type: OverwriteType;
  allow: bigint;
  deny: bigint;
}

function toBigInt(value: bigint | number | string | { bitfield: bigint }): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'object' && value && 'bitfield' in value) return value.bitfield;
  return BigInt(value);
}

/** Ajoute des droits sans effacer ce que la surcharge portait : autoriser un bit
 *  le retire du refus, les deux champs étant exclusifs côté Discord. */
function applyBits(draft: OverwriteDraft, allow: bigint[] = [], deny: bigint[] = []): OverwriteDraft {
  let nextAllow = draft.allow;
  let nextDeny = draft.deny;

  for (const bit of allow) {
    nextAllow |= bit;
    nextDeny &= ~bit;
  }
  for (const bit of deny) {
    nextDeny |= bit;
    nextAllow &= ~bit;
  }

  return { ...draft, allow: nextAllow, deny: nextDeny };
}

/**
 * Bits réellement accordables à un identifiant.
 *
 * Un refus porté par @everyone reste dépassable - c'est ainsi que le
 * propriétaire entre dans son propre salon sur un serveur fermé. Un refus posé
 * sur la *même* cible, lui, gagne toujours.
 */
function grantableBits(allow: bigint[], inheritedDeny: bigint): bigint[] {
  return allow.filter((bit) => (inheritedDeny & bit) !== bit);
}

export interface BuildCreationOverwritesInput {
  /** Identifiant du rôle @everyone, qui vaut celui du serveur. */
  everyoneRoleId: string;
  ownerId: string;
  /** Surcharges recopiées de la catégorie parente, vides si elle n'existe pas. */
  inherited: OverwriteDraft[];
  policy: TempVoicePolicy;
}

/**
 * Surcharges posées à la création d'un salon temporaire.
 *
 * On part de ce que porte la catégorie et la politique s'empile par-dessus, bit
 * à bit, sans jamais remplacer une surcharge entière : sur un serveur fermé, un
 * salon rouvert à @everyone serait le seul où entrer sans vérification.
 */
export function buildCreationOverwrites(input: BuildCreationOverwritesInput): OverwriteResolvable[] {
  const { everyoneRoleId, ownerId, inherited, policy } = input;

  const drafts = new Map<string, OverwriteDraft>();
  for (const overwrite of inherited) {
    drafts.set(overwrite.id, { ...overwrite });
  }

  const ensure = (id: string, type: OverwriteType): OverwriteDraft => {
    const existing = drafts.get(id);
    if (existing) return existing;
    const created: OverwriteDraft = { id, type, allow: 0n, deny: 0n };
    drafts.set(id, created);
    return created;
  };

  /** Ce que la catégorie refuse nommément à un identifiant. */
  const inheritedDenyFor = (id: string): bigint =>
    inherited.find((overwrite) => overwrite.id === id)?.deny ?? 0n;

  // 1. Le propriétaire. Sa surcharge héritée est complétée, jamais retournée :
  //    un droit que la catégorie lui refuse nommément reste refusé.
  drafts.set(ownerId, applyBits(
    ensure(ownerId, OverwriteType.Member),
    grantableBits(ownerAllowBits(policy), inheritedDenyFor(ownerId)),
  ));

  // 2. Les rôles autorisés d'office. Ils entrent et parlent même si le salon
  //    naît verrouillé : c'est tout l'intérêt de les déclarer.
  const autoAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  for (const roleId of policy.autoAllowRoleIds) {
    // Second garde-fou : la normalisation écarte déjà @everyone, mais une base
    // écrite avant ce filtrage peut encore en contenir - et @everyone autorisé
    // d'office rouvrirait le salon à tout le serveur.
    if (roleId === everyoneRoleId) continue;
    drafts.set(roleId, applyBits(
      ensure(roleId, OverwriteType.Role),
      grantableBits(autoAllow, inheritedDenyFor(roleId)),
    ));
  }

  // 3. @everyone : verrouillage et chat, rien d'autre.
  const everyoneAllow: bigint[] = [];
  const everyoneDeny: bigint[] = [];

  if (policy.lockOnCreate) {
    everyoneDeny.push(PermissionFlagsBits.Connect);
    // Naître verrouillé ferme l'écriture comme le bouton « Verrouiller », sauf
    // si le chat est explicitement ouvert : c'est alors le réglage qui tranche.
    if (policy.textChat !== 'open') everyoneDeny.push(PermissionFlagsBits.SendMessages);
  }
  if (policy.textChat === 'open') everyoneAllow.push(PermissionFlagsBits.SendMessages);
  if (policy.textChat === 'locked') everyoneDeny.push(PermissionFlagsBits.SendMessages);

  if (everyoneAllow.length > 0 || everyoneDeny.length > 0) {
    // La règle vaut aussi ici : le mode « ouvert » n'écrase pas une écriture que
    // la catégorie refuse nommément a @everyone.
    drafts.set(
      everyoneRoleId,
      applyBits(
        ensure(everyoneRoleId, OverwriteType.Role),
        grantableBits(everyoneAllow, inheritedDenyFor(everyoneRoleId)),
        everyoneDeny,
      ),
    );
  }

  // Une surcharge qui n'autorise ni ne refuse rien est du bruit : Discord la
  // conserve et l'affiché, ce qui laisse croire à un réglage.
  return [...drafts.values()]
    .filter((draft) => draft.allow !== 0n || draft.deny !== 0n)
    .map((draft) => ({
      id: draft.id,
      type: draft.type,
      allow: draft.allow,
      deny: draft.deny,
    }));
}

/** Surcharges d'une catégorie Discord ramenées à la forme utilisée ici. */
export function toOverwriteDrafts(
  overwrites: Iterable<{ id: string; type: OverwriteType; allow: bigint | { bitfield: bigint }; deny: bigint | { bitfield: bigint } }>,
): OverwriteDraft[] {
  return [...overwrites].map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: toBigInt(overwrite.allow),
    deny: toBigInt(overwrite.deny),
  }));
}

/**
 * Surcharges posées par les boutons du panneau de gestion.
 *
 * Regroupées ici pour que l'invariant tienne en un seul endroit vérifiable :
 * rien de ce qui rouvre un salon n'autorise explicitement. Rendre un droit se
 * dit `null`, ce qui le remet à ce que prévoit la catégorie ; `true` écraserait
 * un refus posé plus haut.
 */
export const CHANNEL_PATCHES = {
  /** Ferme l'accès au salon à @everyone, chat textuel compris. */
  lock: { Connect: false, SendMessages: false },
  /** Rend l'accès à ce que prévoit la catégorie. Jamais `true`. */
  unlock: { Connect: null, SendMessages: null },
  /** Levée de réservation : même règle que le déverrouillage. */
  clearReservation: { Connect: null, SendMessages: null },
  /** Ferme le chat textuel à @everyone. */
  closeChat: { SendMessages: false },
  /** Rend le chat textuel à ce que prévoit la catégorie. Jamais `true`. */
  openChat: { SendMessages: null },
  /** Bannissement : couper la seule connexion laisse lire et écrire dans le chat. */
  ban: { Connect: false, ViewChannel: false, SendMessages: false },
} as const satisfies Record<string, Record<string, boolean | null>>;

/**
 * Rôle retenu pour une réservation, ou `null` si la valeur n'a rien à faire là.
 *
 * @everyone porte l'identifiant du serveur : il passe la validation de format,
 * et le réserver ouvrirait le salon à tout le monde. Le rôle doit exister ici,
 * sans quoi la surcharge viserait autre chose.
 */
export function resolveReservationRoleId(
  value: unknown,
  everyoneRoleId: string,
  guildRoleIds: ReadonlySet<string>,
): string | null {
  if (!isSnowflake(value)) return null;
  if (value === everyoneRoleId) return null;
  return guildRoleIds.has(value) ? value : null;
}

/** Ce que « Ajouter » accorde, avant confrontation avec la catégorie. */
const TRUST_BITS: ReadonlyArray<[bigint, string]> = [
  [PermissionFlagsBits.ViewChannel, 'ViewChannel'],
  [PermissionFlagsBits.Connect, 'Connect'],
  [PermissionFlagsBits.Speak, 'Speak'],
  [PermissionFlagsBits.SendMessages, 'SendMessages'],
  [PermissionFlagsBits.ReadMessageHistory, 'ReadMessageHistory'],
];

/**
 * Nombre de droits qu'un accès complet comporte.
 *
 * L'appelant compare la taille du patch pour savoir s'il annonce un accès
 * entier ou partiel : écrire le nombre chez lui le figerait au jour où la liste
 * a été écrite.
 */
export const TRUST_BIT_COUNT = TRUST_BITS.length;

/**
 * Surcharge à poser sur un membre que le propriétaire autorise.
 *
 * On raisonne sur les droits *effectifs* de la personne dans la catégorie, et
 * non sur une surcharge nominative : une catégorie restreinte se configure
 * presque toujours par un refus à @everyone et une autorisation à un rôle.
 *
 * `categoryPermissions` vaut `null` quand le salon n'a pas de catégorie ; le
 * retour vaut `null` quand elle n'en laisse aucun.
 */
export function trustPermissionPatch(categoryPermissions: bigint | null): Record<string, true> | null {
  const patch: Record<string, true> = {};
  for (const [bit, name] of TRUST_BITS) {
    if (categoryPermissions === null || (categoryPermissions & bit) === bit) patch[name] = true;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Ce que la catégorie d'un salon laisse réellement accorder à une cible.
 *
 * Les trois chemins qui accordent - « Ajouter », la réservation par rôle et la
 * même réservation depuis le dashboard - passent tous par ici. Trois cas, dans
 * cet ordre : catégorie configurée mais introuvable, on refuse plutôt que
 * d'accorder sur une absence d'information ; salon sans catégorie, rien ne
 * restreint ; sinon, les droits *effectifs* de la cible font foi.
 *
 * Le paramètre est structurel plutôt que typé `VoiceChannel` : le calcul reste
 * vérifiable sans client Discord, comme le reste du module.
 */
export function categoryTrustPatch<T>(
  channel: {
    parentId: string | null;
    parent: { permissionsFor(target: T): { bitfield: bigint } | null } | null;
  },
  target: T | null | undefined,
): Record<string, true> | null {
  // Cible introuvable : refuser, y compris sans catégorie. La vérifier en
  // dernier faisait tout accorder à une cible nulle sur un salon non rangé.
  if (!target) return null;
  if (channel.parentId && !channel.parent) return null;
  if (!channel.parent) return trustPermissionPatch(null);

  const effective = channel.parent.permissionsFor(target);
  return effective ? trustPermissionPatch(effective.bitfield) : null;
}

/**
 * Droits rendus par le propriétaire sortant lors d'un transfert.
 *
 * Tout ce que `ownerPermissionPatch` accorde revient à l'héritage, accès
 * compris : garder une surcharge nominative reviendrait à laisser chaque ancien
 * propriétaire entrer dans un salon verrouillé, définitivement et sans qu'aucun
 * bouton ne permette de l'en retirer.
 *
 * `null` et non `false` : le sortant redevient un membre ordinaire, il ne
 * devient pas un banni.
 */
export function ownerRevokedPermissions(): Record<string, null> {
  return {
    ViewChannel: null,
    Connect: null,
    Speak: null,
    SendMessages: null,
    ReadMessageHistory: null,
    MuteMembers: null,
    DeafenMembers: null,
    MoveMembers: null,
    ManageChannels: null,
    ManageMessages: null,
  };
}

/** Pouvoirs lisibles dans une surcharge déjà posée : ce qu'un transfert reconduit. */
export function ownerPowersFromBits(allow: bigint): TempVoiceOwnerPower[] {
  return TEMP_VOICE_OWNER_POWERS.filter((power) => (allow & OWNER_POWER_BITS[power]) === OWNER_POWER_BITS[power]);
}

/**
 * Surcharge à poser sur un nouveau propriétaire.
 *
 * Elle reprend ce que la création accorde : l'ancien propriétaire rend son
 * écriture au transfert, donc le nouveau doit la recevoir, sans quoi un salon
 * au chat fermé laisse son propriétaire muet.
 *
 * `categoryPermissions` porte les droits *effectifs* de la cible dans la
 * catégorie : la création les confronte déjà par `grantableBits`, et un
 * transfert qui ne le ferait pas rendrait à un membre sanctionné dans la
 * catégorie la parole qu'on vient de lui retirer. `null` signifie « pas de
 * catégorie », donc rien à confronter.
 *
 * Un droit non accordé vaut `null` et non `false` : le refuser couperait le
 * membre de ce que ses rôles lui donnent ailleurs, alors qu'on veut seulement
 * ne rien ajouter.
 */
export function ownerPermissionPatch(
  powers: TempVoiceOwnerPower[],
  categoryPermissions: bigint | null = null,
): Record<string, boolean | null> {
  const grantable = (bit: bigint): true | null =>
    categoryPermissions === null || (categoryPermissions & bit) === bit ? true : null;

  const patch: Record<string, boolean | null> = {
    ViewChannel: grantable(PermissionFlagsBits.ViewChannel),
    Connect: grantable(PermissionFlagsBits.Connect),
    Speak: grantable(PermissionFlagsBits.Speak),
    SendMessages: grantable(PermissionFlagsBits.SendMessages),
    ReadMessageHistory: grantable(PermissionFlagsBits.ReadMessageHistory),
  };

  const granted = new Set(powers);
  const keys: Record<TempVoiceOwnerPower, string> = {
    mute: 'MuteMembers',
    deafen: 'DeafenMembers',
    move: 'MoveMembers',
    manageChannel: 'ManageChannels',
    manageMessages: 'ManageMessages',
  };

  for (const power of TEMP_VOICE_OWNER_POWERS) {
    patch[keys[power]] = granted.has(power) ? grantable(OWNER_POWER_BITS[power]) : null;
  }

  return patch;
}

/** Nom du salon créé, gabarit appliqué et longueur ramenée à ce que Discord accepte. */
export function renderChannelName(template: string, displayName: string): string {
  // Fonction de remplacement et non chaîne : `String.replace` interprète `$&`,
  // `$1` et leurs voisins, donc un pseudo en contenant corromprait le nom.
  const rendered = (template || DEFAULT_NAME_TEMPLATE).replace(/\{user\}/g, () => displayName);
  const trimmed = rendered.trim();
  // Un gabarit réduit à « {user} » avec un pseudo vide donnerait un nom vide,
  // que Discord refuse.
  const fallback = DEFAULT_NAME_TEMPLATE.replace('{user}', () => displayName).trim();
  return (trimmed || fallback || 'Salon temporaire').slice(0, 100);
}
