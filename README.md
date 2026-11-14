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
| public (not signed in) | Leaderboard only: names, age group, placements, weights (lbs). No emails/phones. |

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

**Public leaderboard on phones.** Each leaderboard (overall, big fish, each species, each age group…) is its own tab;
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

4. **Sign in on the site** with "Staff sign in", go to **Setup**, create the tournament (name, year, age groups,
   species), and adjust the leaderboards. Four default boards are created automatically.
   Species and Age group / Division boards have the same picker choices:
   - **Each species / age group** – a separate tab (and TV slide) per species or group.
   - **All species / age groups, grouped on one board** – ONE tab (one TV slide, split into pages on the TV
     if it's long) with a separately ranked section per species or group (Walleye, Perch, …).
   - **Any species / age group, combined ranking** – one tab, everyone ranked together.
   - Or pick a single species / group.

## Tournament day checklist

- **Free plan pauses after 7 days of no activity.** Open the site or dashboard a few days before the event,
  and un-pause it in the dashboard if needed. (Or upgrade to Pro for that month.)
- Sign in on every station while you have a good connection so the participant list and badge numbers are cached.
- Set the tournament's status to **Active** so it's the default on the public page.
- Badge cards and weigh tickets print through the browser print dialog; pick the Brother QL-800 with 62 mm labels.

## CSV formats

- **Participants (Setup → Import):** `name, ageGroup` + optional `email, phone, id`. Re-importing the same file skips rows already imported.
- **Exports (Setup):** participants, weigh-ins, leaderboard.

Weights are a single decimal-pounds value (`catches.weight_lbs`, 2 decimals, must be > 0 and ≤ 500).
There is no angler check-in step, no fish length and no staff initials. Each weigh-in automatically records the
signed-in staff account (`recorded_by`) and the station name set on that laptop.

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
