const https = require('https')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const REPO = 'dentar142/Fit-Running'
const TAG = 'v0.1.0-beta'
const RELEASE_NAME = 'v0.1.0-beta'
const RELEASE_BODY = 'Keep FIT 跑步轨迹生成工具 - v0.1.0 Beta\n\n下载 `Fit-Running-0.1.0-beta-portable.exe` 直接双击运行。\n\n功能：免API地图轨迹绘制、批量生成、多策略FIT导出、GPX/TCX/GeoJSON互转。'
const EXE_PATH = path.join(__dirname, '..', 'release', 'Fit-Running-0.1.0-beta-portable.exe')

function getToken() {
  const input = 'protocol=https\nhost=github.com\n\n'
  const credHelper = 'C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe'
  const stdout = execFileSync(credHelper, ['get'], { input, encoding: 'utf-8' })
  const match = stdout.match(/password=(.+)/)
  return match ? match[1].trim() : null
}

function apiRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function main() {
  console.log('Getting token...')
  const token = getToken()
  if (!token) { console.error('No token'); process.exit(1) }

  console.log('Creating release...')
  const createBody = JSON.stringify({
    tag_name: TAG, name: RELEASE_NAME, body: RELEASE_BODY, draft: false, prerelease: false,
  })

  const createRes = await apiRequest({
    hostname: 'api.github.com',
    path: `/repos/${REPO}/releases`,
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'User-Agent': 'FitRunning',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(createBody),
      'Accept': 'application/vnd.github.v3+json',
    },
  }, createBody)

  let release
  if (createRes.status === 201) {
    release = JSON.parse(createRes.data)
    console.log('Release created:', release.html_url)
  } else if (createRes.status === 422) {
    console.log('Tag exists, fetching...')
    const r = await apiRequest({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/releases/tags/${TAG}`,
      method: 'GET',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'FitRunning',
        'Accept': 'application/vnd.github.v3+json',
      },
    })
    release = JSON.parse(r.data)
    console.log('Existing release:', release.html_url)
  } else {
    console.error('Create failed:', createRes.status, createRes.data)
    process.exit(1)
  }

  const fileName = path.basename(EXE_PATH)
  const fileBuffer = fs.readFileSync(EXE_PATH)
  console.log(`Uploading ${fileName} (${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB)...`)

  const uploadRes = await apiRequest({
    hostname: 'uploads.github.com',
    path: `/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`,
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'User-Agent': 'FitRunning',
      'Content-Type': 'application/octet-stream',
      'Content-Length': fileBuffer.length,
      'Accept': 'application/vnd.github.v3+json',
    },
  }, fileBuffer)

  if (uploadRes.status === 201) {
    const asset = JSON.parse(uploadRes.data)
    console.log('Done:', asset.browser_download_url)
  } else {
    console.error('Upload failed:', uploadRes.status, uploadRes.data)
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
