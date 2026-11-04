-- Executed by scripts/test-sql.sh after replaying every migration. Everything
-- happens in one transaction that is rolled back. A failed check raises.

BEGIN;

CREATE FUNCTION pg_temp.check(ok boolean, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', what; END IF;
END;
$$;

-- Hashes stand in for tokens: the app hashes, these functions only compare.
CREATE FUNCTION pg_temp.issue(p_code text, p_user uuid, p_agent uuid, p_scope text, p_challenge text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO oauth_codes (code_hash, client_id, user_id, agent_id, redirect_uri, code_challenge, scope, resource, expires_at)
  VALUES (p_code, 'linkagora-cli', p_user, p_agent, 'http://127.0.0.1:5000/callback', p_challenge, p_scope, 'https://linkagora.dev', now() + interval '5 minutes');
$$;

DO $$
DECLARE
  ada   uuid := gen_random_uuid();
  bob   uuid := gen_random_uuid();
  agent uuid := gen_random_uuid();
  later timestamptz := now() + interval '1 hour';
  r     jsonb;
  row   record;
  blocked boolean;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (ada, 'ada@example.com'), (bob, 'bob@example.com');
  INSERT INTO agents (id, name, slug, description, provider, url, user_id)
  VALUES (agent, 'Ada One', 'sql-ada-one', 'test', 'test', 'https://sql-ada-one.example.com', ada);

  -- ── The client survives the sweep of clients that never signed in ─────
  PERFORM pg_temp.check((SELECT last_used_at IS NOT NULL AND secret_hash IS NULL FROM oauth_clients WHERE id = 'linkagora-cli'), 'the command line is a kept public client');

  -- ── A grant is one agent, or the whole account, never a mix ───────────
  blocked := false;
  BEGIN
    PERFORM pg_temp.issue('mix-1', ada, agent, 'agents', 'c');
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  PERFORM pg_temp.check(blocked, 'scope agents with an agent is refused');
  blocked := false;
  BEGIN
    PERFORM pg_temp.issue('mix-2', ada, NULL, 'agent', 'c');
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  PERFORM pg_temp.check(blocked, 'scope agent without an agent is refused');

  -- ── Sign in for the whole account ─────────────────────────────────────
  PERFORM pg_temp.issue('code-1', ada, NULL, 'agents', 'challenge');
  r := oauth_exchange_code('code-1', 'linkagora-cli', NULL, 'wrong', 'a0', later, 'r0', later);
  PERFORM pg_temp.check(r->>'reason' = 'pkce_mismatch', 'a wrong verifier is refused');
  PERFORM pg_temp.issue('code-2', ada, NULL, 'agents', 'challenge');
  r := oauth_exchange_code('code-2', 'linkagora-cli', NULL, 'challenge', 'a1', later, 'r1', later);
  PERFORM pg_temp.check(r->>'error' IS NULL AND r->>'agent_id' IS NULL AND r->>'scope' = 'agents', 'the code exchanges for an account-wide grant: ' || r::text);

  SELECT * INTO row FROM oauth_resolve_access_token('a1');
  PERFORM pg_temp.check(row.user_id = ada AND row.agent_id IS NULL AND row.scope = 'agents', 'the token resolves to the account and no agent');
  PERFORM pg_temp.check((SELECT last_used_at IS NOT NULL FROM oauth_grants WHERE id = row.grant_id), 'the grant is marked used');

  -- ── Rotation: the missing agent is not read as an agent gone ──────────
  r := oauth_rotate_refresh('r1', 'linkagora-cli', 'a2', later, 'r2', later);
  PERFORM pg_temp.check(r->>'error' IS NULL, 'an account-wide refresh token rotates: ' || r::text);
  PERFORM pg_temp.check((SELECT revoked_at IS NULL FROM oauth_grants WHERE id = (r->>'grant_id')::uuid), 'rotation leaves the grant alive');
  SELECT * INTO row FROM oauth_resolve_access_token('a2');
  PERFORM pg_temp.check(row.user_id = ada, 'the new token resolves');
  r := oauth_rotate_refresh('r1', 'linkagora-cli', 'a3', later, 'r3', later);
  PERFORM pg_temp.check(r->>'reason' = 'token_already_rotated', 'a retry within a minute is refused, grant kept');

  -- ── Revoked means refused, for access and refresh alike ───────────────
  UPDATE oauth_grants SET revoked_at = now() WHERE id = row.grant_id;
  PERFORM pg_temp.check(NOT EXISTS (SELECT FROM oauth_resolve_access_token('a2')), 'a revoked sign-in resolves to nobody');
  r := oauth_rotate_refresh('r2', 'linkagora-cli', 'a4', later, 'r4', later);
  PERFORM pg_temp.check(r->>'reason' = 'grant_revoked', 'a revoked sign-in cannot renew');

  -- ── Expired ───────────────────────────────────────────────────────────
  PERFORM pg_temp.issue('code-3', ada, NULL, 'agents', 'challenge');
  r := oauth_exchange_code('code-3', 'linkagora-cli', NULL, 'challenge', 'a5', now() - interval '1 second', 'r5', later);
  PERFORM pg_temp.check(NOT EXISTS (SELECT FROM oauth_resolve_access_token('a5')), 'an expired access token resolves to nobody');

  -- ── One-agent grants behave exactly as before ─────────────────────────
  PERFORM pg_temp.issue('code-4', ada, agent, 'agent', 'challenge');
  r := oauth_exchange_code('code-4', 'linkagora-cli', NULL, 'challenge', 'a6', later, 'r6', later);
  PERFORM pg_temp.check((r->>'agent_id')::uuid = agent, 'a one-agent grant keeps its agent');
  SELECT * INTO row FROM oauth_resolve_access_token('a6');
  PERFORM pg_temp.check(row.agent_id = agent AND row.scope = 'agent', 'a one-agent token resolves to its agent');

  UPDATE agents SET user_id = bob WHERE id = agent;
  PERFORM pg_temp.check(NOT EXISTS (SELECT FROM oauth_resolve_access_token('a6')), 'a one-agent token stops when the agent changes hands');
  r := oauth_rotate_refresh('r6', 'linkagora-cli', 'a7', later, 'r7', later);
  PERFORM pg_temp.check(r->>'reason' = 'agent_not_owned', 'and cannot renew');
  PERFORM pg_temp.issue('code-5', ada, agent, 'agent', 'challenge');
  r := oauth_exchange_code('code-5', 'linkagora-cli', NULL, 'challenge', 'a8', later, 'r8', later);
  PERFORM pg_temp.check(r->>'reason' = 'agent_not_owned', 'and a code for it cannot be exchanged');

  -- ── An account-wide grant outlives one agent; ownership is the request's question ──
  PERFORM pg_temp.issue('code-6', ada, NULL, 'agents', 'challenge');
  r := oauth_exchange_code('code-6', 'linkagora-cli', NULL, 'challenge', 'a9', later, 'r9', later);
  DELETE FROM agents WHERE id = agent;
  PERFORM pg_temp.check(EXISTS (SELECT FROM oauth_resolve_access_token('a9')), 'deleting an agent does not end the account''s sign-in');

  -- ── Deleting the account ends everything ──────────────────────────────
  DELETE FROM auth.users WHERE id = ada;
  PERFORM pg_temp.check(NOT EXISTS (SELECT FROM oauth_resolve_access_token('a9')), 'deleting the account ends its sign-ins');

  -- ── Never reachable from the public API ───────────────────────────────
  PERFORM pg_temp.check(NOT has_function_privilege('anon', 'oauth_resolve_access_token(text)', 'execute'), 'anon cannot resolve tokens');
  PERFORM pg_temp.check(NOT has_function_privilege('authenticated', 'oauth_resolve_access_token(text)', 'execute'), 'authenticated cannot resolve tokens');
  PERFORM pg_temp.check(has_function_privilege('service_role', 'oauth_resolve_access_token(text)', 'execute'), 'the server can');
  PERFORM pg_temp.check(NOT has_function_privilege('anon', 'oauth_exchange_code(text,text,text,text,text,timestamptz,text,timestamptz)', 'execute'), 'anon cannot exchange codes');
  PERFORM pg_temp.check(NOT has_table_privilege('anon', 'oauth_grants', 'select'), 'anon cannot read grants');
END;
$$;

ROLLBACK;

\echo 'ok - 019_cli_account_grants'
