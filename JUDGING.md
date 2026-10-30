# Goobox — Judging and demo setup

Goobox is a customer-support application in the Necxa ecosystem. This repository contains the web client, Supabase Edge Functions, and selected incremental database migrations.

## Safe evaluation

- Use a dedicated development Supabase project for judging.
- Use synthetic users, tickets, messages, and attachments only.
- Do not connect the judging environment to Necxa production systems or expose customer information.
- Keep service-role keys, OAuth secrets, shared bridge secrets, and provider credentials in server-side secret managers. Never commit them or put them in browser code.
- Gmail, LiveKit, Pesapal, and the private Necxa bridge require separately configured services and credentials. They are optional for a basic code review.

## Database limitation

The migrations in this repository are incremental. They depend on existing Goobox tables and are not a complete database bootstrap. Review them against a disposable development database before applying them.

## Credential history

This is a public repository. If a real credential was ever committed, rotate it with its provider. Deleting a file in a later commit does not remove it from Git history.
