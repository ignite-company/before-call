begin;
create table public.before_call_private_bookings (
  id uuid primary key,
  calendar_id text not null,
  appointment_id text not null,
  contact_name text not null check (char_length(contact_name) between 1 and 140),
  scheduled_at timestamptz not null,
  expires_epoch bigint not null,
  created_at timestamptz not null default now(),
  unique (calendar_id, appointment_id)
);
create table public.before_call_private_outbox (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.before_call_private_bookings(id) on delete cascade,
  kind text not null check (kind in ('booked', 'started', 'unlocked')),
  happened_at timestamptz not null default now(),
  sent_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  unique (booking_id, kind)
);
create index before_call_pending_idx on public.before_call_private_outbox(happened_at) where sent_at is null;
alter table public.before_call_private_bookings enable row level security;
alter table public.before_call_private_outbox enable row level security;
revoke all on public.before_call_private_bookings, public.before_call_private_outbox from public, anon, authenticated;
grant select, insert, update on public.before_call_private_bookings, public.before_call_private_outbox to service_role;

create function public.before_call_record_booking(
  p_id uuid, p_appointment text, p_calendar text, p_name text,
  p_scheduled timestamptz, p_expires bigint
) returns table(id uuid, expires_epoch bigint)
language sql security invoker set search_path = '' as $$
  with b as (
    insert into public.before_call_private_bookings as target
      (id, appointment_id, calendar_id, contact_name, scheduled_at, expires_epoch)
      values (p_id,p_appointment,p_calendar,p_name,p_scheduled,p_expires)
      on conflict (calendar_id, appointment_id) do update set scheduled_at=excluded.scheduled_at, contact_name=excluded.contact_name
      returning target.id, target.expires_epoch
  ), event_created as (
    insert into public.before_call_private_outbox (booking_id,kind)
      select b.id,'booked' from b on conflict (booking_id,kind) do nothing
  ) select b.id,b.expires_epoch from b;
$$;

create function public.before_call_record_event(p_booking uuid,p_kind text)
returns boolean language sql security invoker set search_path = '' as $$
  with added as (
    insert into public.before_call_private_outbox (booking_id,kind)
      select b.id,p_kind from public.before_call_private_bookings b
      where b.id=p_booking and p_kind in ('started','unlocked') and b.expires_epoch>extract(epoch from now())
      on conflict (booking_id,kind) do nothing returning id
  ) select exists(select 1 from added);
$$;

create function public.before_call_pending_notifications()
returns table(event_id uuid,kind text,happened_at timestamptz, booking_id uuid,contact_name text,scheduled_at timestamptz,expires_epoch bigint)
language sql security invoker set search_path = '' as $$
  select o.id,o.kind,o.happened_at,b.id,b.contact_name,b.scheduled_at,b.expires_epoch
  from public.before_call_private_outbox o join public.before_call_private_bookings b on b.id=o.booking_id
  where o.sent_at is null and b.expires_epoch>extract(epoch from now())
  order by o.happened_at, o.id limit 40;
$$;
create function public.before_call_lease_notification(p_lease uuid)
returns table(event_id uuid,kind text,happened_at timestamptz,booking_id uuid,contact_name text,scheduled_at timestamptz,expires_epoch bigint)
language sql security invoker set search_path = '' as $$
  with pick as (
    select o.id
    from public.before_call_private_outbox o join public.before_call_private_bookings b on b.id=o.booking_id
    where o.sent_at is null and coalesce(o.lease_until,'-infinity')<now() and b.expires_epoch>extract(epoch from now())
    order by o.happened_at,o.id limit 1 for update of o skip locked
  ), leased as (
    update public.before_call_private_outbox as o set lease_until=now()+interval '90 seconds',lease_token=p_lease
    from pick where o.id=pick.id returning o.*
  ) select o.id,o.kind,o.happened_at,b.id,b.contact_name,b.scheduled_at,b.expires_epoch
  from leased o join public.before_call_private_bookings b on b.id=o.booking_id;
$$;
create function public.before_call_ack_notification(p_event uuid,p_lease uuid)
returns boolean language sql security invoker set search_path = '' as $$
  with marked as (
    update public.before_call_private_outbox set sent_at=now() where id=p_event and sent_at is null and (p_lease is null or lease_token=p_lease) returning id
  ) select exists(select 1 from marked);
$$;
revoke all on function public.before_call_record_booking(uuid,text,text,text,timestamptz,bigint), public.before_call_record_event(uuid,text), public.before_call_pending_notifications(), public.before_call_lease_notification(uuid), public.before_call_ack_notification(uuid,uuid) from public, anon, authenticated;
grant execute on function public.before_call_record_booking(uuid,text,text,text,timestamptz,bigint), public.before_call_record_event(uuid,text), public.before_call_pending_notifications(), public.before_call_lease_notification(uuid), public.before_call_ack_notification(uuid,uuid) to service_role;
create table public.before_call_private_config (
  singleton boolean primary key default true check(singleton),
  rpc_key_sha256 text not null check(rpc_key_sha256 ~ '^[a-f0-9]{64}$')
);
alter table public.before_call_private_config enable row level security;
revoke all on public.before_call_private_config from public, anon, authenticated;

-- Only a high-entropy, app-specific secret can get through this fixed RPC dispatcher.
-- Its digest is set independently, never committed.  The four data RPCs stay private.
create function public.before_call_private_gateway(p_action text,p_payload jsonb,p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_key is null or length(p_key) not between 32 and 128 or not exists (
    select 1 from public.before_call_private_config c
    where c.singleton and c.rpc_key_sha256 = encode(sha256(convert_to(p_key,'UTF8')),'hex')
  ) then
    raise sqlstate '42501' using message='Unauthorized';
  end if;

  case p_action
    when 'before_call_record_booking' then
      select coalesce(jsonb_agg(r),'[]'::jsonb) into result
      from public.before_call_record_booking(
        (p_payload->>'p_id')::uuid,p_payload->>'p_appointment',p_payload->>'p_calendar',p_payload->>'p_name',
        (p_payload->>'p_scheduled')::timestamptz,(p_payload->>'p_expires')::bigint) r;
    when 'before_call_record_event' then
      select to_jsonb(public.before_call_record_event((p_payload->>'p_booking')::uuid,p_payload->>'p_kind')) into result;
    when 'before_call_pending_notifications' then
      select coalesce(jsonb_agg(r),'[]'::jsonb) into result from public.before_call_pending_notifications() r;
    when 'before_call_lease_notification' then
      select coalesce(jsonb_agg(r),'[]'::jsonb) into result
      from public.before_call_lease_notification((p_payload->>'p_lease')::uuid) r;
    when 'before_call_ack_notification' then
      select to_jsonb(public.before_call_ack_notification((p_payload->>'p_event')::uuid,(p_payload->>'p_lease')::uuid)) into result;
    else raise sqlstate '42501' using message='Unauthorized';
  end case;
  return result;
end;
$$;
revoke all on function public.before_call_private_gateway(text,jsonb,text) from public, anon, authenticated;
grant execute on function public.before_call_private_gateway(text,jsonb,text) to anon;
commit;
