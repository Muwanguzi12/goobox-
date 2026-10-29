alter table support_tickets
  add column if not exists necxa_user_id uuid,
  add column if not exists verified boolean not null default false;

create index if not exists support_tickets_necxa_user_idx on support_tickets (necxa_user_id);
