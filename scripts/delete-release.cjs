const https = require('https')
const { execFileSync } = require('child_process')

const REPO = 'dentar142/Fit-Running'
const TAG = 'v1.0.0'

function getToken() {
  const input = 'protocol=https\nhost=github.com\n\n'
  const credHelper = 'C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe'
  const stdout = execFileSync(credHelper, ['get'], { input, encoding: 'utf-8' })
  const match = stdout.match(/password=(.+)/)
  return match ? match[1].trim() : null
}

function apiRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function main() {
  const token = getToken()
  if (!token) { console.error('No token'); process.exit(1) }
  const headers = { 'Authorization': `token ${token}`, 'User-Agent': 'FitRunning', 'Accept': 'application/vnd.github.v3+json' }

  const getRes = await apiRequest({ hostname: 'api.github.com', path: `/repos/${REPO}/releases/tags/${TAG}`, method: 'GET', headers })
  if (getRes.status !== 200) { console.log('Release not found, nothing to delete'); return }

  const release = JSON.parse(getRes.data)
  console.log(`Deleting release ${release.id} (${TAG})...`)
  const delRes = await apiRequest({ hostname: 'api.github.com', path: `/repos/${REPO}/releases/${release.id}`, method: 'DELETE', headers })
  console.log('Release delete:', delRes.status === 204 ? 'OK' : delRes.status)

  console.log(`Deleting tag ${TAG}...`)
  const tagRes = await apiRequest({ hostname: 'api.github.com', path: `/repos/${REPO}/git/refs/tags/${TAG}`, method: 'DELETE', headers })
  console.log('Tag delete:', tagRes.status === 204 ? 'OK' : tagRes.status)
}

main().catch((e) => { console.error(e); process.exit(1) })
