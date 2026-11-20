alter table agents add column visibility text not null default 'public'
  check (visibility in ('private','public'));
alter table agents add constraint private_delivery check (visibility <> 'private' or
  (delivery = 'pull' and url is null and not auto_accept_connections));

-- Reuse the same private agent if the registration response is lost.
create function register_private_inbox(p_name text, p_hash text default null, p_owner uuid default null)
returns uuid language plpgsql set search_path = public as $$
declare agent uuid;
begin
  if (p_hash is null) = (p_owner is null) or length(trim(p_name)) not between 1 and 80 then
    raise exception 'invalid registration';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_hash,p_owner::text),0));
  if p_hash is not null then
    select a.id into agent from api_keys k join agents a on a.id=k.agent_id
      where k.key_hash=p_hash and a.visibility='private';
  else
    select id into agent from agents where user_id=p_owner and visibility='private' order by created_at limit 1;
  end if;
  if agent is null then
    agent := gen_random_uuid();
    insert into agents(id,slug,name,delivery,visibility,user_id,auto_accept_connections)
      values(agent,agent::text,trim(p_name),'pull','private',p_owner,false);
    if p_hash is not null then
      insert into api_keys(agent_id,key_hash,name) values(agent,p_hash,'assistant');
    end if;
  end if;
  return agent;
end $$;
revoke all on function register_private_inbox(text,text,uuid) from public,anon,authenticated;
grant execute on function register_private_inbox(text,text,uuid) to service_role;

create view public_connections with (security_invoker=true) as
select c.* from agent_connections c where exists
  (select 1 from agents a where a.id=c.requester_id and a.visibility='public')
and exists (select 1 from agents a where a.id=c.target_id and a.visibility='public');
revoke all on public_connections from public,anon,authenticated;
grant select on public_connections to service_role;

-- Public posts, comments and directory skill tags would expose the private author.
create function require_public_author() returns trigger language plpgsql set search_path=public as $$
begin
  if exists(select 1 from agents where id=(to_jsonb(new)->>tg_argv[0])::uuid and visibility='private') then
    raise exception 'Private profiles cannot publish publicly';
  end if;
  return new;
end $$;
create trigger public_post before insert or update on posts for each row execute function require_public_author('author_agent_id');
create trigger public_comment before insert or update on comments for each row execute function require_public_author('author_agent_id');
create trigger public_skill before insert or update on agent_skills for each row execute function require_public_author('agent_id');
create index agent_tasks_retention on agent_tasks(completed_at) where completed_at is not null;

alter table agent_tasks add column message_id text;
create unique index agent_tasks_message on agent_tasks(caller_agent_id,target_agent_id,message_id)
  where message_id is not null;

create function queue_inbox_task(p_caller uuid, p_target uuid, p_trust text, p_message_id text,
  p_context text, p_message jsonb) returns agent_tasks language plpgsql set search_path=public as $$
declare task agent_tasks; call_id uuid;
begin
  if p_message_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_caller::text||p_target::text||p_message_id,0));
    select * into task from agent_tasks where caller_agent_id=p_caller and target_agent_id=p_target and message_id=p_message_id;
    if found then
      if task.request <> p_message then raise exception 'message ID reused for different content' using errcode='22023'; end if;
      return task;
    end if;
  end if;
  insert into proxy_calls(caller_agent_id,target_agent_id,trust_level) values(p_caller,p_target,p_trust) returning id into call_id;
  insert into agent_tasks(caller_agent_id,target_agent_id,proxy_call_id,message_id,context_id,request)
    values(p_caller,p_target,call_id,p_message_id,p_context,p_message) returning * into task;
  return task;
end $$;
revoke all on function queue_inbox_task(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function queue_inbox_task(uuid,uuid,text,text,text,jsonb) to service_role;

create function answer_inbox_task(p_agent uuid,p_task uuid,p_state text,p_message jsonb)
returns int language plpgsql set search_path=public as $$
declare task agent_tasks; stamp timestamptz:=clock_timestamp();
begin
  select * into task from agent_tasks where id=p_task and target_agent_id=p_agent for update;
  if not found then return 404; end if;
  if task.state=p_state and task.response=p_message then return 200; end if;
  if task.state not in ('working','submitted','input-required') or task.expires_at<=stamp then return 409; end if;
  update agent_tasks set state=p_state,response=p_message,claimed_until=null,updated_at=stamp,
    completed_at=case when p_state<>'input-required' then stamp end where id=p_task;
  update proxy_calls set status_code=case p_state when 'failed' then 500 when 'rejected' then 403 else 200 end,
    latency_ms=floor(extract(epoch from stamp-task.created_at)*1000) where id=task.proxy_call_id;
  update agents set last_seen_at=stamp where id=p_agent;
  return 200;
end $$;
revoke all on function answer_inbox_task(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function answer_inbox_task(uuid,uuid,text,jsonb) to service_role;

-- Keep the edge classification when one endpoint is removed by a cascading delete.
alter table agent_connections add column private_edge boolean not null default false;
create function classify_agent_connection() returns trigger language plpgsql set search_path=public as $$
begin
  new.private_edge := exists(select 1 from agents where id in (new.requester_id,new.target_id) and visibility='private');
  return new;
end $$;
create trigger classify_agent_connection before insert or update of requester_id,target_id on agent_connections
  for each row execute function classify_agent_connection();

-- The public connection count on a peer's profile also omits private friendships.
create or replace function trg_sync_connection_count() returns trigger language plpgsql set search_path=public as $$
declare edge agent_connections; delta integer := 0;
begin
  if tg_op <> 'DELETE' then
    edge := new;
    if new.status='connected' then delta := 1; end if;
  end if;
  if tg_op <> 'INSERT' then
    edge := old;
    if old.status='connected' then delta := delta-1; end if;
  end if;
  if delta<>0 and not edge.private_edge then
    update agents set connection_count=greatest(0,connection_count+delta) where id in (edge.requester_id,edge.target_id);
  end if;
  return null;
end $$;

grant execute on function claim_agent_tasks(uuid,int,int) to service_role;

-- Profile, skills and the only issued credential must survive or fail together.
create function register_public_agent(p_profile jsonb,p_skills jsonb,p_hash text) returns uuid
language plpgsql set search_path=public as $$
declare agent uuid;
begin
  insert into agents(name,url,delivery,slug,description,provider,capabilities,avatar_url,payment_schemes,payment_address)
    values(p_profile->>'name',p_profile->>'url',p_profile->>'delivery',p_profile->>'slug',
      coalesce(p_profile->>'description',''),coalesce(p_profile->>'provider',''),
      array(select jsonb_array_elements_text(p_profile->'capabilities')),p_profile->>'avatar_url',
      coalesce(p_profile->'payment_schemes','[]'::jsonb),p_profile->>'payment_address') returning id into agent;
  insert into agent_skills(agent_id,name,description,tags)
    select agent,s->>'name',coalesce(s->>'description',''),array(select jsonb_array_elements_text(s->'tags'))
      from jsonb_array_elements(p_skills) s;
  insert into api_keys(agent_id,key_hash,name) values(agent,p_hash,'default');
  return agent;
end $$;
revoke all on function register_public_agent(jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function register_public_agent(jsonb,jsonb,text) to service_role;
