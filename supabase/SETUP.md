# Supabase setup

The LeiTech app uses Supabase Auth and Postgres. The publishable key in
`supabase-config.js` is intended for browser use; never put a secret or
`service_role` key in the web app.

## 1. Apply the database migration

In the Supabase project, open **SQL Editor**, paste and run `schema.sql`.
The migration creates tenant accounts, associates existing producers,
deliveries, and settings with the first tenant that completes setup, enables
row-level security, and adds tenant-scoped settings and backup functions.
Review the SQL and make a database backup before running it on an installation
with valuable data. Existing records are preserved and are not shared with
subsequent tenants.

## 2. Configure authentication URLs

In **Authentication → URL Configuration**, set the production site as the
Site URL and add the production URL to the Redirect URLs allow-list:

```text
https://jotaag15-hash.github.io/leitech/
https://jotaag15-hash.github.io/leitech/?welcome=1
https://jotaag15-hash.github.io/leitech/?recovery=1
```

Keep email confirmation enabled. A new tenant is created only after the
account's email is confirmed. The confirmation and recovery links return to
the LeiTech site.

## 3. Configure WhatsApp password recovery

The recovery screen can send a one-time code through the WhatsApp Cloud API.
Create and approve an authentication template with a copy-code button, and
ensure users have opted in to receive WhatsApp messages. The message body and
copy-code button must both accept the six-digit code. Then link the Supabase
CLI to this project. Keep the credentials in Supabase secrets; never add them
to the website:

See [Meta's copy-code authentication template guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/copy-code-button-authentication-templates) for template setup.

Set the template's displayed code expiration to 10 minutes and its message
delivery time-to-live to no more than 600 seconds, matching the server's code
expiry.

```text
supabase link --project-ref lcurepbqfdnqbaaocdtw
supabase secrets set RECOVERY_CODE_PEPPER=<random-secret>
supabase secrets set ALLOWED_ORIGINS=https://jotaag15-hash.github.io,https://appassets.androidplatform.net,null
supabase secrets set WHATSAPP_ACCESS_TOKEN=<meta-access-token>
supabase secrets set WHATSAPP_PHONE_NUMBER_ID=<phone-number-id>
supabase secrets set WHATSAPP_TEMPLATE_NAME=<approved-template-name>
supabase secrets set WHATSAPP_TEMPLATE_LANGUAGE=<template-language-code>
supabase secrets set WHATSAPP_GRAPH_API_VERSION=<supported-graph-api-version>
supabase functions deploy whatsapp-password-recovery --no-verify-jwt
```

Generate a unique, high-entropy `RECOVERY_CODE_PEPPER`. Add any additional
trusted web origins to `ALLOWED_ORIGINS` as comma-separated origins. The
approved template must accept the code as its first body and button parameter.
Recovery codes expire after 10 minutes, allow at most five guesses, and can be
requested once per minute and up to five times per hour for a registered
WhatsApp number. The `schema.sql` migration creates the private challenge
table and service-role RPCs used by this function. JWT verification is
disabled for this endpoint because password recovery happens before login; the
function validates each request and uses the service-role key only on the
server. The `null` origin is required by the Android WebView, which loads the
app from a local `file://` asset. Delivery failures are recorded in the
Supabase function logs; users can select e-mail recovery if a WhatsApp code
does not arrive.

## 4. Publish the site

The website sources and deployment workflow are at the repository root. In the
`leitech` GitHub repository, select **Settings → Pages → Build and deployment
→ GitHub Actions**. Pushing the web app to the configured branch publishes it
at `https://jotaag15-hash.github.io/leitech/`.

Do not publish the full Android project repository publicly. The web site's
publishable Supabase key is safe to include in the browser app; database
permissions and row-level security must remain enabled as defined in
`schema.sql`.

## Account and data behavior

Each dairy creates an account with a contact name, dairy name, email, WhatsApp
number, and an eight-digit numeric password. The email is the login. Recovery
can use the registered e-mail link or a one-time code sent to WhatsApp after
the WhatsApp Cloud API function has been configured and deployed. The
confirmed account owns a tenant; all producers, deliveries, settings, and
backups are restricted to that tenant.

The first tenant created after the migration receives existing database
records that do not yet have a `tenant_id`. Subsequent tenants start with
their own settings and empty producer and delivery lists. Existing accounts
without a tenant can sign in and complete their dairy profile once.
