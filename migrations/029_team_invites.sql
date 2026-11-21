-- KS_OPS_TEAM_INVITE_TIMING_v1 - the owner chooses when the team is invited: as soon as the system is ready ('auto',
-- the default and how it worked before), or after the owner has set things up ('owner': the team is created on the
-- server but nobody is emailed until the owner presses Invite in the portal).
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS team_invites text NOT NULL DEFAULT 'auto';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'licensees_team_invites_check') THEN
    ALTER TABLE licensees ADD CONSTRAINT licensees_team_invites_check CHECK (team_invites IN ('auto', 'owner'));
  END IF;
END $$;
