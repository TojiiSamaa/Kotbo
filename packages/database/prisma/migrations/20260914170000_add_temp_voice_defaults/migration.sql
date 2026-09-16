-- Politique de creation des salons vocaux temporaires (places, verrouillage,
-- roles autorises d'office, chat texte, pouvoirs du proprietaire).
-- NULL = comportement historique : le service applique alors les valeurs par
-- defaut, identiques a ce qui etait code en dur.

ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "tempVoiceDefaults" JSONB;

-- La table des salons ouverts n'a jamais ete creee par une migration : elle
-- vient d'un `prisma db push`. L'index ci-dessous echouerait donc sur toute base
-- montee par `migrate deploy` seul - integration continue, preproduction, ou
-- nouvelle instance - et bloquerait le demarrage du bot. On la cree ici si elle
-- manque, a l'identique du modele Prisma.
CREATE TABLE IF NOT EXISTS "temp_voice_channels" (
  "id"        TEXT NOT NULL,
  "guildId"   TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "roleId"    TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "temp_voice_channels_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "temp_voice_channels"
    ADD CONSTRAINT "temp_voice_channels_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "guilds"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Les salons d'un serveur sont lus ensemble (dashboard, balayage de demarrage).
CREATE INDEX IF NOT EXISTS "temp_voice_channels_guildId_idx" ON "temp_voice_channels"("guildId");
