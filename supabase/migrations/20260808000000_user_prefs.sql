-- Folders, pins, filings and app settings. These were localStorage in the Electron app; on web
-- that would strand a user's folders in one browser, and the shuffled-10 board cannot count
-- folders from 10 loaded rows.
create table if not exists public.user_prefs (
  user_id    uuid not null references auth.users(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.user_prefs enable row level security;

create policy "own prefs" on public.user_prefs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
