import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Les icônes du panneau vocal sont des COPIES de celles du dashboard.
 *
 * Ce n'est pas un oubli : le Dockerfile du bot ne copie que `packages/*` et
 * `apps/bot`, jamais `apps/dashboard`. Lire les emojis chez le dashboard marche
 * sur un poste de dev et rend une carte muette en production. Le dépôt a déjà
 * cette convention — `apps/bot/assets/` porte cinq dossiers d'assets que le bot
 * charge à l'exécution.
 *
 * Le prix de cette copie, c'est qu'elle peut diverger sans que rien ne le dise :
 * quelqu'un retouche une icône côté dashboard, le panneau du bot garde l'ancienne,
 * et personne ne s'en aperçoit avant de comparer deux captures.
 *
 * Ce test est le garde-fou. Il échoue à la seconde où les deux versions ne sont
 * plus identiques, et il nomme le fichier fautif.
 */
const ICONES_BOT = fileURLToPath(new URL('../../../assets/temp-voice-panel/', import.meta.url));
const EMOJIS_DASHBOARD = fileURLToPath(
  new URL('../../../../dashboard/public/emojis-png/', import.meta.url),
);

describe('icônes du panneau vocal', () => {
  const fichiers = existsSync(ICONES_BOT)
    ? readdirSync(ICONES_BOT).filter((nom) => nom.endsWith('.png'))
    : [];

  test('le dossier du bot porte bien les icônes attendues', () => {
    // Si ce compte tombe à zéro, `loadImage` échouera en silence et l'état du
    // panneau se rendra sans aucune icône — un PNG à moitié vide, pas une erreur.
    expect(fichiers.length).toBeGreaterThan(0);
    for (const attendue of ['ktb_lock', 'ktb_unlock', 'ktb_voice', 'ktb_profile']) {
      expect(fichiers).toContain(`${attendue}.png`);
    }
  });

  test('chaque icône est identique à celle du dashboard', () => {
    // Le test ne tourne qu'au dépôt, où les deux dossiers coexistent. Dans
    // l'image du bot, `apps/dashboard` n'existe pas : on saute plutôt que de
    // faire échouer un contrôle qui n'a alors plus de sens.
    if (!existsSync(EMOJIS_DASHBOARD)) return;

    const divergentes: string[] = [];
    const absentes: string[] = [];

    for (const nom of fichiers) {
      const chezLeDashboard = `${EMOJIS_DASHBOARD}${nom}`;
      if (!existsSync(chezLeDashboard)) {
        absentes.push(nom);
        continue;
      }
      if (!readFileSync(`${ICONES_BOT}${nom}`).equals(readFileSync(chezLeDashboard))) {
        divergentes.push(nom);
      }
    }

    expect(
      divergentes,
      `Ces icônes du bot ont divergé de celles du dashboard : ${divergentes.join(', ')}. ` +
        `Recopier depuis apps/dashboard/public/emojis-png/ vers apps/bot/assets/temp-voice-panel/.`,
    ).toEqual([]);

    // Une icône que le dashboard n'a plus : soit elle y a été renommée, soit
    // elle y a été supprimée. Dans les deux cas la copie du bot est orpheline.
    expect(
      absentes,
      `Ces icônes du bot n'existent plus chez le dashboard : ${absentes.join(', ')}.`,
    ).toEqual([]);
  });
});
