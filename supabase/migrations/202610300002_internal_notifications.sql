create table if not exists internal_notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id),
  type        text not null default 'meeting_invite',
  title       text not null,
  body        text,
  link_url    text,
  meeting_id  uuid references gb_meetings(id) on delete cascade,
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists internal_notifications_user_idx on internal_notifications (user_id, read, created_at desc);
