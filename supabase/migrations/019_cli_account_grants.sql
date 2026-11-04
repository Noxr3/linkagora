-- ─── The command line signs in for the whole account ──────────────────────
-- A grant from 018 is one account × one client × one agent. `linkagora login`
-- is different: the account consents once, and the person switches between
-- their agents on their own computer (`linkagora agent use`). The server keeps
-- no session for that choice, so a grant with scope 'agents' names no agent and
-- each request does (the LinkAgora-Agent header, lib/auth/caller.ts), checked
-- against the agent's current owner every time.
--
-- Only the command line can get this scope (grantedScope in lib/oauth/rules.ts);
-- the acting principal is still always an agent.

ALTER TABLE oauth_grants ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE oauth_codes  ALTER COLUMN agent_id DROP NOT NULL;

-- Exactly one of: a single agent, or the whole account. Deleting an agent still
-- takes its single-agent grants with it (ON DELETE CASCADE).
ALTER TABLE oauth_grants ADD CONSTRAINT oauth_grants_agent_or_account
  CHECK ((scope = 'agents') = (agent_id IS NULL));
ALTER TABLE oauth_codes ADD CONSTRAINT oauth_codes_agent_or_account
  CHECK ((scope = 'agents') = (agent_id IS NULL));

-- The first-party client: public, PKCE, a loopback callback on any port. Its
-- paste page (/oauth/cli/callback) is added per deployment by
-- registeredRedirectUris. last_used_at is set so registerClient's sweep of
-- clients that never completed a sign-in does not delete it.
INSERT INTO oauth_clients (id, secret_hash, token_endpoint_auth_method, client_name, client_uri, redirect_uris, metadata, last_used_at)
VALUES (
  'linkagora-cli', NULL, 'none', 'LinkAgora command line', 'https://linkagora.dev/docs/cli',
  ARRAY['http://127.0.0.1/callback'], '{"first_party": true}'::jsonb, now()
)
ON CONFLICT (id) DO UPDATE SET
  client_name = EXCLUDED.client_name,
  client_uri = EXCLUDED.client_uri,
  redirect_uris = EXCLUDED.redirect_uris,
  metadata = EXCLUDED.metadata;

-- ─── Exchange a code: the ownership check applies only to a named agent ───
CREATE OR REPLACE FUNCTION oauth_exchange_code(
  p_code_hash       TEXT,
  p_client_id       TEXT,
  p_redirect_uri    TEXT,
  p_code_challenge  TEXT,
  p_access_hash     TEXT,
  p_access_expires  TIMESTAMPTZ,
  p_refresh_hash    TEXT,
  p_refresh_expires TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  c        oauth_codes%ROWTYPE;
  owner_id UUID;
  new_id   UUID;
BEGIN
  SELECT * INTO c FROM oauth_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'unknown_code');
  END IF;

  IF c.used_at IS NOT NULL THEN
    IF c.grant_id IS NOT NULL THEN
      UPDATE oauth_grants SET revoked_at = now() WHERE id = c.grant_id AND revoked_at IS NULL;
    END IF;
    RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'code_reused');
  END IF;

  UPDATE oauth_codes SET used_at = now() WHERE code_hash = p_code_hash;

  IF c.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'code_expired');
  END IF;
  IF c.client_id <> p_client_id THEN
    RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'client_mismatch');
  END IF;
  IF p_redirect_uri IS NOT NULL AND c.redirect_uri <> p_redirect_uri THEN
    RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'redirect_uri_mismatch');
  END IF;
  IF c.code_challenge <> p_code_challenge THEN
    RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'pkce_mismatch');
  END IF;

  -- Still the account's agent? It may have changed hands since consent.
  IF c.agent_id IS NOT NULL THEN
    SELECT user_id INTO owner_id FROM agents WHERE id = c.agent_id;
    IF owner_id IS DISTINCT FROM c.user_id THEN
      RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'agent_not_owned');
    END IF;
  END IF;

  INSERT INTO oauth_grants (client_id, user_id, agent_id, scope, resource, last_used_at)
  VALUES (c.client_id, c.user_id, c.agent_id, c.scope, c.resource, now())
  RETURNING id INTO new_id;

  UPDATE oauth_codes SET grant_id = new_id WHERE code_hash = p_code_hash;

  INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES
    (p_access_hash, new_id, 'access', p_access_expires),
    (p_refresh_hash, new_id, 'refresh', p_refresh_expires);

  UPDATE oauth_clients SET last_used_at = now() WHERE id = c.client_id;

  DELETE FROM oauth_codes WHERE expires_at < now() - INTERVAL '1 day';

  RETURN jsonb_build_object('grant_id', new_id, 'agent_id', c.agent_id, 'scope', c.scope, 'resource', c.resource);
END;
$$;

-- ─── Rotate a refresh token: likewise ─────────────────────────────────────
CREATE OR REPLACE FUNCTION oauth_rotate_refresh(
  p_refresh_hash        TEXT,
  p_client_id           TEXT,
  p_new_access_hash     TEXT,
  p_access_expires      TIMESTAMPTZ,
  p_new_refresh_hash    TEXT,
  p_refresh_expires     TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  t        oauth_tokens%ROWTYPE;
  g        oauth_grants%ROWTYPE;
  owner_id UUID;
BEGIN
  SELECT * INTO t FROM oauth_tokens WHERE token_hash = p_refresh_hash AND kind = 'refresh' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'unknown_token');
  END IF;

  SELECT * INTO g FROM oauth_grants WHERE id = t.grant_id FOR UPDATE;
  IF g.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'grant_revoked');
  END IF;
  IF g.client_id <> p_client_id THEN
    RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'client_mismatch');
  END IF;

  IF t.rotated_at IS NOT NULL THEN
    IF t.rotated_at < now() - INTERVAL '60 seconds' THEN
      UPDATE oauth_grants SET revoked_at = now() WHERE id = g.id;
      RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'token_reused');
    END IF;
    RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'token_already_rotated');
  END IF;

  IF t.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'token_expired');
  END IF;

  IF g.agent_id IS NOT NULL THEN
    SELECT user_id INTO owner_id FROM agents WHERE id = g.agent_id;
    IF owner_id IS DISTINCT FROM g.user_id THEN
      UPDATE oauth_grants SET revoked_at = now() WHERE id = g.id;
      RETURN jsonb_build_object('error', 'invalid_grant', 'reason', 'agent_not_owned');
    END IF;
  END IF;

  UPDATE oauth_tokens SET rotated_at = now() WHERE token_hash = p_refresh_hash;
  INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES
    (p_new_access_hash, g.id, 'access', p_access_expires),
    (p_new_refresh_hash, g.id, 'refresh', p_refresh_expires);
  UPDATE oauth_grants SET last_used_at = now() WHERE id = g.id;
  UPDATE oauth_clients SET last_used_at = now() WHERE id = g.client_id;

  DELETE FROM oauth_tokens
   WHERE grant_id = g.id
     AND (expires_at < now() - INTERVAL '1 day'
          OR (rotated_at IS NOT NULL AND rotated_at < now() - INTERVAL '30 days'));

  RETURN jsonb_build_object('grant_id', g.id, 'agent_id', g.agent_id, 'scope', g.scope, 'resource', g.resource);
END;
$$;

-- ─── Who is this access token? Now also which account, and maybe no agent ──
-- The return type changes, so the function is replaced rather than redefined;
-- its grants go with it and are stated again below.
DROP FUNCTION oauth_resolve_access_token(TEXT);

CREATE FUNCTION oauth_resolve_access_token(p_token_hash TEXT)
RETURNS TABLE (agent_id UUID, user_id UUID, grant_id UUID, client_id TEXT, scope TEXT, resource TEXT)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  SELECT g.agent_id, g.user_id, g.id, g.client_id, g.scope, g.resource, g.last_used_at
    INTO r
    FROM oauth_tokens t
    JOIN oauth_grants g ON g.id = t.grant_id
    LEFT JOIN agents a ON a.id = g.agent_id
   WHERE t.token_hash = p_token_hash
     AND t.kind = 'access'
     AND t.expires_at > now()
     AND g.revoked_at IS NULL
     AND (g.agent_id IS NULL OR a.user_id = g.user_id);
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF r.last_used_at IS NULL OR r.last_used_at < now() - INTERVAL '5 minutes' THEN
    UPDATE oauth_grants SET last_used_at = now() WHERE id = r.id;
  END IF;

  agent_id := r.agent_id;
  user_id := r.user_id;
  grant_id := r.id;
  client_id := r.client_id;
  scope := r.scope;
  resource := r.resource;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION oauth_resolve_access_token(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION oauth_resolve_access_token(TEXT) TO service_role;
