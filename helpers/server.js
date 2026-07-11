const express = require('express')
const path = require('path')
const http = require('http')
const cors = require('cors')

const config = require('../config.json')
const logger = require('./logger')
const metrics = require('./metrics')

// SERVER CONFIG
const PORT = process.env.PORT || 5000
const app = express()

app.use(cors())

// -- OPTIONAL BASIC AUTH --
// On a VPS this port is internet-exposed, so gate the dashboard when creds are set.
const DASH_USER = process.env.DASHBOARD_USER
const DASH_PASS = process.env.DASHBOARD_PASS

if (DASH_USER && DASH_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || ''
    const [scheme, encoded] = header.split(' ')
    if (scheme === 'Basic' && encoded) {
      const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':')
      if (user === DASH_USER && pass === DASH_PASS) return next()
    }
    res.set('WWW-Authenticate', 'Basic realm="Arbitrage Bot"')
    return res.status(401).send('Authentication required')
  })
} else {
  console.log('WARNING: dashboard has NO auth. Set DASHBOARD_USER / DASHBOARD_PASS in .env,')
  console.log('         or firewall this port, before exposing it on a VPS.\n')
}

// -- API --
app.get('/api/stats', (req, res) => {
  try {
    const stats = logger.computeStats()
    stats.meta = {
      network: config.PROJECT_SETTINGS.isLocal ? 'local fork' : 'Arbitrum One',
      isDeployed: config.PROJECT_SETTINGS.isDeployed,
      explorerTx: config.PROJECT_SETTINGS.isLocal ? null : 'https://arbiscan.io/tx/'
    }
    // Live runtime metrics (this process, since start) for the health panel
    stats.runtime = metrics.snapshot()
    res.json(stats)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Live runtime metrics on their own, for lightweight polling / external checks
app.get('/api/metrics', (req, res) => {
  res.json(metrics.snapshot())
})

app.get('/api/trades', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000)
  // Most recent first
  res.json(logger.getTrades(limit).reverse())
})

app.get('/api/opportunities', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000)
  res.json(logger.getOpportunities(limit).reverse())
})

app.get('/export/trades.csv', (req, res) => {
  res.set('Content-Type', 'text/csv')
  res.set('Content-Disposition', 'attachment; filename="arbitrage-trades.csv"')
  res.send(logger.tradesCsv())
})

// Dashboard (helpers/public/index.html)
app.use(express.static(path.join(__dirname, 'public')))

http.createServer(app).listen(PORT, () => console.log(`Dashboard listening on ${PORT}\n`))
