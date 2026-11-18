# Ice Fishing Tournament Tracker

Live site: https://twinrig.github.io/ice-fishing-tracker/

A static web app (GitHub Pages) backed by Supabase (Postgres + Auth + Realtime).
Several gate laptops, weigh stations, an admin laptop and a big-screen TV share the same live data.

| File | What it is |
| --- | --- |
| `index.html` | Page layout |
| `app.js` | All app logic (auth, offline queue, realtime, leaderboards, badges, CSV) |
| `config.js` | Supabase URL + **publishable** key (safe to be public) |
| `supabase/migrations/` | Database schema, security rules and functions |

## How it works

**Who can do what** (enforced in the database with Row Level Security, not just hidden buttons):

| Role | Can do |
| --- | --- |
| `admin` | Everything: tournaments, species, leaderboards, imports, exports, corrections |
| `gate` | Register walk-ups, import participants, find people and print badge cards |
| `weigh` | Record weigh-ins and void their own mistakes |
| `screen` | Read-only staff view (big screen / leaderboard) |
| public (not signed in) | Leaderboard only: names, placements, species and weight (lbs) of each counted fish. No emails, phones, ages or ticket types. |

A signed-in account with no role in `staff_roles` can see nothing.

**Live updates.** Staff stations (gate/weigh/admin) get changes instantly through Supabase Realtime.
The public leaderboard and the big screen don't use Realtime (the free plan allows 200 live connections).
Instead they call one small function, `get_leaderboard`, every 45 s (public) or 15 s (TV). If nothing changed
since the last call, the reply is about 30 bytes, so several hundred phones watching all day stays well inside the
free plan's 5 GB/month of data transfer.

**Offline.** Gate and weigh writes are saved on the laptop first (a queue in the browser's storage) and sent
when the connection is back. The bar under the title shows Online/Offline and how many changes are waiting.
Every record gets its ID on the laptop, so a retry can never create a duplicate. Each gate laptop reserves
25 badge numbers ahead of time, so walk-up badges still print with a real `yyyy_#####` number while offline.
The participant list is cached so weigh stations can still look people up offline.

Things to know:
- A laptop must have been online and signed in at least once (that day) to have the participant list cached.
- If a change is rejected by the server (for example, no permission), it shows as "failed" in the sync
  queue, where you can retry or discard it.
- Reserved but unused badge numbers leave gaps in the numbering. That's harmless.

**Public leaderboard link (no sign-in needed):** `https://twinrig.github.io/ice-fishing-tracker/?t=<tournament id>&view=leaderboard`.
It opens a leaderboard-only page (tournament name, last-updated time, three buttons: **Overall**, **Youth Divisions**,
**Species**) with no staff tabs, mode picker, tournament picker or sign-in button – even on a signed-in staff laptop.
The selected button is kept in the link (`…&view=leaderboard#board=species`) so people can share it. The page
refreshes every 45 s. Older links (`?t=<id>` on its own, or with only `#board=…`) open the same page.

**Big screen URL (no sign-in needed):** `https://twinrig.github.io/ice-fishing-tracker/?t=<tournament id>&screen=1`.

**Staff** use the plain address `https://twinrig.github.io/ice-fishing-tracker/`. The full app keeps the current
tournament and screen in the address (`?t=…&tab=…`), so reloads stay put. Switching mode (Admin / Gate / Weigh /
Big Screen) jumps to that mode's main screen; the tournament picker at the top applies to every screen and is remembered.
The admin Setup tab shows the exact links for the selected tournament.

## One-time setup (admin)

1. **Turn off public sign-ups.** Supabase dashboard → Authentication → Sign In / Providers →
   turn off "Allow new users to sign up". Staff accounts are created by the admin only.
2. **Create each staff user.** Authentication → Users → Add user → Create new user. Enter their email and a
   password, and tick "Auto Confirm User". (Shared station accounts like `gate1@yourclub.org` work fine too.)
3. **Give them a role.** Open the SQL Editor and run (change the email, role and name):

```sql
-- roles: 'admin', 'gate', 'weigh', 'screen'
insert into public.staff_roles (user_id, role, display_name)
select id, 'admin', 'Chris'
from auth.users
where email = 'you@example.com'
on conflict (user_id, role) do nothing;

-- one person can have several roles
insert into public.staff_roles (user_id, role, display_name)
select id, r, 'Gate + Weigh volunteer'
from auth.users, unnest(array['gate','weigh']) as r
where email = 'volunteer@example.com'
on conflict (user_id, role) do nothing;

-- see everyone's roles
select u.email, s.role, s.display_name
from public.staff_roles s join auth.users u on u.id = s.user_id
order by u.email;

-- remove a role
delete from public.staff_roles
where role = 'weigh'
  and user_id = (select id from auth.users where email = 'volunteer@example.com');
```

Once you're an admin you can also add roles from the Table Editor (`staff_roles`) or via the API.
To remove someone completely, delete their user in Authentication → Users (their roles go with it).

4. **Set the admin PIN** (see "Admin PIN" below) – without it nobody can switch into Admin mode.
5. **Sign in on the site** with "Staff sign in", switch the mode picker to **Admin** (enter the PIN), go to **Setup**,
   create the tournament (name, year, event date, species, youth divisions) and set the big-screen scrolling.
   New tournaments start with the organizer's youth divisions **Teenage 13 to 17** (13–17) and **Kids 12 & Under**
   (max 12). There is no senior division.

## Leaderboards (organizer rules, Nov 2026)

- **Every weigh-in counts** – an angler can weigh as many fish as they like, including several of the same species.
- **One fish per angler per board.** Each board uses the angler's best fish for that board:
  - **Overall** – everybody, ranked by their **single biggest fish of any species**.
  - **Youth Divisions** – a section each for **Teenage 13 to 17** and **Kids 12 & Under**, ranked by each kid's single
    biggest fish. Kids are on Overall **and** their youth division (an 11-year-old with a 3 lb bass can be 4th Overall
    and 1st in Kids 12 & Under).
  - **Species** – a section per species, ranked by each angler's biggest fish **of that species**.
  - Example: Bob weighs crappie 2, bass 3, bass 3.5, walleye 4 → Overall shows his 4.00 lb walleye; Bass shows his
    3.50 lb bass; Crappie shows his 2.00 lb crappie.
- Each row shows rank, name, then the species and weight of the counted fish (e.g. `Walleye 4.00 lbs`). No division text.
- Ties share a rank (listed by name). Voided tickets don't count.
- The **Leaderboard** page lists **everyone** on each board. Youth Divisions and Species sections **start folded** –
  tap a heading to open it (remembered on that device).
- The **Big Screen** shows the **top 10 Overall, top 5 in each youth division and top 3 in each species** on one page
  that scrolls: it pauses at the top, scrolls down, pauses at the bottom, then fades back to the top. Admins set
  **Scroll speed** (pixels per second; slow ≈ 20, normal ≈ 40, fast ≈ 80) and **Pause** (seconds) in
  Setup → **Big screen & header**. The TV picks up changes within about 15 s. If everything fits on the screen it
  doesn't scroll.
- The boards are fixed (the old configurable boards and the Total weight / Biggest fish "Metric" are gone; the
  `leaderboard_configs` table is no longer used).

## Header graphic

The text title "Ice Fishing Tracker" is replaced by a header graphic when one is available:
- Put the image in the repo as **`assets/header.png`** (used by every tournament), or
- set **Header image URL** in Setup → Big screen & header for one tournament (`https://…` or `assets/…`).
If neither loads, the text title is shown. Suggested size: **2400 × 300 px** (8:1, wide banner), PNG or JPG,
under ~500 KB, with the important content away from the left/right edges. It's shown full-width at the top of the
staff app and the public leaderboard, and above the big-screen leaderboard (up to 18% of the screen height).

## Admin PIN

Only a few admin accounts sign in. An admin signs a laptop in, then workers use it in **Gate**, **Weigh** or
**Big Screen** mode. Switching that laptop into **Admin** mode asks for the admin PIN.

**Set or change the PIN:** Supabase dashboard → **Table Editor**
(https://supabase.com/dashboard/project/cqnqqjaoeqsdakrdijzr/editor) → schema `public` → table **`app_settings`** →
the single row (id 1) → double-click the **`admin_pin`** cell → type a PIN of 4–32 characters → Enter / **Save**.
It takes effect immediately on every laptop. Clear the cell (NULL) to block Admin mode everywhere.

- **No PIN set = Admin mode is refused** (the safer default). The app says "No admin PIN is set yet".
- The PIN is checked by the database (`verify_admin_pin`); browsers can never read the `app_settings` table.
- **5 wrong tries → locked for 5 minutes** (per admin account).
- A correct PIN unlocks Admin for that sign-in on that laptop only. The database itself refuses admin-only changes
  (Setup, tournament/board edits, deleting a tournament) unless that sign-in is unlocked, so hiding the
  menu isn't the only protection. Admin accounts can always do Gate / Weigh / Big Screen work without the PIN.
- **Locks again** when you pick another mode, sign out, after **10 minutes without activity**, or 30 minutes after the
  last activity check (it's kept alive while you're using it).
- **Offline:** the PIN can't be checked without internet, so Admin mode can't be entered offline. A laptop that was
  already unlocked stays in Admin until the unlock time runs out; Gate and Weigh keep working offline as before.
- On the local VM copy, set the PIN the same way in its Studio (http://192.168.1.127:54323 → Table Editor → `app_settings`).

## Tournament day checklist

- **Free plan pauses after 7 days of no activity.** Open the site or dashboard a few days before the event,
  and un-pause it in the dashboard if needed. (Or upgrade to Pro for that month.)
- Sign in on every station while you have a good connection so the participant list and badge numbers are cached.
- Set the tournament's status to **Active** so it's the default on the public page.
- Badge cards and weigh tickets print through the browser print dialog; pick the Brother QL-800 with 62 mm labels.

## Ages and youth divisions

- **Overall is automatic – everybody is in it.** It's not an age division, so don't add an "Overall" row in Setup
  (the app and the database refuse it). Youth divisions are only for kids.
- Each participant has an **age** (whole years) – required on the walk-up form – and an optional **birth date**.
  When a birth date is stored, the age is calculated as of the tournament's **event date** (today if no event date
  is set) and recalculated automatically if the event date changes.
- In **Setup**, each youth division has a **Min** and **Max** age. Leave Min blank for "and under" (Max 12 =
  "12 & Under"). If two youth divisions overlap, there's a warning and the first one listed wins.
- **Divisions are always automatic** from age / birth date. There's no division choice on sign-up. The database
  assigns it on every add, import and age edit, and re-assigns everyone when the ranges change.
- Adults (older than the oldest youth division) show as **"Overall"** – that's normal.
- A participant with **no age** is flagged in red on the Participants tab ("need an age" link filters to them).
  They're on Overall but can't be placed in a youth division until an age is added.

## Sign-up (walk-up form)

Required: **full name**, **age** (or birth date), **email**, **phone**, and **One hole ticket / Two hole ticket**.
The form won't save until they're filled in (email and phone are checked for a sensible format). The ticket type is
stored on the participant (`hole_tickets` = 1 or 2), shown in the participant list and on the badge card, and
included in the participants export. The Participants tab counts one-hole / two-hole tickets and flags anyone
(e.g. imported) missing an email or phone.

## CSV formats

- **Participants (Setup → Import → Preview → Import):** `name`, `email`, `phone`, `age` and/or birth date, optional
  `hole_tickets` (`1`/`2`, `one`/`two`, `1 hole`/`2 holes`; also read from `holes` or `ticket`).
  - Rows missing an email or phone (or with one that doesn't look right) are flagged in the preview; they still import,
    and the Participants tab flags them so the gate can fill them in.
  - A division / group column is **ignored** – divisions are always worked out from age.
  - Participant numbers are **always assigned automatically**. An `id`/`code`/`participant_id` column in the file is
    ignored, and the preview says so.
  - Birth date headers (any case): `birthdate`, `birth_date`, `dob`, `date_of_birth`, `birthday`.
  - Date formats: `2014-03-09`, `2014/3/9`, `3/9/2014`, `03/09/2014`, `3/9/14` (US month/day order).
    Two-digit years use the most recent century that isn't after the event date (`1/1/30` = 1930, `3/9/14` = 2014).
  - If both an age and a birth date are given, the **age column wins**; the birth date is only used when the age is
    blank. The preview flags any disagreement, and in that case the birth date is not saved (the database would
    otherwise recalculate the age from it). A date that can't be read is flagged and ignored.
  - Nothing is saved until you click **Import** under the preview.
  Re-importing the same file skips rows already imported.
- **Exports (Setup):** participants (including `age`, `birth_date`, `youth_division`, `hole_tickets`, `email`, `phone`),
  weigh-ins, leaderboard (`board, section, rank, name, species, lbs`).

Weights are a single decimal-pounds value (`catches.weight_lbs`, 2 decimals, must be > 0 and ≤ 500).
There is no angler check-in step, no fish length and no staff initials. Each weigh-in automatically records the
signed-in staff account (`recorded_by`) and the station name set on that laptop.

## Finding and editing weigh tickets

Weigh-in tab → **Find / edit tickets** (Weigh Station and Admin). The list shows the newest tickets first; search by
angler name, angler number (`2027_00012` or just `12`), ticket number (`#42` or `42`), or the code printed on the
ticket (e.g. `CD0E7848`). Tap a ticket to change the angler, species, weight or add a note, reprint it, or **Void**
it (a reason is required; voided tickets are struck through, drop off every leaderboard, and can be **Restored**).
Edits work offline like weigh-ins and sync later; leaderboards update on their own.

- **Every weigh-in counts** – there's no "already has a walleye" prompt and no held tickets. Boards pick each
  angler's best fish automatically, so weighing a bigger fish of the same species simply moves them up.
- Ticket numbers (#1, #2, …) are per tournament and assigned by the server when the weigh-in syncs (a ticket weighed
  offline shows `#…` until then; its printed code always works for searching).
- Weigh staff can edit any ticket in the tournament; Gate can't. The database enforces this.
- Every edit, void and restore is logged with who (email) and when, showing old → new values (the ticket's
  "Change history"). The weigh-in CSV export includes ticket number, code, note and last-changed time.

## Deleting a tournament

Setup → **Danger zone – Delete tournament** (admins only, bottom of the page). The pop-up shows what will be deleted
(participants, weigh-ins, species) and the Delete button stays disabled until you type the tournament
name exactly (capital letters matter; spaces at the ends are ignored). The database re-checks the admin role and the
name and deletes everything in one transaction (`delete_tournament`). This can't be undone, so export the CSVs first.
Afterwards this laptop switches to another tournament and forgets the deleted one (cache, reserved numbers, unsynced
changes). Other staff laptops switch away automatically; public links for it show "not available".

## Sample file

`samples/test-anglers.csv` – 40 fake anglers (columns `name, age, birth_date, email, phone, hole_tickets`) mixing age
only, birth date only (mixed formats), both, and neither; kids in both youth divisions plus adults (Overall only);
hole tickets written as `1`, `2`, `one`, `two`, `1 hole`, `2 holes` (and two left blank); two rows missing an email
and one missing a phone so the preview shows those warnings.
Import it into a separate **test tournament**, not a real one.

## Backups

The free plan has no downloadable automatic backups, so take your own after each tournament day.
Get the connection string from the dashboard → **Connect** → "Session pooler" (works on IPv4 networks).
It looks like `postgresql://postgres.cqnqqjaoeqsdakrdijzr:[YOUR-DB-PASSWORD]@aws-…pooler.supabase.com:5432/postgres`.
Use a `pg_dump` that is version 17 or newer (the project runs Postgres 17).

```bash
export DB_URL='postgresql://postgres.cqnqqjaoeqsdakrdijzr:[YOUR-DB-PASSWORD]@aws-…pooler.supabase.com:5432/postgres'

# Everything the app owns, in one compressed file (restore with pg_restore)
pg_dump "$DB_URL" --schema=public --schema=private --no-owner --no-privileges -Fc \
  -f "ice-fishing-$(date +%F).dump"

# Or with the Supabase CLI (plain SQL files)
supabase db dump --db-url "$DB_URL" -f schema.sql
supabase db dump --db-url "$DB_URL" --data-only -f data.sql
```

The CSV exports in the Setup tab are a good human-readable backup too.

Note: the tables reference Supabase's `auth.users` and use `auth.uid()`, so a restore into a plain PostgreSQL
server (for example a local VM) needs those pieces stubbed or a local Supabase stack (`supabase start`).

## Security notes

- Only the publishable key is in the browser. Never put the `service_role`/secret key in this repo.
- The repo is public; anyone can read the code, but data access is controlled by the database rules above.
- Privileged database functions live in a `private` schema that the API doesn't expose.
