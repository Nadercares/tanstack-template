#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Google OAuth2 Refresh Token Generator
//
// Run ONCE to obtain your GOOGLE_REFRESH_TOKEN.
// After that, store the token in .env and never run this again.
//
// Prerequisites:
//   1. Go to https://console.cloud.google.com/
//   2. Create a project (or select existing)
//   3. Enable APIs: Google Calendar API + Gmail API
//   4. Go to "APIs & Services > Credentials"
//   5. Create OAuth 2.0 Client ID → type: "Desktop app"
//   6. Copy Client ID and Client Secret into .env:
//        GOOGLE_CLIENT_ID=...
//        GOOGLE_CLIENT_SECRET=...
//   7. Run this script: node scripts/get-google-token.mjs
//
// The script will:
//   - Print an authorization URL
//   - Open your browser automatically (or you can open it manually)
//   - Start a local server on port 3456 to receive the OAuth callback
//   - Exchange the code for tokens and print the refresh token
// ─────────────────────────────────────────────────────────────────────────────

import http from 'http'
import { readFileSync, existsSync } from 'fs'
import { createInterface } from 'readline'
import { exec } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

// ── Load .env ─────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath   = path.resolve(__dirname, '../.env')

if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (key && val && !process.env[key]) process.env[key] = val
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const PORT          = 3456
const REDIRECT_URI  = `http://localhost:${PORT}/oauth2callback`

// Scopes needed for Calendar + Gmail
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ')

// ── Validate env ──────────────────────────────────────────────────────────────

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌  Missing required environment variables.\n')
  console.error('Please add these to your .env file first:\n')
  console.error('   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com')
  console.error('   GOOGLE_CLIENT_SECRET=your-client-secret\n')
  console.error('Get them from: https://console.cloud.google.com/apis/credentials\n')
  process.exit(1)
}

// ── Build authorization URL ───────────────────────────────────────────────────

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id',     CLIENT_ID)
authUrl.searchParams.set('redirect_uri',  REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope',         SCOPES)
authUrl.searchParams.set('access_type',   'offline')   // Required for refresh token
authUrl.searchParams.set('prompt',        'consent')   // Forces refresh token even if previously authorized

// ── Exchange code for tokens ──────────────────────────────────────────────────

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    grant_type:    'authorization_code',
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Token exchange failed (${res.status}): ${errText}`)
  }

  return res.json()
}

// ── Open browser helper ───────────────────────────────────────────────────────

function openBrowser(url) {
  const platform = process.platform
  const cmd = platform === 'darwin' ? `open "${url}"`
            : platform === 'win32'  ? `start "" "${url}"`
            : `xdg-open "${url}"`
  exec(cmd, err => {
    if (err) {
      // Browser open failed — user will see the manual URL below
    }
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n🔑  Google OAuth2 Refresh Token Generator')
console.log('─'.repeat(55))
console.log('This runs ONCE to generate your GOOGLE_REFRESH_TOKEN.\n')

// Start local callback server
const server = http.createServer()
let resolveCode
const codePromise = new Promise((resolve, reject) => {
  resolveCode = resolve
  setTimeout(() => reject(new Error('Timed out waiting for OAuth callback (5 minutes)')), 5 * 60 * 1000)
})

server.on('request', (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const error = url.searchParams.get('error')
  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html' })
    res.end(`<h2>❌ Authorization failed: ${error}</h2><p>You can close this tab.</p>`)
    resolveCode(Promise.reject(new Error(`OAuth error: ${error}`)))
    return
  }

  const code = url.searchParams.get('code')
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' })
    res.end('<h2>❌ No authorization code received.</h2><p>You can close this tab.</p>')
    resolveCode(Promise.reject(new Error('No code in callback')))
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(`
    <html>
      <body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
        <h2>✅ Authorization successful!</h2>
        <p>You can close this tab and return to your terminal.</p>
      </body>
    </html>
  `)

  resolveCode(code)
})

server.listen(PORT, () => {
  console.log(`📡  Callback server listening on http://localhost:${PORT}`)
  console.log('\n🌐  Opening browser for Google authorization...')
  console.log('\nIf the browser does not open automatically, visit this URL:\n')
  console.log(`   ${authUrl.toString()}\n`)
  openBrowser(authUrl.toString())
})

// Wait for the callback
let code
try {
  code = await codePromise
} catch (err) {
  console.error('\n❌ ', err.message)
  server.close()
  process.exit(1)
}

server.close()
console.log('✅  Authorization code received. Exchanging for tokens...\n')

// Exchange code for tokens
let tokens
try {
  tokens = await exchangeCodeForTokens(code)
} catch (err) {
  console.error('\n❌ ', err.message)
  process.exit(1)
}

// ── Output results ────────────────────────────────────────────────────────────

console.log('─'.repeat(55))
console.log('✅  SUCCESS — Add these to your .env file:\n')
console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`)
if (tokens.access_token) {
  console.log('\n(Access token — expires in 1 hour, no need to save):')
  console.log(`# GOOGLE_ACCESS_TOKEN=${tokens.access_token}`)
}
console.log('\n─'.repeat(55))
console.log('\n📋  Copy the GOOGLE_REFRESH_TOKEN line into your .env file.')
console.log('    The refresh token does NOT expire unless you revoke it.\n')

if (!tokens.refresh_token) {
  console.warn('⚠️  No refresh token returned.')
  console.warn('   This usually means the app was already authorized.')
  console.warn('   To force a new refresh token:')
  console.warn('   1. Go to https://myaccount.google.com/permissions')
  console.warn('   2. Remove your app\'s access')
  console.warn('   3. Re-run this script\n')
}
