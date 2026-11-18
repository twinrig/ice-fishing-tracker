// Public client config. The publishable key is safe to ship in the browser;
// all access is enforced by Row Level Security in the database.
// NEVER put a service_role / secret key here.
window.IFT_CONFIG = {
  supabaseUrl: 'https://cqnqqjaoeqsdakrdijzr.supabase.co',
  supabaseKey: 'sb_publishable_CvNc1ZLOejETdhht2xNGMw_bk-KalXT',
  publicPollSeconds: 45,   // public leaderboard viewers
  screenPollSeconds: 15    // big screen TV (scroll speed / pause are set per tournament in Setup)
};
