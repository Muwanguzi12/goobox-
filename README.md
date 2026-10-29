# Goobox

This repository contains the Goobox portal, its Supabase Edge Functions, and
the supplied database migrations.

## Layout

- `index.html`, the preview pages, and `_redirects` are the static site.
- `supabase/functions/` contains Goobox Edge Functions. Deploy them to the
  Goobox Supabase project using the names of their directories.
- `supabase/migrations/` contains timestamped migrations. These are additive
  migrations for an existing Goobox database; they do not create the full
  application schema from scratch.
- `integrations/necxa-primary/` contains files that belong to the separate
  NECXA primary Supabase project. Do not deploy them to Goobox.

The functions require the corresponding secrets to be configured in their
target Supabase project. No secret values are included in this repository.

## License

Goobox is multi-licensed under MPL-2.0, MIT, or Apache-2.0. Recipients may
choose one of these licenses; see `LICENSE` and the corresponding full text
files for the terms.
