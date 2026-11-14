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
| public (not signed in) | Leaderboard only: names, Age/Division, placements, weights (lbs). No emails, phones or ages. |

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

**Public leaderboard on phones.** Each leaderboard (overall, big fish, each species, each Age/Division…) is its own tab;
the tab row scrolls sideways on small screens. The selected tab is kept in the link (for example
`…/?t=<tournament id>#board=big-fish`), so people can share a specific board. The page refreshes every 45 s.

**Big screen URL (no sign-in needed):** `https://twinrig.github.io/ice-fishing-tracker/?t=<tournament id>&screen=1`.
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

4. **Sign in on the site** with "Staff sign in", go to **Setup**, create the tournament (name, year, Age/Division
   names with their age ranges, species), and adjust the leaderboards. Four default boards are created automatically.
   Species and Age/Division boards have the same picker choices:
   - **Each species / Age/Division** – a separate tab (and TV slide) per species or group.
   - **All species / Age/Divisions, grouped on one board** – ONE tab (one TV slide, split into pages on the TV
     if it's long) with a separately ranked section per species or group (Walleye, Perch, …).
   - **Any species / Age/Division, combined ranking** – one tab, everyone ranked together.
   - Or pick a single species / group.

## Tournament day checklist

- **Free plan pauses after 7 days of no activity.** Open the site or dashboard a few days before the event,
  and un-pause it in the dashboard if needed. (Or upgrade to Pro for that month.)
- Sign in on every station while you have a good connection so the participant list and badge numbers are cached.
- Set the tournament's status to **Active** so it's the default on the public page.
- Badge cards and weigh tickets print through the browser print dialog; pick the Brother QL-800 with 62 mm labels.

## Ages and Age/Division

- Each participant has an **age** (whole years), entered on walk-up/edit or imported from CSV, and an optional
  **birth date**. When a birth date is stored, the age is calculated as of the tournament's **event date**
  (today if no event date is set) and recalculated automatically if the event date changes.
- In **Setup**, each Age/Division has a **Min** and **Max** age. Leave one blank for open-ended
  (Max 13 = "13 & under", Min 19 = "19 and up"). If ranges overlap, the first one listed wins.
- The database assigns the Age/Division automatically on every add, import and age edit, and re-assigns
  everyone when the ranges change, so all laptops (and changes that sync later from offline laptops) agree.
- **Set by hand:** in the participant's Edit window, pick a specific Age/Division instead of "automatic".
  It's shown with a "set by hand" tag and won't be changed by the ranges. Choose "automatic" to undo.
- If the age is blank or no range matches, the Age/Division is left empty and the participant is flagged
  in red on the Participants tab ("without Age/Division" link filters to them). They won't appear on
  Age/Division leaderboards until fixed.

## CSV formats

- **Participants (Setup → Import → Preview → Import):** `name` + optional `age` and/or birth date, `Age/Division`, `email`, `phone`, `id`.
  - Birth date headers (any case): `birthdate`, `birth_date`, `dob`, `date_of_birth`, `birthday`.
  - Date formats: `2014-03-09`, `2014/3/9`, `3/9/2014`, `03/09/2014`, `3/9/14` (US month/day order).
    Two-digit years use the most recent century that isn't after the event date (`1/1/30` = 1930, `3/9/14` = 2014).
  - If both an age and a birth date are given, the birth date wins and the preview flags any disagreement.
    A date that can't be read leaves the age blank (or falls back to the age column) and is flagged in the preview.
  - Nothing is saved until you click **Import** under the preview.
  With an age, the Age/Division is assigned automatically from the ranges (the file's Age/Division is ignored).
  Without an age, the file's Age/Division (if any) is kept as a hand-set choice. Re-importing the same file skips rows already imported.
- **Exports (Setup):** participants (including `age`, `birth_date`, `Age/Division`, `division_set_by_hand`), weigh-ins, leaderboard.

Weights are a single decimal-pounds value (`catches.weight_lbs`, 2 decimals, must be > 0 and ≤ 500).
There is no angler check-in step, no fish length and no staff initials. Each weigh-in automatically records the
signed-in staff account (`recorded_by`) and the station name set on that laptop.

## Sample file

`samples/test-anglers.csv` – 40 fake anglers mixing age only, birth date only (mixed formats), both
(some disagreeing), neither, and bad dates, including the 13/14 and 18/19 boundaries for a 2027-01-23 event.
Import it into a separate **test tournament**, not a real one. Participant numbers are per tournament, so this
only affects the tournament you import into: the two rows with fixed ids 2027_00101/00102 move that tournament's
next number up to 2027_00103.

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
