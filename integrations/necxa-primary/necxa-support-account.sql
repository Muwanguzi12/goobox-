-- Run on the NECXA primary project (lzdtrmjcwzalckszdzpt).
--
-- STEP 1 (dashboard, not SQL):
--   Authentication -> Users -> Add user -> "Create new user"
--   email: support@necxa.uk   (any address you control; it is never used to log in)
--   password: a long random string you throw away
--   tick "Auto Confirm User"
--   Copy the new user's UID — that is SUPPORT_ACCOUNT_ID.
--
-- STEP 2: give it a profile, so chat shows "Necxa Support" instead of a blank sender.
-- Replace the UUID below. If your profiles table has other NOT NULL columns
-- (username, etc.) add them here — I haven't seen that schema.

-- If a trigger already created a profile row on signup, this updates it;
-- otherwise it inserts one.
insert into public.profiles (id, full_name, is_verified)
values ('00000000-0000-0000-0000-000000000000', 'Necxa Support', true)
on conflict (id) do update
  set full_name   = excluded.full_name,
      is_verified = excluded.is_verified;

-- Optional: set an avatar once you've uploaded the logo somewhere public
-- update public.profiles set avatar_url = 'https://.../logo.png'
-- where id = '00000000-0000-0000-0000-000000000000';
