begin;
alter table public.before_call_private_bookings alter column scheduled_at drop not null;
create or replace function public.before_call_record_booking(
  p_id uuid, p_appointment text, p_calendar text, p_name text,
  p_scheduled timestamptz, p_expires bigint
) returns table(id uuid, expires_epoch bigint)
language sql security invoker set search_path = '' as $$
  with b as (
    insert into public.before_call_private_bookings as target
      (id, appointment_id, calendar_id, contact_name, scheduled_at, expires_epoch)
      values (p_id,p_appointment,p_calendar,p_name,p_scheduled,p_expires)
      on conflict (calendar_id, appointment_id) do update set scheduled_at=coalesce(excluded.scheduled_at,target.scheduled_at), contact_name=excluded.contact_name
      returning target.id, target.expires_epoch
  ), event_created as (
    insert into public.before_call_private_outbox (booking_id,kind)
      select b.id,'booked' from b on conflict (booking_id,kind) do nothing
  ) select b.id,b.expires_epoch from b;
$$;

commit;
