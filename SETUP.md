# DK Boxing Fitness — Setup Guide

About 20 minutes, done once. You need the Supabase project you already have, and a free Netlify account.

## What's in this folder

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Your Supabase address and public key (already filled in) |
| `vendor/supabase.js` | The Supabase library, saved locally so the app loads fast |
| `manifest.json`, `sw.js`, `icons/`, `logo.jpg` | What makes it installable on a phone |
| `supabase/` | The three database files, used in Part 1 |

---

## Part 1 — Database (Supabase)

For each file below: open Supabase, go to **SQL Editor → New query**, paste the whole file, and click **Run**.

1. **`1_remove_old_version.sql`** deletes the old version's tables. Run it only once, and only because the old app never held real data.
2. **`2_create_database.sql`** creates the new tables, security rules, and the private receipt storage.
3. **Create the coach's login.** Go to **Authentication → Users → Add user → Create new user**. Enter his email and a password, and tick **Auto Confirm User**.
4. **`3_make_coach.sql`**: change `coach@example.com` to his email, then run it. The result should show one row with his email. If it shows nothing, the email doesn't match the login from step 3.
5. **Turn off public sign-ups.** Go to **Authentication → Sign In / Providers** and switch off **Allow new users to sign up**. The security rules already block anyone who isn't the coach, so this is an extra layer.
6. *(Optional)* Delete the old **payment-slips** bucket under **Storage**.

## Part 2 — Put it online (Netlify, free)

1. Sign up at **netlify.com**.
2. Go to **Sites** and drag this whole folder onto the upload area. You'll get a link like `random-name-123.netlify.app`.
3. To get a nicer name, go to **Site configuration → Change site name** and pick something like `dkboxing`. The link becomes `dkboxing.netlify.app`.
4. Back in Supabase, go to **Authentication → URL Configuration** and set **Site URL** to that link.

## Part 3 — Install on the coach's phone

Open the link on his phone and sign in with the **Coach** button once.

- **Android (Chrome):** tap **Install app** on the dashboard, or use the **⋮** menu and choose **Add to Home screen**.
- **iPhone (Safari):** tap the **Share** button, then **Add to Home Screen**.

It opens full-screen with the DK logo, and he stays signed in.

## Part 4 — Share with members

Send the link in the club's WhatsApp group. Members see the roster and each boxer's ratings and session notes. They never see fees, attendance, or personal details, and they can't change anything.

---

## Everyday use (for the coach)

- **New member:** go to **Members → + Add member**. Leave both payment boxes ticked if they're paying the admission fee and first month today.
- **Members who joined before the app:** set their real **Joined on** date and untick the payment boxes. Then record any payments they've made in the **Fees** tab (you can pick past months).
- **Attendance:** tap **Mark present** for each member. Use the date box to fix a past day.
- **Fees:** tap **Mark paid**. A receipt photo is optional. If they haven't paid admission yet, the form offers to record it too. **Undo** reverses a mistake.
- **Progress:** pick a boxer, change the ratings that moved, write a note, then tap **Save session**. Deleting a session puts the old ratings back.
- **Someone leaves:** use **Archive** instead of delete. Their history stays in the records, they disappear from the roster, and you can restore them later.
- **Prices change:** tap **⚙︎ Fees** on the dashboard. Payments already recorded keep their old amounts.

## Updating the app later

Change the files, then in Netlify go to **Deploys** and drag the folder in again. Phones pick up the new version the next time the app opens.
