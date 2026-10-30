# Zammath Consulting

The Zamac Füds food storefront is served at `/` and `/zamac-fuds/`, including its catalogue, cart, checkout, authentication, catering and training flows. The Zammath Consulting corporate pages are available under `/zammath-consulting/`, `/about-us/`, `/our-services/`, `/our-businesses/`, and `/contact-us/`.

## Supabase setup

1. Run [`supabase_schema.sql`](supabase_schema.sql) in the Supabase SQL editor. It creates and seeds `users`, `products`, `cart_items`, `orders`, `order_items`, `bookings`, `training_programs`, `training_enrollments`, `training_payments`, `contact_messages`, and `newsletter_subscribers`, plus the transactional order, enrollment, and newsletter functions.
2. Enable Email and Google under Supabase Authentication providers. Email/password sign-in and account creation appear at checkout; if email confirmation is enabled, new customers confirm their address before signing in. Add local and deployed storefront return URLs, including `https://zammathconsulting.com/zamac-fuds/`, to the Supabase redirect allowlist. Create a Google OAuth web client and register your site origins plus the callback URL shown on the Supabase Google provider page.
3. Copy `.env.example` to `.env` and configure the environment variable names below. Do not put any server secret in browser code.
4. Install Node.js 24 from [nodejs.org](https://nodejs.org/) if it is not already installed. Copy `.env.example` to `.env` and fill in the Supabase values. Start the shop:

   ```sh
   npm start
   ```

5. Open http://localhost:8000 for the Zamac Füds storefront. The Zammath Consulting homepage is at http://localhost:8000/zammath-consulting/. The Node.js server serves the pages and `/api` routes together.

## Deploying to Vercel

The `api/` directory contains Node.js functions for the shop API. `package.json` selects Node.js 24 for Vercel deployments. Vercel provides that runtime during deployment. Vercel function storage is temporary, so configure Supabase before using the forms or checkout.

1. Run [`supabase_schema.sql`](supabase_schema.sql) in the Supabase SQL editor if you have not already.
2. In Vercel, open **Project Settings → Environment Variables** and add `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` from the Supabase project. Add `PAYSTACK_SECRET_KEY` to enable instalment payments, and the Mailgun variables if you want order confirmation emails.
3. Redeploy the Vercel project so it builds the Node.js functions and loads the environment variables.

The local SQLite database is not used by the Node.js server or Vercel functions.

## Runtime configuration and deployment notes

The API requires `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (or the supported legacy alias `SUPABASE_ANON_KEY`), and the server-only `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`). Optional variables are `MAILGUN_DOMAIN`, `MAILGUN_API_KEY`, `MAILGUN_FROM`, `PAYSTACK_SECRET_KEY`, `PUBLIC_BASE_URL`, and `PORT`. Set `PAYSTACK_CALLBACK_URL` for deployed training payments to `https://zammathconsulting.com/zamac-fuds/?training_payment=verify`. The mobile client uses `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `EXPO_PUBLIC_API_URL` from `mobile/.env.example`; only public Supabase values and the API base URL belong in that client configuration. Paystack and Mailgun requests have a 12-second timeout. Never expose the Supabase secret/service-role key, Paystack secret key, or Mailgun API key to the browser or mobile client.

The Node server serves only the storefront `/` and `/zamac-fuds/`, corporate pages `/zammath-consulting/`, `/about-us/`, `/our-services/`, `/our-businesses/`, `/contact-us/`, and files under `public/assets/` (plus the `/index.html` alias). Project source, hidden files, environment files, and other root files are not public routes. Put additional browser assets under `public/assets/`.

The explicit parent-page and storefront route allowlist applies to `server.js`. This repository has no root Vercel routing policy, so it has not been verified that Vercel's separate static-file serving blocks non-public project files. Review and test Vercel's deployment output and route rules independently before using that host; do not assume the Node allowlist governs Vercel static files.

Before deploying this version of checkout, run [`supabase_checkout_idempotency.sql`](supabase_checkout_idempotency.sql) after [`supabase_schema.sql`](supabase_schema.sql). It adds nullable retry-key/hash columns, a unique index, and the `create_order_idempotent` RPC. Existing orders are retained. Do not deploy the new checkout API before this migration is installed, or order creation will fail because the RPC is unavailable.

If Paystack initialization times out, the payment row remains in `initializing` with its generated transaction reference. The API intentionally blocks a new initialization for that row because the provider may have accepted the original request. Support must check that exact reference with Paystack before deciding what to do. Verify a successful transaction through the API; only after Paystack confirms it and the database records it is an instalment marked paid. An attempt confirmed unsuccessful can be released for retry by an authorized operator after confirming no active transaction remains. There is no automatic recovery yet. The code fallback return URL is `/zamac-fuds/?training_payment=verify`; the deployed `PAYSTACK_CALLBACK_URL` should be set to `https://zammathconsulting.com/zamac-fuds/?training_payment=verify`.

Public forms validate inputs, use server-checked honeypot fields, and disable duplicate submissions in the client. Newsletter storage is naturally duplicate-safe by email. There is no shared API rate limiter: an in-memory counter would not work across serverless instances. Add a shared edge/WAF limit or a database-backed atomic limiter before relying on these endpoints under public abuse.

Orders use Supabase's catalog prices and are saved with their item snapshots in one database transaction. Mailgun runs after that commit. Booking requests, contact messages, course enrollments, and two scheduled training instalments are saved to their own tables. When Paystack is configured, each training instalment uses a separate hosted payment and the server verifies its reference and amount before marking it paid. Without a Paystack key, the enrollment request is still saved and no payment is charged. The course and materials prices shown in the demo are sample prices to replace with approved fees.

Google login, form submissions, orders, and training payments require the Supabase configuration above.

Newsletter signups are stored in `newsletter_subscribers` in Supabase. Apply the updated schema before using the newsletter form; repeated subscriptions to the same email are accepted without creating duplicate rows.

## Company profile content needed

The corporate pages intentionally mark missing information instead of making claims. Before replacing those placeholders, provide Zammath Consulting's approved company introduction and positioning, service names and descriptions (including qualifications or limitations), mission statement, vision statement, official contact email and phone, office address/service area if publishable, and the approved names and descriptions of any additional businesses. Zamac Füds is the only business currently named in the site content.
# shop-website
# shop-website
