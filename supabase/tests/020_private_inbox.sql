-- Run after migrations. The transaction leaves no test profiles on success.
begin;
do $$
declare alice uuid; bob uuid; task agent_tasks; retried agent_tasks; connection uuid;
  payload jsonb := '{"role":"user","parts":[{"text":"hello"}]}';
  answer jsonb := '{"role":"agent","parts":[{"text":"received"}]}';
begin
  alice := register_private_inbox('Alice',gen_random_uuid()::text);
  bob := register_private_inbox('Bob','test-private-inbox');
  assert bob=register_private_inbox('Bob','test-private-inbox');
  insert into agent_connections(requester_id,target_id,status) values(alice,bob,'connected') returning id into connection;
  assert not exists(select 1 from public_connections where id=connection);
  assert (select connection_count=0 from agents where id=bob);
  task := queue_inbox_task(alice,bob,'connected','message-1','ctx',payload);
  retried := queue_inbox_task(alice,bob,'connected','message-1','ctx',payload);
  assert task.id=retried.id;
  assert (select count(*)=1 from proxy_calls where caller_agent_id=alice);
  assert (select count(*)=1 from claim_agent_tasks(bob,1,30));
  assert (select count(*)=0 from claim_agent_tasks(bob,1,30));
  assert answer_inbox_task(alice,task.id,'completed',answer)=404;
  assert answer_inbox_task(bob,task.id,'completed',answer)=200;
  assert answer_inbox_task(bob,task.id,'completed',answer)=200;
  assert answer_inbox_task(bob,task.id,'failed',answer)=409;
  assert (select status_code=200 from proxy_calls where id=task.proxy_call_id);
  assert not has_function_privilege('anon','register_private_inbox(text,text,uuid)','execute');
  assert not has_table_privilege('anon','public_connections','select');
end $$;
rollback;
