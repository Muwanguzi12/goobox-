-- ==============================================================================
-- GOOBOX <-> NECXA BRIDGE — safe version
-- Run on the GOOBOX project (anregykcgolpgxecfxej) only.
--
-- Kept from the original: source constraint, bridge columns, indexes, updated_at
-- trigger, ticket-attachments bucket.
-- Changed: no policy grants anon access to ticket data. Customers never touch
-- these tables directly — the portal and the Necxa app go through edge
-- functions (create-support-ticket, track-tickets) which use the service role.
-- Left out: necxa_filters, gift_notifications, user-tryons / necxa-filters /
-- gift-icons buckets (these look like Necxa-app features, not Goobox).
--
-- DEPLOY ORDER: deploy track-tickets + the updated index.html FIRST, then run
-- this. Once RLS is tightened, the old portal tracker (which queried the table
-- directly as anon) stops working.
-- ==============================================================================

BEGIN;

-- 1. Source values (Necxa in-app tickets, moderation reports, mobile, api)
ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS support_tickets_source_check;
ALTER TABLE public.support_tickets ADD CONSTRAINT support_tickets_source_check
  CHECK (source IN ('portal','gmail','manual','report','in_app','necxa','api','mobile'));

-- 2. Bridge columns
ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS necxa_user_id  UUID,
  ADD COLUMN IF NOT EXISTS customer_name  TEXT,
  ADD COLUMN IF NOT EXISTS customer_phone TEXT,
  ADD COLUMN IF NOT EXISTS verified       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();

-- 3. Indexes
CREATE INDEX IF NOT EXISTS support_tickets_necxa_user_idx
  ON public.support_tickets (necxa_user_id) WHERE necxa_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_tickets_status_updated_idx
  ON public.support_tickets (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_customer_email_idx
  ON public.support_tickets (customer_email);
CREATE INDEX IF NOT EXISTS support_tickets_source_idx
  ON public.support_tickets (source);
CREATE INDEX IF NOT EXISTS ticket_messages_ticket_created_idx
  ON public.ticket_messages (ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ticket_replies_ticket_created_idx
  ON public.ticket_replies (ticket_id, created_at DESC);

-- 4. updated_at trigger
CREATE OR REPLACE FUNCTION public.set_support_ticket_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS support_tickets_set_updated_at ON public.support_tickets;
CREATE TRIGGER support_tickets_set_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.set_support_ticket_updated_at();

-- 5. RLS — signed-in Goobox agents only. Service role (edge functions) bypasses RLS.
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_replies  ENABLE ROW LEVEL SECURITY;

-- Remove the open policies if they were ever created
DROP POLICY IF EXISTS "Allow select support_tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Allow insert support_tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Allow update support_tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Allow select ticket_messages" ON public.ticket_messages;
DROP POLICY IF EXISTS "Allow insert ticket_messages" ON public.ticket_messages;
DROP POLICY IF EXISTS "Allow select ticket_replies"  ON public.ticket_replies;
DROP POLICY IF EXISTS "Allow insert ticket_replies"  ON public.ticket_replies;

DROP POLICY IF EXISTS "Agents read support_tickets"   ON public.support_tickets;
DROP POLICY IF EXISTS "Agents insert support_tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Agents update support_tickets" ON public.support_tickets;
CREATE POLICY "Agents read support_tickets"   ON public.support_tickets FOR SELECT TO authenticated USING (true);
CREATE POLICY "Agents insert support_tickets" ON public.support_tickets FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Agents update support_tickets" ON public.support_tickets FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Agents read ticket_messages"   ON public.ticket_messages;
DROP POLICY IF EXISTS "Agents insert ticket_messages" ON public.ticket_messages;
CREATE POLICY "Agents read ticket_messages"   ON public.ticket_messages FOR SELECT TO authenticated USING (true);
CREATE POLICY "Agents insert ticket_messages" ON public.ticket_messages FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Agents read ticket_replies"   ON public.ticket_replies;
DROP POLICY IF EXISTS "Agents insert ticket_replies" ON public.ticket_replies;
CREATE POLICY "Agents read ticket_replies"   ON public.ticket_replies FOR SELECT TO authenticated USING (true);
CREATE POLICY "Agents insert ticket_replies" ON public.ticket_replies FOR INSERT TO authenticated WITH CHECK (true);

-- 6. ticket-attachments bucket: public read (links are shown in tickets), but
-- anonymous uploads limited to images, 10 MB, inside the portal-screenshots/ folder.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('ticket-attachments', 'ticket-attachments', true, 10485760,
        ARRAY['image/jpeg','image/png','image/webp','image/gif'])
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif'];

DROP POLICY IF EXISTS "Public ticket-attachments select" ON storage.objects;
CREATE POLICY "Public ticket-attachments select" ON storage.objects
  FOR SELECT USING (bucket_id = 'ticket-attachments');

DROP POLICY IF EXISTS "Public ticket-attachments upload" ON storage.objects;
CREATE POLICY "Public ticket-attachments upload" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'ticket-attachments'
    AND (storage.foldername(name))[1] = 'portal-screenshots'
  );

COMMIT;

-- Verify afterwards. Any policy listing roles {public} or {anon} with qual = true
-- on these tables means data is still open — policies from other migrations
-- are OR'd together, so drop any extras you find.
-- select tablename, policyname, roles, cmd, qual
-- from pg_policies
-- where tablename in ('support_tickets','ticket_messages','ticket_replies')
-- order by tablename, policyname;
