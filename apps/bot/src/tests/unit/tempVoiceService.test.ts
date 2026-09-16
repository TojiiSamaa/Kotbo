import { describe, expect, test } from 'bun:test';
import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import {
  buildCreationOverwrites,
  CHANNEL_PATCHES,
  defaultTempVoicePolicy,
  LEGACY_OWNER_POWERS,
  MAX_ADDITIONAL_GENERATORS,
  MAX_AUTO_ALLOW_ROLES,
  normalizeTempVoiceGeneratorsInput,
  normalizeTempVoicePolicy,
  ownerAllowBits,
  ownerPermissionPatch,
  ownerPowersFromBits,
  ownerRevokedPermissions,
  requiredBotPermissions,
  resolveReservationRoleId,
  trustPermissionPatch,
  categoryTrustPatch,
  TRUST_BIT_COUNT,
  renderChannelName,
  resolveTempVoiceGenerators,
  toOverwriteDrafts,
  type OverwriteDraft,
  type TempVoiceGuildConfig,
} from '../../services/features/tempVoiceService.js';

/**
 * Le module des vocaux temporaires n'avait aucun test, et c'est précisément son
 * calcul de permissions qui décide si un salon reste fermé sur un serveur
 * fermé. Les cas vérifiés ici sont ceux où une erreur ne se voit pas : une
 * surcharge héritée écrasée, un refus transformé en autorisation, un réglage
 * absent lu comme « rien ».
 */

const EVERYONE = '100000000000000000';
const OWNER = '200000000000000000';
const VIP_ROLE = '300000000000000000';
const OTHER_ROLE = '400000000000000000';

function findOverwrite(overwrites: ReturnType<typeof buildCreationOverwrites>, id: string) {
  return overwrites.find((overwrite) => overwrite.id === id);
}

function allowOf(overwrites: ReturnType<typeof buildCreationOverwrites>, id: string): bigint {
  return BigInt((findOverwrite(overwrites, id)?.allow ?? 0n) as bigint);
}

function denyOf(overwrites: ReturnType<typeof buildCreationOverwrites>, id: string): bigint {
  return BigInt((findOverwrite(overwrites, id)?.deny ?? 0n) as bigint);
}

function has(bits: bigint, flag: bigint): boolean {
  return (bits & flag) === flag;
}

describe('normalizeTempVoicePolicy', () => {
  test('une configuration absente rend le comportement historique', () => {
    // Les serveurs configures avant ce réglage n'ont rien en base. Leur rendre
    // autre chose que l'ancien comportement changerait leurs salons sans que
    // personne n'ait rien demande.
    const policy = normalizeTempVoicePolicy(undefined);

    expect(policy).toEqual(defaultTempVoicePolicy());
    expect(policy.ownerPowers).toEqual([...LEGACY_OWNER_POWERS]);
    expect(policy.textChat).toBe('inherit');
  });

  test('une liste de pouvoirs vide est respectée, contrairement à une absence', () => {
    // La nuance porte tout le réglage : « je ne veux aucun pouvoir » et « je
    // n'ai jamais touché à ce champ » arrivent tous deux sous forme falsy.
    expect(normalizeTempVoicePolicy({ ownerPowers: [] }).ownerPowers).toEqual([]);
    expect(normalizeTempVoicePolicy({}).ownerPowers).toEqual([...LEGACY_OWNER_POWERS]);
  });

  test('borne la limite de places à ce que Discord accepte', () => {
    expect(normalizeTempVoicePolicy({ userLimit: 5000 }).userLimit).toBe(99);
    expect(normalizeTempVoicePolicy({ userLimit: -3 }).userLimit).toBe(0);
    expect(normalizeTempVoicePolicy({ userLimit: 7.9 }).userLimit).toBe(7);
    expect(normalizeTempVoicePolicy({ userLimit: 'douze' }).userLimit).toBe(0);
  });

  test('écarte les identifiants de rôle qui n\'en sont pas', () => {
    const policy = normalizeTempVoicePolicy({
      autoAllowRoleIds: [VIP_ROLE, 'everyone', '42', null, VIP_ROLE],
    });

    expect(policy.autoAllowRoleIds).toEqual([VIP_ROLE]);
  });

  test('plafonne le nombre de rôles autorisés d\'office', () => {
    const tooMany = Array.from({ length: MAX_AUTO_ALLOW_ROLES + 5 }, (_, i) => String(100000000000000000n + BigInt(i)));

    expect(normalizeTempVoicePolicy({ autoAllowRoleIds: tooMany }).autoAllowRoleIds).toHaveLength(MAX_AUTO_ALLOW_ROLES);
  });

  test('un mode de chat inconnu retombe sur l\'héritage', () => {
    expect(normalizeTempVoicePolicy({ textChat: 'members' }).textChat).toBe('inherit');
    expect(normalizeTempVoicePolicy({ textChat: 'locked' }).textChat).toBe('locked');
  });

  test('écarte un pouvoir inventé', () => {
    expect(normalizeTempVoicePolicy({ ownerPowers: ['mute', 'administrator'] }).ownerPowers).toEqual(['mute']);
  });
});

describe('normalizeTempVoiceGeneratorsInput', () => {
  test('écarte une entrée sans salon plutôt que de la corriger', () => {
    // La route ecrivait le corps de la requête tel quel : un générateur sans
    // salon s'affichait dans la page comme une ligne active qui ne déclenchait
    // jamais rien.
    const generators = normalizeTempVoiceGeneratorsInput([
      { nameTemplate: 'Salon' },
      { channelId: 'pas-un-id' },
      { channelId: VIP_ROLE },
    ]);

    expect(generators).toHaveLength(1);
    expect(generators[0]?.channelId).toBe(VIP_ROLE);
  });

  test('un même salon générateur n\'apparaît qu\'une fois', () => {
    const generators = normalizeTempVoiceGeneratorsInput([
      { channelId: VIP_ROLE, nameTemplate: 'Premier' },
      { channelId: VIP_ROLE, nameTemplate: 'Jamais atteint' },
    ]);

    expect(generators).toHaveLength(1);
    expect(generators[0]?.nameTemplate).toBe('Premier');
  });

  test('n\'accepte que des tableaux', () => {
    // Le JSON vient de la base : un objet, une chaîne ou `null` y traînent dès
    // qu'une version antérieure - ou une écriture à la main - l'a déposé.
    expect(normalizeTempVoiceGeneratorsInput({ channelId: VIP_ROLE })).toEqual([]);
    expect(normalizeTempVoiceGeneratorsInput('texte')).toEqual([]);
    expect(normalizeTempVoiceGeneratorsInput(null)).toEqual([]);
  });

  test('conserve les champs d\'une entrée valide', () => {
    // Même exigence qu'à la résolution, mais à l'écriture : la page envoie ces
    // quatre champs, la base doit les garder.
    expect(normalizeTempVoiceGeneratorsInput([{
      channelId: VIP_ROLE,
      categoryId: OWNER,
      nameTemplate: '🎮 {user}',
      requiredRoleId: OTHER_ROLE,
    }])).toEqual([expect.objectContaining({
      channelId: VIP_ROLE,
      categoryId: OWNER,
      nameTemplate: '🎮 {user}',
      requiredRoleId: OTHER_ROLE,
    })]);
  });

  test('plafonne la liste', () => {
    const tooMany = Array.from({ length: MAX_ADDITIONAL_GENERATORS + 10 }, (_, i) => ({
      channelId: String(100000000000000000n + BigInt(i)),
    }));

    expect(normalizeTempVoiceGeneratorsInput(tooMany)).toHaveLength(MAX_ADDITIONAL_GENERATORS);
  });

  test('écarte un générateur posé sur le salon du principal', () => {
    // La resolution place le principal en tête et s'arrête au premier salon qui
    // correspond : un additionnel sur le même salon ne serait jamais atteint,
    // et la page afficherait pourtant deux générateurs distincts.
    const entries = [{ channelId: VIP_ROLE }, { channelId: OTHER_ROLE }];

    expect(normalizeTempVoiceGeneratorsInput(entries, undefined, VIP_ROLE))
      .toEqual([expect.objectContaining({ channelId: OTHER_ROLE })]);
  });

  test('normalise la politique de chaque entrée', () => {
    const [generator] = normalizeTempVoiceGeneratorsInput([
      { channelId: VIP_ROLE, userLimit: 400, textChat: 'nawak', autoAllowRoleIds: ['x'] },
    ]);

    expect(generator?.userLimit).toBe(99);
    expect(generator?.textChat).toBe('inherit');
    expect(generator?.autoAllowRoleIds).toEqual([]);
  });

  test('un gabarit vide retombe sur le gabarit par défaut', () => {
    const [generator] = normalizeTempVoiceGeneratorsInput([{ channelId: VIP_ROLE, nameTemplate: '   ' }]);

    expect(generator?.nameTemplate).toContain('{user}');
  });
});

describe('resolveTempVoiceGenerators', () => {
  const base: TempVoiceGuildConfig = {
    tempVoiceEnabled: true,
    tempVoiceChannelId: VIP_ROLE,
    tempVoiceCategoryId: null,
    tempVoiceNameTemplate: '🔊 Salon de {user}',
  };

  test('le générateur principal porte la politique par défaut du serveur', () => {
    const [principal] = resolveTempVoiceGenerators({
      ...base,
      tempVoiceDefaults: { userLimit: 6, lockOnCreate: true },
    });

    expect(principal?.policy.userLimit).toBe(6);
    expect(principal?.policy.lockOnCreate).toBe(true);
  });

  test('un générateur additionnel garde sa propre politique', () => {
    const generators = resolveTempVoiceGenerators({
      ...base,
      tempVoiceDefaults: { userLimit: 6 },
      tempVoiceGenerators: [{ channelId: OTHER_ROLE, userLimit: 2, textChat: 'open' }],
    });

    expect(generators).toHaveLength(2);
    expect(generators[0]?.policy.userLimit).toBe(6);
    expect(generators[1]?.policy.userLimit).toBe(2);
    expect(generators[1]?.policy.textChat).toBe('open');
  });

  test('un générateur additionnel garde son salon, sa catégorie, son gabarit et son rôle requis', () => {
    // Quatre champs distincts que rien n'exigeait : perdre l'un d'eux fait
    // naître les salons au mauvais endroit, sous le mauvais nom, ou ouvre un
    // générateur réservé.
    const [, additionnel] = resolveTempVoiceGenerators({
      ...base,
      tempVoiceChannelId: VIP_ROLE,
      tempVoiceGenerators: [{
        channelId: OTHER_ROLE,
        categoryId: OWNER,
        nameTemplate: '🎮 {user}',
        requiredRoleId: EVERYONE,
      }],
    });

    expect(additionnel?.channelId).toBe(OTHER_ROLE);
    expect(additionnel?.categoryId).toBe(OWNER);
    expect(additionnel?.nameTemplate).toBe('🎮 {user}');
    expect(additionnel?.requiredRoleId).toBe(EVERYONE);
    expect(additionnel?.primary).toBe(false);
  });

  test('un serveur sans générateur principal ne rend que les additionnels', () => {
    const generators = resolveTempVoiceGenerators({
      ...base,
      tempVoiceChannelId: null,
      tempVoiceGenerators: [{ channelId: OTHER_ROLE }],
    });

    expect(generators).toHaveLength(1);
    expect(generators[0]?.channelId).toBe(OTHER_ROLE);
  });
});

describe('ownerAllowBits', () => {
  test('le propriétaire voit, entre et parle quels que soient ses pouvoirs', () => {
    const bits = ownerAllowBits({ ...defaultTempVoicePolicy(), ownerPowers: [] });

    expect(bits).toContain(PermissionFlagsBits.ViewChannel);
    expect(bits).toContain(PermissionFlagsBits.Connect);
    expect(bits).toContain(PermissionFlagsBits.Speak);
    expect(bits).not.toContain(PermissionFlagsBits.MuteMembers);
  });

  test('chaque pouvoir coché ajoute son droit', () => {
    const bits = ownerAllowBits({
      ...defaultTempVoicePolicy(),
      ownerPowers: ['manageChannel', 'manageMessages'],
    });

    expect(bits).toContain(PermissionFlagsBits.ManageChannels);
    expect(bits).toContain(PermissionFlagsBits.ManageMessages);
  });

  test('le propriétaire écrit et lit dans son salon quel que soit le réglage', () => {
    // Verrouiller ferme l'écriture à @everyone : sans ces deux bits, appuyer sur
    // « Verrouiller » rendrait le propriétaire muet chez lui. La confrontation
    // avec la catégorie reste faite par `grantableBits`, pas ici.
    for (const textChat of ['inherit', 'open', 'locked'] as const) {
      const bits = ownerAllowBits({ ...defaultTempVoicePolicy(), textChat });
      expect(bits).toContain(PermissionFlagsBits.SendMessages);
      expect(bits).toContain(PermissionFlagsBits.ReadMessageHistory);
    }
  });
});

describe('buildCreationOverwrites', () => {
  const closedInheritance: OverwriteDraft[] = [
    {
      id: EVERYONE,
      type: OverwriteType.Role,
      allow: 0n,
      deny: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect,
    },
  ];

  test('conserve le refus hérité de la catégorie', () => {
    // Le cœur du module : un salon temporaire qui se rouvrirait à @everyone
    // serait, sur un serveur fermé, le seul salon visible des non-membres.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: closedInheritance,
      policy: defaultTempVoicePolicy(),
    });

    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.ViewChannel)).toBe(true);
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.Connect)).toBe(true);
  });

  test('ouvrir le chat n\'ouvre pas l\'accès au salon', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: closedInheritance,
      policy: { ...defaultTempVoicePolicy(), textChat: 'open' },
    });

    expect(has(allowOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBe(true);
    // La visibilité et la connexion restent celles de la catégorie.
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.ViewChannel)).toBe(true);
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.Connect)).toBe(true);
  });

  test('le propriétaire reçoit ses droits sans perdre ce que la catégorie lui donnait', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [
        ...closedInheritance,
        { id: OWNER, type: OverwriteType.Member, allow: PermissionFlagsBits.PrioritySpeaker, deny: 0n },
      ],
      policy: defaultTempVoicePolicy(),
    });

    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.PrioritySpeaker)).toBe(true);
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.Connect)).toBe(true);
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.MuteMembers)).toBe(true);
  });

  test('un refus nominatif hérité de la catégorie n\'est jamais retourné', () => {
    // Un membre que la catégorie refuse nommément ne doit pas récupérer ce
    // droit en devenant propriétaire d'un salon temporaire : il entrerait dans
    // une catégorie dont il est exclu.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [{
        id: OWNER,
        type: OverwriteType.Member,
        allow: 0n,
        deny: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect,
      }],
      policy: defaultTempVoicePolicy(),
    });

    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.Connect)).toBeFalse();
    expect(has(denyOf(overwrites, OWNER), PermissionFlagsBits.Connect)).toBeTrue();
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.ViewChannel)).toBeFalse();
    // Le filtrage porte bit à bit : ce que la catégorie ne refuse pas reste
    // accordé. Sans cette assertion, un « si la cible porte le moindre refus,
    // je n'accorde rien » passerait aussi.
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.Speak)).toBeTrue();
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.MuteMembers)).toBeTrue();
  });

  test('un rôle autorisé d\'office ne reçoit pas ce que la catégorie lui refuse', () => {
    // Même règle pour l'étape des rôles : le chemin était corrigé, rien ne le
    // gardait.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [{
        id: VIP_ROLE,
        type: OverwriteType.Role,
        allow: 0n,
        deny: PermissionFlagsBits.ViewChannel,
      }],
      policy: { ...defaultTempVoicePolicy(), autoAllowRoleIds: [VIP_ROLE] },
    });

    expect(has(allowOf(overwrites, VIP_ROLE), PermissionFlagsBits.ViewChannel)).toBeFalse();
    expect(has(denyOf(overwrites, VIP_ROLE), PermissionFlagsBits.ViewChannel)).toBeTrue();
    expect(has(allowOf(overwrites, VIP_ROLE), PermissionFlagsBits.Connect)).toBeTrue();
  });

  test('ouvrir le chat ne rouvre pas ce que la catégorie refuse à @everyone', () => {
    // L'étape @everyone ne passait pas par le filtre : un refus d'écriture posé
    // par la catégorie était effacé par le mode « ouvert ».
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [{
        id: EVERYONE,
        type: OverwriteType.Role,
        allow: 0n,
        deny: PermissionFlagsBits.SendMessages,
      }],
      policy: { ...defaultTempVoicePolicy(), textChat: 'open' },
    });

    expect(has(allowOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBeFalse();
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBeTrue();
  });

  test('un refus porté par @everyone reste dépassable par le propriétaire', () => {
    // La nuance qui fait tenir le module : sur un serveur fermé, le
    // propriétaire doit entrer dans son propre salon. Une surcharge membre bat
    // une surcharge de rôle côté Discord, et c'est le comportement voulu.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [{
        id: EVERYONE,
        type: OverwriteType.Role,
        allow: 0n,
        deny: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect,
      }],
      policy: defaultTempVoicePolicy(),
    });

    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.Connect)).toBeTrue();
    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.Connect)).toBeTrue();
  });

  test('les rôles autorisés d\'office entrent malgré un salon créé verrouillé', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), lockOnCreate: true, autoAllowRoleIds: [VIP_ROLE] },
    });

    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.Connect)).toBe(true);
    expect(has(allowOf(overwrites, VIP_ROLE), PermissionFlagsBits.Connect)).toBe(true);
    expect(has(allowOf(overwrites, VIP_ROLE), PermissionFlagsBits.ViewChannel)).toBe(true);
  });

  test('le chat fermé laisse écrire le propriétaire et les rôles autorisés', () => {
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), textChat: 'locked', autoAllowRoleIds: [VIP_ROLE] },
    });

    expect(has(denyOf(overwrites, EVERYONE), PermissionFlagsBits.SendMessages)).toBe(true);
    expect(has(allowOf(overwrites, OWNER), PermissionFlagsBits.SendMessages)).toBe(true);
    expect(has(allowOf(overwrites, VIP_ROLE), PermissionFlagsBits.SendMessages)).toBe(true);
  });

  test('ne pose aucune surcharge @everyone quand la politique n\'en demande pas', () => {
    // Sans héritage ni réglage, le salon doit rester parfaitement synchronise
    // avec sa catégorie : une surcharge vide se verrait dans l'interface et
    // laisserait croire à un réglage.
    const overwrites = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: defaultTempVoicePolicy(),
    });

    expect(findOverwrite(overwrites, EVERYONE)).toBeUndefined();
    expect(overwrites).toHaveLength(1);
  });
});

describe('CHANNEL_PATCHES', () => {
  /**
   * Regression gardée nommément : « Déverrouiller » posait `Connect: true` sur
   * @everyone, et la levee de réservation faisait de même. Sur un serveur dont
   * la catégorie refuse la connexion aux membres non vérifiés, un clic sur ce
   * bouton ouvrait le salon à tout le serveur - le salon temporaire devenait le
   * seul où entrer sans avoir passé la vérification.
   *
   * `null` rend le droit à la catégorie ; `true` l'écrase. La nuance ne se voit
   * pas à la lecture du code appelant, d'où ces assertions.
   */
  test('rien de ce qui rouvre un salon n\'autorise explicitement', () => {
    expect(CHANNEL_PATCHES.unlock.Connect).toBeNull();
    expect(CHANNEL_PATCHES.clearReservation.Connect).toBeNull();
    expect(CHANNEL_PATCHES.openChat.SendMessages).toBeNull();

    // Le type de `CHANNEL_PATCHES` interdit déjà `true` ; l'assertion garde le
    // jour où quelqu'un élargirait ce type sans y penser.
    const patches: Record<string, Record<string, boolean | null>> = CHANNEL_PATCHES;
    for (const patch of Object.values(patches)) {
      for (const [permission, value] of Object.entries(patch)) {
        expect(
          value === true,
          `${permission} ne doit jamais être autorisé explicitement : utiliser null pour rendre le droit à la catégorie`,
        ).toBe(false);
      }
    }
  });

  test('naître verrouillé ferme le chat comme le bouton', () => {
    // Les deux chemins qui verrouillent doivent laisser le même salon : sinon,
    // un salon ne le serait vraiment qu'après un aller-retour sur le bouton.
    const atCreation = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), lockOnCreate: true },
    });
    expect(has(denyOf(atCreation, EVERYONE), PermissionFlagsBits.SendMessages)).toBeTrue();

    // Sauf si le chat est explicitement ouvert : le réglage tranche alors.
    const chatOpened = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), lockOnCreate: true, textChat: 'open' },
    });
    expect(has(denyOf(chatOpened, EVERYONE), PermissionFlagsBits.SendMessages)).toBeFalse();
    expect(has(allowOf(chatOpened, EVERYONE), PermissionFlagsBits.SendMessages)).toBeTrue();
  });

  test('verrouiller ferme la connexion et le chat, jamais la visibilité', () => {
    // Le chat textuel suit l'accès, sinon un salon verrouillé laisse ceux qui le
    // voient y écrire quand même. La visibilité, elle, n'est jamais modifiée
    // par le panneau : un salon verrouillé reste lisible par ceux qui le
    // voyaient déjà.
    expect(CHANNEL_PATCHES.lock).toEqual({ Connect: false, SendMessages: false });
    expect(CHANNEL_PATCHES.unlock).toEqual({ Connect: null, SendMessages: null });
  });

  test('bannir coupe aussi le chat textuel', () => {
    // Le bannissement ne coupait que la connexion : le banni continuait de lire
    // et d'écrire dans le chat du salon dont on venait de le sortir.
    expect(CHANNEL_PATCHES.ban.Connect).toBe(false);
    expect(CHANNEL_PATCHES.ban.ViewChannel).toBe(false);
    expect(CHANNEL_PATCHES.ban.SendMessages).toBe(false);
  });
});

describe('ownerPowersFromBits / ownerPermissionPatch', () => {
  test('relit les pouvoirs réellement posés sur un salon', () => {
    const allow = PermissionFlagsBits.Connect | PermissionFlagsBits.MoveMembers | PermissionFlagsBits.ManageMessages;

    expect(ownerPowersFromBits(allow)).toEqual(['move', 'manageMessages']);
  });

  test('un transfert reconduit les pouvoirs de l\'ancien propriétaire', () => {
    // Le salon ne retient pas quel générateur l'a créé, et la politique a pu
    // changer depuis : ce que le salon porte est la seule source fiable.
    const patch = ownerPermissionPatch(ownerPowersFromBits(PermissionFlagsBits.MuteMembers));

    expect(patch.MuteMembers).toBe(true);
    expect(patch.Connect).toBe(true);
    // Un pouvoir non accordé vaut `null` et non `false` : le refuser couperait
    // le membre de ce que ses rôles lui donnent ailleurs sur le serveur.
    expect(patch.MoveMembers).toBeNull();
    expect(patch.ManageChannels).toBeNull();
  });

  test('rend au propriétaire sortant tout ce qu\'un transfert doit reprendre', () => {
    // L'ancien propriétaire gardait ses pouvoirs de modération vocale sur un
    // salon qui n'était plus le sien.
    const revoked = ownerRevokedPermissions();

    expect(Object.values(revoked).every((value) => value === null)).toBe(true);
    expect(Object.keys(revoked)).toContain('MuteMembers');
    expect(Object.keys(revoked)).toContain('SendMessages');
  });
});

describe('régressions relevées en revue', () => {
  /** Catégorie fermée : ni visible ni joignable par @everyone. */
  const closedCategory: OverwriteDraft[] = [
    {
      id: EVERYONE,
      type: OverwriteType.Role,
      allow: 0n,
      deny: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect,
    },
  ];

  test('@everyone ne peut pas être un rôle autorisé d\'office', () => {
    // Son identifiant est celui du serveur : il passe la validation de format.
    expect(normalizeTempVoicePolicy({ autoAllowRoleIds: [EVERYONE, VIP_ROLE] }, EVERYONE).autoAllowRoleIds)
      .toEqual([VIP_ROLE]);

    // Et si la valeur vient d'une base écrite avant ce filtrage, la création ne
    // doit pas la suivre non plus. Le cas qui tranche est le salon ouvert, sans
    // héritage : la politique ne demande aucune surcharge @everyone, donc si
    // l'autorisation d'office en pose une, c'est qu'elle a accordé à tout le
    // serveur des droits que rien ne lui rendrait ensuite. Sur une catégorie
    // fermée, au contraire, le refus hérité masquerait l'absence de garde-fou.
    const openCategory = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: [],
      policy: { ...defaultTempVoicePolicy(), autoAllowRoleIds: [EVERYONE] },
    });
    expect(findOverwrite(openCategory, EVERYONE)).toBeUndefined();

    const closedCategoryCase = buildCreationOverwrites({
      everyoneRoleId: EVERYONE,
      ownerId: OWNER,
      inherited: closedCategory,
      policy: { ...defaultTempVoicePolicy(), autoAllowRoleIds: [EVERYONE] },
    });
    expect(has(denyOf(closedCategoryCase, EVERYONE), PermissionFlagsBits.ViewChannel)).toBeTrue();
  });

  /** Ce qu'une catégorie ouverte accorde, sans aucun droit d'administration. */
  const CATEGORY_GRANTS = PermissionFlagsBits.ViewChannel
    | PermissionFlagsBits.Connect
    | PermissionFlagsBits.Speak
    | PermissionFlagsBits.SendMessages
    | PermissionFlagsBits.ReadMessageHistory
    | PermissionFlagsBits.MuteMembers
    | PermissionFlagsBits.MoveMembers
    | PermissionFlagsBits.ManageChannels
    | PermissionFlagsBits.ManageMessages;

  test('un transfert n\'accorde pas ce que la catégorie refuse à la cible', () => {
    // La création confronte déjà la catégorie. Le transfert, lui, posait `true`
    // en dur : un membre à qui le staff a retiré la parole dans la catégorie la
    // retrouvait en recevant le salon.
    const withoutSpeak = CATEGORY_GRANTS & ~PermissionFlagsBits.Speak;
    const patch = ownerPermissionPatch(['mute'], withoutSpeak);

    expect(patch.Speak).toBeNull();
    expect(patch.Connect).toBe(true);
    expect(patch.MuteMembers).toBe(true);

    // Une catégorie qui refuse aussi le pouvoir coché ne le laisse pas passer.
    const withoutMute = CATEGORY_GRANTS & ~PermissionFlagsBits.MuteMembers;
    expect(ownerPermissionPatch(['mute'], withoutMute).MuteMembers).toBeNull();
  });

  test('le propriétaire sortant rend aussi son accès au salon', () => {
    // Garder vue, connexion et parole en surcharge nominative laissait chaque
    // ancien propriétaire entrer dans un salon verrouillé, définitivement : au
    // bout de deux transferts, « Verrouiller » ne fermait plus rien.
    const returned = ownerRevokedPermissions();

    for (const droit of ['ViewChannel', 'Connect', 'Speak', 'SendMessages', 'ReadMessageHistory']) {
      expect(returned[droit]).toBeNull();
    }
    // Tout ce que le patch de propriété accorde doit revenir à l'héritage.
    expect(Object.keys(returned).sort()).toEqual(Object.keys(ownerPermissionPatch([])).sort());
  });

  test('le nouveau propriétaire reçoit le droit d\'écrire, l\'ancien le rend', () => {
    // L'ancien propriétaire rend son `SendMessages` au transfert : sans le
    // symetrique sur le nouveau, le salon changeait de main en restant muet.
    expect(ownerPermissionPatch(['mute']).SendMessages).toBeTrue();
    expect(ownerPermissionPatch(['mute']).ReadMessageHistory).toBeTrue();

    // Rendu vaut `null` et non `false` : l'ancien propriétaire reste un membre
    // comme les autres, il ne devient pas muet dans le salon.
    expect(ownerRevokedPermissions().SendMessages).toBeNull();
    expect(ownerRevokedPermissions().ReadMessageHistory).toBeNull();
  });

  test('les écritures de surcharges exigent ManageRoles', () => {
    // Toutes les écritures du module sont des `permissionOverwrites.edit`, et
    // créer un salon avec des surcharges l'exige aussi. Un bot sans ce droit
    // passait la porte puis echouait partout ensuite.
    expect(requiredBotPermissions(defaultTempVoicePolicy())).toContain(PermissionFlagsBits.ManageRoles);
  });

  test('les droits exigés du bot suivent la politique', () => {
    // Discord refuse un salon dont une surcharge accorde un droit que le bot
    // n'a pas.
    const withoutPower = requiredBotPermissions({ ...defaultTempVoicePolicy(), ownerPowers: [] });
    const withMessages = requiredBotPermissions({ ...defaultTempVoicePolicy(), ownerPowers: ['manageMessages'] });

    expect(withoutPower).toContain(PermissionFlagsBits.ManageChannels);
    expect(withoutPower).not.toContain(PermissionFlagsBits.ManageMessages);
    expect(withMessages).toContain(PermissionFlagsBits.ManageMessages);
  });

  test('un pseudo contenant $& n\'est pas interprété', () => {
    expect(renderChannelName('Salon de {user}', '$&')).toBe('Salon de $&');
    expect(renderChannelName('{user}', "a$'b")).toBe("a$'b");
  });

  test('le générateur principal se reconnaît, il ne se devine pas', () => {
    // Un serveur peut n'avoir que des générateurs additionnels.
    const base = {
      tempVoiceEnabled: true,
      tempVoiceCategoryId: null,
      tempVoiceNameTemplate: '🔊 Salon de {user}',
      tempVoiceGenerators: [{ channelId: OTHER_ROLE }],
    };

    expect(resolveTempVoiceGenerators({ ...base, tempVoiceChannelId: VIP_ROLE })
      .find((entry) => entry.primary)?.channelId).toBe(VIP_ROLE);
    expect(resolveTempVoiceGenerators({ ...base, tempVoiceChannelId: null })
      .find((entry) => entry.primary)).toBeUndefined();
  });
});

describe('trustPermissionPatch', () => {
  const ALL_TRUST_BITS = PermissionFlagsBits.ViewChannel
    | PermissionFlagsBits.Connect
    | PermissionFlagsBits.Speak
    | PermissionFlagsBits.SendMessages
    | PermissionFlagsBits.ReadMessageHistory;

  test('un accès complet ouvre aussi le chat textuel du salon', () => {
    // Verrouiller ferme l'écriture à @everyone : un membre ajouté qui ne
    // recevrait que la connexion se retrouverait muet dans le salon.
    const patch = trustPermissionPatch(ALL_TRUST_BITS);

    expect(patch).toEqual({
      ViewChannel: true,
      Connect: true,
      Speak: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
    expect(Object.keys(patch ?? {})).toHaveLength(TRUST_BIT_COUNT);
  });

  test('refuse une cible introuvable, même sur un salon sans catégorie', () => {
    // La garde sur la cible venait après celle sur la catégorie : un salon non
    // rangé accordait alors les cinq droits à une cible que personne n'avait su
    // résoudre.
    expect(categoryTrustPatch({ parentId: null, parent: null }, null)).toBeNull();
    expect(categoryTrustPatch({ parentId: null, parent: null }, { id: 'x' })).not.toBeNull();
  });

  test('n\'accorde que ce que la catégorie laisse réellement à la cible', () => {
    // Le cas courant : la catégorie refuse la vue à @everyone et l'autorise à un
    // rôle. Une cible sans ce rôle n'a pas ViewChannel dans ses droits effectifs.
    const patch = trustPermissionPatch(PermissionFlagsBits.Connect | PermissionFlagsBits.Speak);

    expect(patch?.ViewChannel).toBeUndefined();
    expect(patch?.Connect).toBeTrue();
    expect(patch?.Speak).toBeTrue();
  });

  test('rend null quand la catégorie ne laisse rien', () => {
    expect(trustPermissionPatch(0n)).toBeNull();
  });

  test('accorde tout quand la catégorie laisse tout', () => {
    const patch = trustPermissionPatch(ALL_TRUST_BITS);

    expect(patch?.ViewChannel).toBeTrue();
    expect(patch?.Connect).toBeTrue();
    expect(patch?.Speak).toBeTrue();
  });

  test('un salon sans catégorie n\'a aucune restriction à respecter', () => {
    const patch = trustPermissionPatch(null);

    expect(patch?.ViewChannel).toBeTrue();
    expect(patch?.Speak).toBeTrue();
  });
});

describe('resolveReservationRoleId', () => {
  /**
   * La route posait `body.roleId` directement dans une surcharge. Avec
   * l'identifiant du serveur, elle autorisait @everyone à voir et rejoindre le
   * salon.
   */
  const guildRoles = new Set([VIP_ROLE, OTHER_ROLE]);

  test('refuse le rôle @everyone, qui porte l\'identifiant du serveur', () => {
    expect(resolveReservationRoleId(EVERYONE, EVERYONE, guildRoles)).toBeNull();
  });

  test('refuse un rôle qui n\'existe pas sur ce serveur', () => {
    expect(resolveReservationRoleId('500000000000000000', EVERYONE, guildRoles)).toBeNull();
  });

  test('refuse ce qui n\'est pas un identifiant', () => {
    expect(resolveReservationRoleId('everyone', EVERYONE, guildRoles)).toBeNull();
    expect(resolveReservationRoleId(42, EVERYONE, guildRoles)).toBeNull();
  });

  test('accepte un rôle du serveur', () => {
    expect(resolveReservationRoleId(VIP_ROLE, EVERYONE, guildRoles)).toBe(VIP_ROLE);
  });
});

describe('toOverwriteDrafts', () => {
  test('accepte les champs de bits de discord.js comme des entiers', () => {
    const drafts = toOverwriteDrafts([
      { id: EVERYONE, type: OverwriteType.Role, allow: { bitfield: PermissionFlagsBits.Connect }, deny: 0n },
    ]);

    expect(drafts[0]?.allow).toBe(PermissionFlagsBits.Connect);
  });
});

describe('renderChannelName', () => {
  test('remplace le pseudo et coupe à la longueur acceptée', () => {
    expect(renderChannelName('🔊 Salon de {user}', 'Alex')).toBe('🔊 Salon de Alex');
    expect(renderChannelName('{user}', 'x'.repeat(200))).toHaveLength(100);
  });

  test('ne rend jamais un nom vide', () => {
    // Discord refuse un nom vide : le salon ne serait pas créé, et le membre
    // resterait bloque dans le générateur sans explication.
    expect(renderChannelName('{user}', '   ').length).toBeGreaterThan(0);
  });
});
