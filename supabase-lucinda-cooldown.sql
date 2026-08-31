-- Limita pedidos repetidos do mesmo nome e telefone a um a cada 24 horas.
-- Execute uma vez no SQL Editor do projeto Supabase da Lucinda.

create index if not exists lucinda_leads_phone_created_at_idx
  on public.lucinda_leads_contacts (visitor_phone, created_at desc);

create or replace function public.enforce_lucinda_lead_cooldown()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.lucinda_leads_contacts
    where visitor_phone = new.visitor_phone
      and lower(regexp_replace(trim(visitor_name), '\s+', ' ', 'g')) =
          lower(regexp_replace(trim(new.visitor_name), '\s+', ' ', 'g'))
      and created_at > now() - interval '24 hours'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'CONTACT_COOLDOWN_24H';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_lucinda_lead_cooldown() from public, anon, authenticated;

drop trigger if exists lucinda_lead_cooldown_trigger on public.lucinda_leads_contacts;
create trigger lucinda_lead_cooldown_trigger
before insert on public.lucinda_leads_contacts
for each row
execute function public.enforce_lucinda_lead_cooldown();
