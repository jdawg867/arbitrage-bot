// pm2 process definition for the arbitrage bot.
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup     # survive reboots
//
// IMPORTANT: exactly ONE fork-mode instance. The bot's per-pair processing locks
// and the global "one trade in flight" mutex live in memory, so a second instance
// would double-evaluate opportunities and collide transaction nonces. Never set
// instances > 1 and never use cluster mode.
module.exports = {
  apps: [
    {
      name: 'arb-bot',
      script: 'bot.js',
      cwd: __dirname,          // load config.json / .env / artifacts from the repo root
      instances: 1,            // single instance — see note above
      exec_mode: 'fork',       // NOT cluster

      autorestart: true,       // restart on a hard crash
      min_uptime: '30s',       // must stay up 30s to count as a good start
      max_restarts: 10,        // then back off, so a broken config doesn't hot-loop
      restart_delay: 5000,     // wait 5s between restarts
      max_memory_restart: '400M', // restart if memory creeps (leak guard)

      time: true,              // prepend timestamps to log lines
      env: {
        NODE_ENV: 'production'
        // Secrets (ALCHEMY_API_KEY, PRIVATE_KEY, DASHBOARD_USER/PASS, PORT) are
        // read from .env by dotenv — keep them there, NOT in this committed file.
      }
    }
  ]
}
