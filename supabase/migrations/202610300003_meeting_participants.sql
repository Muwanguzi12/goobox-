create table if not exists gb_meeting_participants (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references gb_meetings(id) on delete cascade,
  user_id     uuid not null references profiles(id),
  status      text not null default 'invited', -- invited | joined | declined
  created_at  timestamptz not null default now()
);

create index if not exists gb_meeting_participants_meeting_idx on gb_meeting_participants(meeting_id);
create index if not exists gb_meeting_participants_user_idx on gb_meeting_participants(user_id);
