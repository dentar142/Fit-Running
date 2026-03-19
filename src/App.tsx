import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import L from 'leaflet'
import { FitConstants, FitEncoder, FitMessages, Message } from 'fit-encoder'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
import 'leaflet/dist/leaflet.css'
import './App.css'

type RoutePoint = {
  lng: number
  lat: number
}

type ExportConfig = {
  activityName: string
  startTime: string
  paceMinPerKm: number
  sampleIntervalSec: number
  heartRateStart: number
  heartRateEnd: number
  cadence: number
  baseAltitude: number
  altitudeSwing: number
  caloriesPerKm: number
  outAndBack: boolean
  keepCompatibilityProfile: KeepCompatibilityProfile
  smoothWindowSize: number
  simplifyToleranceMeters: number
  samplingStrategy: SamplingStrategy
  autoCleanup: boolean
  maxSegmentMeters: number
}

type KeepCompatibilityProfile =
  | 'balanced'
  | 'strict_keep'
  | 'legacy_simple'
  | 'aggressive_minimal'
  | 'device_compat'

type ExportStats = {
  distanceMeters: number
  durationSec: number
  sampledPoints: RoutePoint[]
  processedPoints: RoutePoint[]
  report: RouteQualityReport
}

type SamplingStrategy = 'distance' | 'time'

type RouteQualityReport = {
  duplicatePoints: number
  jumpSegments: number
  maxSegmentMeters: number
  totalSegments: number
}

type PlannedBatchActivity = {
  id: string
  startTime: Date
  shiftedRoute: RoutePoint[]
  profile: KeepCompatibilityProfile
  paceFactor: number
  distanceFactor: number
  estimatedDistanceMeters: number
  lockedStart: boolean
}

type ConfigPreset = {
  name: string
  config: ExportConfig
}

type ThemeMode = 'light' | 'dark'
type DensityMode = 'comfortable' | 'compact'
type SectionKey = 'map' | 'route' | 'params' | 'batch' | 'export'
type NoApiTileSource = 'osm' | 'carto_light' | 'carto_dark'
type InteractionMode = 'guided' | 'control'

type BatchConfig = {
  startDate: string
  endDate: string
  weekdays: [boolean, boolean, boolean, boolean, boolean, boolean, boolean]
  windows: Array<{ enabled: boolean; start: string; end: string }>
  routeOffsetMeters: number
  lateralOffsetMeters: number
  pointJitterMeters: number
  distanceJitterPercent: number
  paceJitterPercent: number
}

const KEEP_PROFILE_LABEL: Record<KeepCompatibilityProfile, string> = {
  balanced: '平衡（推荐）',
  strict_keep: 'Keep优先（更严格元数据）',
  legacy_simple: '简化兼容（精简字段）',
  aggressive_minimal: '极简兼容（仅关键字段）',
  device_compat: '设备兼容（设备元信息增强）',
}

const KEEP_PROFILE_DESC: Record<KeepCompatibilityProfile, string> = {
  balanced: '字段完整，兼顾兼容与数据丰富度。',
  strict_keep: '使用更保守的会话事件与子运动类型，优先导入稳定性。',
  legacy_simple: '只保留核心轨迹字段，适合导入挑剔场景。',
  aggressive_minimal: '进一步减少字段，优先“能导入”。',
  device_compat: '强调设备与创建者信息，适配部分平台解析策略。',
}

const KEEP_PROFILES: KeepCompatibilityProfile[] = [
  'balanced',
  'strict_keep',
  'legacy_simple',
  'aggressive_minimal',
  'device_compat',
]
const CONFIG_PRESET_STORAGE_KEY = 'keep-fit-config-presets-v1'
const UI_PREFS_STORAGE_KEY = 'keep-fit-ui-prefs-v1'
const ONBOARDING_SEEN_STORAGE_KEY = 'keep-fit-onboarding-seen-v1'

const DEFAULT_CENTER: RoutePoint = { lng: 116.397428, lat: 39.90923 }
const SEMICIRCLES = 2147483648 / 180

const toSemicircle = (deg: number): number => Math.round(deg * SEMICIRCLES)
const toFitDistance = (meters: number): number => Math.round(meters * 100)
const toFitSpeed = (metersPerSec: number): number => Math.round(metersPerSec * 1000)
const toFitAltitude = (meters: number): number => Math.round((meters + 500) * 5)
const pointEquals = (a: RoutePoint, b: RoutePoint): boolean => a.lng === b.lng && a.lat === b.lat
const clampNumber = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.min(max, Math.max(min, value))
}

const TILE_SOURCE_MAP: Record<NoApiTileSource, { url: string; attribution: string; label: string }> = {
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    label: 'OpenStreetMap',
  },
  carto_light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    label: 'CARTO Light',
  },
  carto_dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    label: 'CARTO Dark',
  },
}

const normalizeExportConfig = (input: Partial<ExportConfig> | undefined): ExportConfig => ({
  activityName: input?.activityName ?? 'Keep Running',
  startTime: input?.startTime ?? formatDateTimeLocal(new Date()),
  paceMinPerKm: input?.paceMinPerKm ?? 5.5,
  sampleIntervalSec: input?.sampleIntervalSec ?? 2,
  heartRateStart: input?.heartRateStart ?? 135,
  heartRateEnd: input?.heartRateEnd ?? 158,
  cadence: input?.cadence ?? 168,
  baseAltitude: input?.baseAltitude ?? 30,
  altitudeSwing: input?.altitudeSwing ?? 3,
  caloriesPerKm: input?.caloriesPerKm ?? 62,
  outAndBack: input?.outAndBack ?? false,
  keepCompatibilityProfile: input?.keepCompatibilityProfile ?? 'balanced',
  smoothWindowSize: input?.smoothWindowSize ?? 0,
  simplifyToleranceMeters: input?.simplifyToleranceMeters ?? 0,
  samplingStrategy: input?.samplingStrategy ?? 'distance',
  autoCleanup: input?.autoCleanup ?? true,
  maxSegmentMeters: input?.maxSegmentMeters ?? 1200,
})

const readConfigPresets = (): ConfigPreset[] => {
  const raw = localStorage.getItem(CONFIG_PRESET_STORAGE_KEY)
  if (!raw) {
    return []
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .filter((item): item is ConfigPreset => {
        if (typeof item !== 'object' || item === null) {
          return false
        }
        const candidate = item as { name?: unknown; config?: unknown }
        return typeof candidate.name === 'string' && typeof candidate.config === 'object' && candidate.config !== null
      })
      .map((item) => ({
        name: item.name,
        config: normalizeExportConfig(item.config as Partial<ExportConfig>),
      }))
  } catch {
    return []
  }
}

const haversineMeters = (a: RoutePoint, b: RoutePoint): number => {
  const earthRadius = 6371000
  const toRadians = (x: number) => (x * Math.PI) / 180
  const dLat = toRadians(b.lat - a.lat)
  const dLng = toRadians(b.lng - a.lng)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)

  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
  return earthRadius * c
}

const lerpPoint = (a: RoutePoint, b: RoutePoint, t: number): RoutePoint => ({
  lng: a.lng + (b.lng - a.lng) * t,
  lat: a.lat + (b.lat - a.lat) * t,
})

const parseCoordinateLines = (input: string): RoutePoint[] => {
  const rows = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  return rows.map((line) => {
    const tokens = line.split(/[\s,;，]+/).filter((token) => token.length > 0)
    if (tokens.length < 2) {
      throw new Error(`坐标格式错误: ${line}`)
    }

    const lng = Number(tokens[0])
    const lat = Number(tokens[1])
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new Error(`坐标不是数字: ${line}`)
    }
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw new Error(`坐标超出范围: ${line}`)
    }

    return { lng, lat }
  })
}

const parseTimeToMinutes = (time: string): number => {
  const [h, m] = time.split(':').map((v) => Number(v))
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    return 0
  }
  return h * 60 + m
}

const randomBetween = (min: number, max: number): number => min + Math.random() * (max - min)

const shiftRouteByMeters = (points: RoutePoint[], eastMeters: number, northMeters: number): RoutePoint[] => {
  if (points.length === 0) return points
  const baseLat = points[0].lat
  const dLat = northMeters / 111320
  const dLng = eastMeters / (111320 * Math.cos((baseLat * Math.PI) / 180))
  return points.map((p) => ({ lng: p.lng + dLng, lat: p.lat + dLat }))
}

const offsetPointByMeters = (point: RoutePoint, eastMeters: number, northMeters: number): RoutePoint => {
  const dLat = northMeters / 111320
  const dLng = eastMeters / (111320 * Math.cos((point.lat * Math.PI) / 180))
  return { lng: point.lng + dLng, lat: point.lat + dLat }
}

const jitterRoutePoints = (points: RoutePoint[], jitterMeters: number): RoutePoint[] => {
  if (points.length < 2 || jitterMeters <= 0) return points
  return points.map((point, i) => {
    if (i === 0 || i === points.length - 1) return point
    const angle = randomBetween(0, Math.PI * 2)
    const radius = randomBetween(0, jitterMeters)
    return offsetPointByMeters(point, Math.cos(angle) * radius, Math.sin(angle) * radius)
  })
}

const applyLateralOffset = (points: RoutePoint[], maxLateralMeters: number): RoutePoint[] => {
  if (points.length < 2 || maxLateralMeters <= 0) return points
  const shifted: RoutePoint[] = [points[0]]
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]
    const current = points[i]
    const next = points[i + 1]
    const dx = next.lng - prev.lng
    const dy = next.lat - prev.lat
    const len = Math.hypot(dx, dy)
    if (len === 0) {
      shifted.push(current)
      continue
    }
    const nx = -dy / len
    const ny = dx / len
    const lateral = randomBetween(-maxLateralMeters, maxLateralMeters)
    const east = nx * lateral
    const north = ny * lateral
    shifted.push(offsetPointByMeters(current, east, north))
  }
  shifted.push(points[points.length - 1])
  return shifted
}

const trimRouteToDistance = (points: RoutePoint[], distanceFactor: number): RoutePoint[] => {
  if (points.length < 2 || distanceFactor <= 0) return points
  const total = distanceOfPath(points)
  const target = total * distanceFactor
  if (target >= total) return points

  const result: RoutePoint[] = [points[0]]
  let acc = 0
  for (let i = 1; i < points.length; i += 1) {
    const seg = haversineMeters(points[i - 1], points[i])
    if (acc + seg < target) {
      result.push(points[i])
      acc += seg
      continue
    }
    const remain = target - acc
    const t = seg > 0 ? remain / seg : 0
    result.push(lerpPoint(points[i - 1], points[i], Math.min(1, Math.max(0, t))))
    break
  }
  return result.length >= 2 ? result : points
}

const listDatesInclusive = (startDate: Date, endDate: Date): Date[] => {
  const list: Date[] = []
  const d = new Date(startDate)
  d.setHours(0, 0, 0, 0)
  const end = new Date(endDate)
  end.setHours(0, 0, 0, 0)
  while (d <= end) {
    list.push(new Date(d))
    d.setDate(d.getDate() + 1)
  }
  return list
}

const toLocalMeters = (point: RoutePoint, origin: RoutePoint): { x: number; y: number } => {
  const earthRadius = 6371000
  const toRadians = (x: number) => (x * Math.PI) / 180
  const dLat = toRadians(point.lat - origin.lat)
  const dLng = toRadians(point.lng - origin.lng)
  const x = dLng * Math.cos(toRadians((origin.lat + point.lat) / 2)) * earthRadius
  const y = dLat * earthRadius
  return { x, y }
}

const perpendicularDistanceMeters = (point: RoutePoint, start: RoutePoint, end: RoutePoint): number => {
  if (pointEquals(start, end)) {
    return haversineMeters(point, start)
  }

  const origin = start
  const p = toLocalMeters(point, origin)
  const a = { x: 0, y: 0 }
  const b = toLocalMeters(end, origin)
  const abX = b.x - a.x
  const abY = b.y - a.y
  const apX = p.x - a.x
  const apY = p.y - a.y
  const abLenSq = abX * abX + abY * abY
  const t = Math.max(0, Math.min(1, (apX * abX + apY * abY) / abLenSq))
  const projX = a.x + t * abX
  const projY = a.y + t * abY
  const dx = p.x - projX
  const dy = p.y - projY
  return Math.sqrt(dx * dx + dy * dy)
}

const simplifyDouglasPeucker = (points: RoutePoint[], toleranceMeters: number): RoutePoint[] => {
  if (points.length <= 2 || toleranceMeters <= 0) {
    return points
  }

  let maxDistance = 0
  let index = 0
  const start = points[0]
  const end = points[points.length - 1]

  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = perpendicularDistanceMeters(points[i], start, end)
    if (distance > maxDistance) {
      maxDistance = distance
      index = i
    }
  }

  if (maxDistance <= toleranceMeters) {
    return [start, end]
  }

  const left = simplifyDouglasPeucker(points.slice(0, index + 1), toleranceMeters)
  const right = simplifyDouglasPeucker(points.slice(index), toleranceMeters)
  return [...left.slice(0, -1), ...right]
}

const smoothRoute = (points: RoutePoint[], windowSize: number): RoutePoint[] => {
  if (points.length <= 2 || windowSize <= 0) {
    return points
  }

  const radius = Math.max(1, Math.floor(windowSize / 2))
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) {
      return point
    }

    let lngSum = 0
    let latSum = 0
    let count = 0
    for (let i = Math.max(0, index - radius); i <= Math.min(points.length - 1, index + radius); i += 1) {
      lngSum += points[i].lng
      latSum += points[i].lat
      count += 1
    }

    return {
      lng: lngSum / count,
      lat: latSum / count,
    }
  })
}

const preprocessRoute = (points: RoutePoint[], config: ExportConfig): RoutePoint[] => {
  const smoothed = smoothRoute(points, config.smoothWindowSize)
  const simplified = simplifyDouglasPeucker(smoothed, config.simplifyToleranceMeters)
  return simplified.length >= 2 ? simplified : smoothed
}

const toNativePath = (points: RoutePoint[]): RoutePoint[] => points

const parseGeoJsonRoute = (input: string): RoutePoint[] => {
  const parsed: unknown = JSON.parse(input)

  const normalizeCoordinates = (coordinates: unknown): RoutePoint[] => {
    if (!Array.isArray(coordinates)) {
      return []
    }
    const points: RoutePoint[] = []
    for (const item of coordinates) {
      if (!Array.isArray(item) || item.length < 2) {
        return []
      }
      const lng = Number(item[0])
      const lat = Number(item[1])
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return []
      }
      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        return []
      }
      points.push({ lng, lat })
    }
    return points
  }

  const fromGeometry = (geometry: unknown): RoutePoint[] => {
    if (typeof geometry !== 'object' || geometry === null) {
      return []
    }

    const g = geometry as { type?: unknown; coordinates?: unknown }
    if (g.type === 'LineString') {
      return normalizeCoordinates(g.coordinates)
    }
    if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) {
      const segments = g.coordinates
        .map((segment) => normalizeCoordinates(segment))
        .filter((segment) => segment.length >= 2)
      if (segments.length === 0) {
        return []
      }
      segments.sort((a, b) => b.length - a.length)
      return segments[0]
    }

    return []
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('GeoJSON 格式错误')
  }

  const root = parsed as {
    type?: unknown
    geometry?: unknown
    features?: unknown
  }

  if (root.type === 'LineString' || root.type === 'MultiLineString') {
    const points = fromGeometry(root)
    if (points.length >= 2) {
      return points
    }
  }

  if (root.type === 'Feature') {
    const points = fromGeometry(root.geometry)
    if (points.length >= 2) {
      return points
    }
  }

  if (root.type === 'FeatureCollection' && Array.isArray(root.features)) {
    for (const feature of root.features) {
      if (typeof feature !== 'object' || feature === null) {
        continue
      }
      const candidate = fromGeometry((feature as { geometry?: unknown }).geometry)
      if (candidate.length >= 2) {
        return candidate
      }
    }
  }

  throw new Error('未找到可用的 LineString/MultiLineString 轨迹')
}

const parseXmlTagValue = (xml: string, tagName: string): string | null => {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i')
  const match = xml.match(pattern)
  return match ? match[1].trim() : null
}

const parseGpxRoute = (xml: string): RoutePoint[] => {
  const points: RoutePoint[] = []
  const pointRegex = /<(trkpt|rtept)\b[^>]*?lat="([^"]+)"[^>]*?lon="([^"]+)"[^>]*?>/gi

  let match = pointRegex.exec(xml)
  while (match) {
    const lat = Number(match[2])
    const lng = Number(match[3])
    if (Number.isFinite(lat) && Number.isFinite(lng) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
      points.push({ lng, lat })
    }
    match = pointRegex.exec(xml)
  }

  if (points.length < 2) {
    throw new Error('GPX 中未找到足够的轨迹点')
  }
  return points
}

const parseTcxRoute = (xml: string): RoutePoint[] => {
  const points: RoutePoint[] = []
  const trackPointRegex = /<Trackpoint>([\s\S]*?)<\/Trackpoint>/gi

  let match = trackPointRegex.exec(xml)
  while (match) {
    const node = match[1]
    const lat = Number(parseXmlTagValue(node, 'LatitudeDegrees'))
    const lng = Number(parseXmlTagValue(node, 'LongitudeDegrees'))
    if (Number.isFinite(lat) && Number.isFinite(lng) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
      points.push({ lng, lat })
    }
    match = trackPointRegex.exec(xml)
  }

  if (points.length < 2) {
    throw new Error('TCX 中未找到足够的轨迹点')
  }
  return points
}

const buildGpx = (points: RoutePoint[], name: string): string => {
  const rows = points
    .map(
      (point) =>
        `      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lng.toFixed(7)}"><ele>0</ele><time>${new Date().toISOString()}</time></trkpt>`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="KeepFitBuilder" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <trkseg>
${rows}
    </trkseg>
  </trk>
</gpx>`
}

const buildTcx = (points: RoutePoint[], name: string): string => {
  const rows = points
    .map(
      (point) => `          <Trackpoint>
            <Time>${new Date().toISOString()}</Time>
            <Position>
              <LatitudeDegrees>${point.lat.toFixed(7)}</LatitudeDegrees>
              <LongitudeDegrees>${point.lng.toFixed(7)}</LongitudeDegrees>
            </Position>
          </Trackpoint>`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>${new Date().toISOString()}</Id>
      <Lap StartTime="${new Date().toISOString()}">
        <Track>
${rows}
        </Track>
      </Lap>
      <Notes>${name}</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`
}

const buildExportPath = (points: RoutePoint[], outAndBack: boolean): RoutePoint[] => {
  if (!outAndBack || points.length < 2) {
    return points
  }
  const reversed = points.slice(0, -1).reverse()
  return [...points, ...reversed]
}

const distanceOfPath = (points: RoutePoint[]): number => {
  if (points.length < 2) {
    return 0
  }
  let sum = 0
  for (let i = 1; i < points.length; i += 1) {
    sum += haversineMeters(points[i - 1], points[i])
  }
  return sum
}

const samplePathByDistance = (points: RoutePoint[], stepMeters: number): RoutePoint[] => {
  if (points.length === 0) {
    return []
  }
  if (points.length === 1) {
    return [points[0]]
  }

  const safeStep = Math.max(1, stepMeters)
  const sampled: RoutePoint[] = [points[0]]

  let segmentIndex = 1
  let segmentStart = points[0]
  let segmentEnd = points[1]
  let segmentLength = haversineMeters(segmentStart, segmentEnd)
  let traveledInSegment = 0
  let targetDistance = safeStep
  let totalDistance = 0

  const pathDistance = distanceOfPath(points)

  while (targetDistance < pathDistance && segmentIndex < points.length) {
    while (segmentIndex < points.length && totalDistance + segmentLength < targetDistance) {
      totalDistance += segmentLength
      segmentIndex += 1
      if (segmentIndex >= points.length) {
        break
      }
      segmentStart = points[segmentIndex - 1]
      segmentEnd = points[segmentIndex]
      segmentLength = haversineMeters(segmentStart, segmentEnd)
      traveledInSegment = 0
    }

    if (segmentIndex >= points.length || segmentLength <= 0) {
      break
    }

    traveledInSegment = targetDistance - totalDistance
    const t = Math.min(1, Math.max(0, traveledInSegment / segmentLength))
    sampled.push(lerpPoint(segmentStart, segmentEnd, t))
    targetDistance += safeStep
  }

  const last = points[points.length - 1]
  const prev = sampled[sampled.length - 1]
  if (prev.lng !== last.lng || prev.lat !== last.lat) {
    sampled.push(last)
  }

  return sampled
}

const samplePathByTime = (points: RoutePoint[], speedMps: number, intervalSec: number): RoutePoint[] => {
  const stepMeters = Math.max(1, speedMps * intervalSec)
  return samplePathByDistance(points, stepMeters)
}

const analyzeRouteQuality = (points: RoutePoint[], maxSegmentMeters: number): RouteQualityReport => {
  if (points.length < 2) {
    return {
      duplicatePoints: 0,
      jumpSegments: 0,
      maxSegmentMeters: 0,
      totalSegments: 0,
    }
  }

  let duplicatePoints = 0
  let jumpSegments = 0
  let maxSeen = 0
  let totalSegments = 0

  for (let i = 1; i < points.length; i += 1) {
    const segment = haversineMeters(points[i - 1], points[i])
    totalSegments += 1
    maxSeen = Math.max(maxSeen, segment)
    if (segment < 0.3) {
      duplicatePoints += 1
    }
    if (segment > maxSegmentMeters) {
      jumpSegments += 1
    }
  }

  return {
    duplicatePoints,
    jumpSegments,
    maxSegmentMeters: maxSeen,
    totalSegments,
  }
}

const cleanupRoute = (points: RoutePoint[], maxSegmentMeters: number): RoutePoint[] => {
  if (points.length < 2) {
    return points
  }

  const cleaned: RoutePoint[] = [points[0]]
  for (let i = 1; i < points.length; i += 1) {
    const prev = cleaned[cleaned.length - 1]
    const current = points[i]
    const segment = haversineMeters(prev, current)
    if (segment < 0.3) {
      continue
    }
    if (segment > maxSegmentMeters) {
      continue
    }
    cleaned.push(current)
  }

  return cleaned.length >= 2 ? cleaned : points
}

const computeStats = (routePoints: RoutePoint[], config: ExportConfig): ExportStats => {
  const wgs84Points = toNativePath(routePoints)
  const qualityBefore = analyzeRouteQuality(wgs84Points, config.maxSegmentMeters)
  const maybeCleaned = config.autoCleanup ? cleanupRoute(wgs84Points, config.maxSegmentMeters) : wgs84Points
  const processedPath = preprocessRoute(maybeCleaned, config)
  const exportPath = buildExportPath(processedPath, config.outAndBack)
  const distanceMeters = distanceOfPath(exportPath)
  const speedMps = 1000 / (config.paceMinPerKm * 60)
  const sampledPoints =
    config.samplingStrategy === 'time'
      ? samplePathByTime(exportPath, speedMps, config.sampleIntervalSec)
      : samplePathByDistance(exportPath, speedMps * config.sampleIntervalSec)
  const durationSec = speedMps > 0 ? distanceMeters / speedMps : 0

  return {
    distanceMeters,
    durationSec,
    sampledPoints,
    processedPoints: processedPath,
    report: qualityBefore,
  }
}

const computeQualityScore = (stats: ExportStats, rawPoints: number): number => {
  if (rawPoints <= 1) {
    return 0
  }
  const duplicatePenalty = Math.min(35, stats.report.duplicatePoints * 2)
  const jumpPenalty = Math.min(45, stats.report.jumpSegments * 9)
  const compressionRatio = stats.processedPoints.length / rawPoints
  const ratioPenalty = compressionRatio < 0.25 ? 15 : 0
  const maxSegPenalty = stats.report.maxSegmentMeters > 1500 ? 10 : 0
  return Math.max(0, Math.round(100 - duplicatePenalty - jumpPenalty - ratioPenalty - maxSegPenalty))
}

const getRiskLevel = (score: number): '低' | '中' | '高' => {
  if (score >= 80) return '低'
  if (score >= 60) return '中'
  return '高'
}

class RunningFitEncoder extends FitEncoder {
  constructor(points: RoutePoint[], config: ExportConfig, stats: ExportStats) {
    super()

    const profile = config.keepCompatibilityProfile
    const startDate = new Date(config.startTime)
    const startTs = Math.round(FitEncoder.toFitTimestamp(startDate))
    const speedMps = 1000 / (config.paceMinPerKm * 60)
    const elapsedMs = Math.max(1000, Math.round(stats.durationSec * 1000))
    const endTs = startTs + Math.max(1, Math.round(stats.durationSec))
    const calories = Math.max(1, Math.round((stats.distanceMeters / 1000) * config.caloriesPerKm))
    const subSport =
      profile === 'strict_keep' || profile === 'aggressive_minimal'
        ? FitConstants.sub_sport.generic
        : FitConstants.sub_sport.road

    const fileIdMessage = new Message(
      FitConstants.mesg_num.file_id,
      FitMessages.file_id,
      'type',
      'manufacturer',
      'product',
      'serial_number',
      'time_created',
      'product_name',
    )

    const fileCreatorMessage = new Message(
      FitConstants.mesg_num.file_creator,
      FitMessages.file_creator,
      'software_version',
      'hardware_version',
    )

    const deviceInfoMessage = new Message(
      FitConstants.mesg_num.device_info,
      FitMessages.device_info,
      'timestamp',
      'manufacturer',
      'product',
      'device_index',
      'source_type',
      'product_name',
    )

    const eventMessage = new Message(
      FitConstants.mesg_num.event,
      FitMessages.event,
      'timestamp',
      'event',
      'event_type',
    )

    const sportMessage = new Message(
      FitConstants.mesg_num.sport,
      FitMessages.sport,
      'sport',
      'sub_sport',
      'name',
    )

    const recordMessage =
      profile === 'legacy_simple' || profile === 'aggressive_minimal'
        ? new Message(
            FitConstants.mesg_num.record,
            FitMessages.record,
            'timestamp',
            'position_lat',
            'position_long',
            'distance',
            'speed',
          )
        : new Message(
            FitConstants.mesg_num.record,
            FitMessages.record,
            'timestamp',
            'position_lat',
            'position_long',
            'cycles',
            'total_cycles',
            'distance',
            'speed',
            'heart_rate',
            'altitude',
            'cadence',
            'cadence256',
            'fractional_cadence',
          )

    const lapMessage = new Message(
      FitConstants.mesg_num.lap,
      FitMessages.lap,
      'timestamp',
      'event',
      'event_type',
      'start_time',
      'start_position_lat',
      'start_position_long',
      'end_position_lat',
      'end_position_long',
      'total_elapsed_time',
      'total_timer_time',
      'total_distance',
      'total_cycles',
      'total_calories',
      'avg_speed',
      'max_speed',
      'avg_heart_rate',
      'max_heart_rate',
      'avg_cadence',
      'max_cadence',
      'avg_fractional_cadence',
      'max_fractional_cadence',
      'sport',
      'sub_sport',
      'total_moving_time',
      'lap_trigger',
    )

    const sessionMessage = new Message(
      FitConstants.mesg_num.session,
      FitMessages.session,
      'timestamp',
      'start_time',
      'start_position_lat',
      'start_position_long',
      'sport',
      'sub_sport',
      'total_elapsed_time',
      'total_timer_time',
      'total_distance',
      'total_cycles',
      'total_calories',
      'avg_speed',
      'max_speed',
      'avg_heart_rate',
      'max_heart_rate',
      'avg_cadence',
      'max_cadence',
      'avg_fractional_cadence',
      'max_fractional_cadence',
      'event',
      'event_type',
      'total_moving_time',
    )

    const activityMessage = new Message(
      FitConstants.mesg_num.activity,
      FitMessages.activity,
      'timestamp',
      'total_timer_time',
      'num_sessions',
      'type',
      'event',
      'event_type',
      'local_timestamp',
    )

    const manufacturer =
      profile === 'legacy_simple' || profile === 'aggressive_minimal'
        ? FitConstants.manufacturer.wahoo_fitness
        : FitConstants.manufacturer.garmin
    const product = profile === 'legacy_simple' || profile === 'aggressive_minimal' ? 32 : 100
    const productName =
      profile === 'legacy_simple'
        ? 'KeepRouteLegacy'
        : profile === 'strict_keep'
          ? 'KeepRouteStrict'
          : profile === 'aggressive_minimal'
            ? 'KeepRouteMinimal'
            : profile === 'device_compat'
              ? 'KeepRouteDevice'
              : 'KeepRouteBalanced'

    fileIdMessage.writeDataMessage(
      FitConstants.file.activity,
      manufacturer,
      product,
      1,
      startTs,
      productName,
    )

    fileCreatorMessage.writeDataMessage(100, 1)

    if (profile !== 'legacy_simple' && profile !== 'aggressive_minimal') {
      deviceInfoMessage.writeDataMessage(
        startTs,
        manufacturer,
        product,
        FitConstants.device_index.creator,
        FitConstants.source_type.local,
        productName,
      )
    }

    eventMessage.writeDataMessage(startTs, FitConstants.event.timer, FitConstants.event_type.start)
    if (profile === 'strict_keep' || profile === 'device_compat') {
      eventMessage.writeDataMessage(startTs, FitConstants.event.session, FitConstants.event_type.start)
    }
    sportMessage.writeDataMessage(
      FitConstants.sport.running,
      subSport,
      config.activityName,
    )

    let cumulativeDistance = 0
    let cumulativeCycles = 0
    let previousTs = startTs
    for (let i = 0; i < points.length; i += 1) {
      if (i > 0) {
        cumulativeDistance += haversineMeters(points[i - 1], points[i])
      }

      const expected = startTs + Math.round(i * config.sampleIntervalSec)
      const ts = i === 0 ? startTs : Math.max(previousTs + 1, expected)
      const prevTs = previousTs

      const hrRange = config.heartRateEnd - config.heartRateStart
      const ratio = points.length > 1 ? i / (points.length - 1) : 0
      const heartRate = Math.round(config.heartRateStart + hrRange * ratio)
      const altitude = config.baseAltitude + Math.sin(i / 12) * config.altitudeSwing
      const cadenceWhole = Math.floor(config.cadence)
      const cadenceFrac = Math.round((config.cadence - cadenceWhole) * 256)
      if (i > 0) {
        const dt = ts - prevTs
        const cycleDelta = Math.max(0, Math.round((config.cadence / 60) * dt))
        cumulativeCycles += cycleDelta
      }

      if (profile === 'legacy_simple' || profile === 'aggressive_minimal') {
        recordMessage.writeDataMessage(
          ts,
          toSemicircle(points[i].lat),
          toSemicircle(points[i].lng),
          toFitDistance(cumulativeDistance),
          toFitSpeed(speedMps),
        )
      } else {
        recordMessage.writeDataMessage(
          ts,
          toSemicircle(points[i].lat),
          toSemicircle(points[i].lng),
          i > 0 ? Math.max(0, Math.round((config.cadence / 60) * (ts - prevTs))) : 0,
          cumulativeCycles,
          toFitDistance(cumulativeDistance),
          toFitSpeed(speedMps),
          heartRate,
          toFitAltitude(altitude),
          cadenceWhole,
          Math.round(config.cadence * 256),
          cadenceFrac,
        )
      }

      previousTs = ts
    }

    eventMessage.writeDataMessage(endTs, FitConstants.event.timer, FitConstants.event_type.stop_all)
    if (profile !== 'legacy_simple' && profile !== 'aggressive_minimal') {
      eventMessage.writeDataMessage(endTs, FitConstants.event.session, FitConstants.event_type.stop_disable_all)
    }

    const firstPoint = points[0]
    const lastPoint = points[points.length - 1]
    const avgHr = Math.round((config.heartRateStart + config.heartRateEnd) / 2)

    lapMessage.writeDataMessage(
      endTs,
      FitConstants.event.lap,
      FitConstants.event_type.stop,
      startTs,
      toSemicircle(firstPoint.lat),
      toSemicircle(firstPoint.lng),
      toSemicircle(lastPoint.lat),
      toSemicircle(lastPoint.lng),
      elapsedMs,
      elapsedMs,
      toFitDistance(stats.distanceMeters),
      Math.max(1, cumulativeCycles),
      calories,
      toFitSpeed(speedMps),
      toFitSpeed(speedMps),
      avgHr,
      Math.max(config.heartRateStart, config.heartRateEnd),
      config.cadence,
      config.cadence,
      Math.round((config.cadence - Math.floor(config.cadence)) * 256),
      Math.round((config.cadence - Math.floor(config.cadence)) * 256),
      FitConstants.sport.running,
      subSport,
      elapsedMs,
      FitConstants.lap_trigger.manual,
    )

    sessionMessage.writeDataMessage(
      endTs,
      startTs,
      toSemicircle(firstPoint.lat),
      toSemicircle(firstPoint.lng),
      FitConstants.sport.running,
      subSport,
      elapsedMs,
      elapsedMs,
      toFitDistance(stats.distanceMeters),
      Math.max(1, cumulativeCycles),
      calories,
      toFitSpeed(speedMps),
      toFitSpeed(speedMps),
      avgHr,
      Math.max(config.heartRateStart, config.heartRateEnd),
      config.cadence,
      config.cadence,
      Math.round((config.cadence - Math.floor(config.cadence)) * 256),
      Math.round((config.cadence - Math.floor(config.cadence)) * 256),
      FitConstants.event.session,
      FitConstants.event_type.stop,
      elapsedMs,
    )

    activityMessage.writeDataMessage(
      endTs,
      elapsedMs,
      1,
      FitConstants.activity.manual,
      FitConstants.event.activity,
      FitConstants.event_type.stop,
      endTs,
    )
  }
}

const formatDateTimeLocal = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0')
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const hh = pad(date.getHours())
  const mm = pad(date.getMinutes())
  return `${y}-${m}-${d}T${hh}:${mm}`
}

function App() {
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>([])
  const [bulkInput, setBulkInput] = useState('')
  const [mapStatus, setMapStatus] = useState('等待加载地图')
  const [errorText, setErrorText] = useState('')
  const [presetNameInput, setPresetNameInput] = useState('')
  const [selectedPresetName, setSelectedPresetName] = useState('')
  const [configPresets, setConfigPresets] = useState<ConfigPreset[]>(() => readConfigPresets())
  const [geoJsonReplaceMode, setGeoJsonReplaceMode] = useState(false)
  const [tileSource, setTileSource] = useState<NoApiTileSource>(() => {
    const raw = localStorage.getItem(UI_PREFS_STORAGE_KEY)
    if (!raw) return 'osm'
    try {
      const parsed = JSON.parse(raw) as { tileSource?: NoApiTileSource }
      return parsed.tileSource ?? 'osm'
    } catch {
      return 'osm'
    }
  })
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const raw = localStorage.getItem(UI_PREFS_STORAGE_KEY)
    if (!raw) return 'light'
    try {
      const parsed = JSON.parse(raw) as { themeMode?: ThemeMode }
      return parsed.themeMode === 'dark' ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  })
  const [densityMode, setDensityMode] = useState<DensityMode>(() => {
    const raw = localStorage.getItem(UI_PREFS_STORAGE_KEY)
    if (!raw) return 'comfortable'
    try {
      const parsed = JSON.parse(raw) as { densityMode?: DensityMode }
      return parsed.densityMode === 'compact' ? 'compact' : 'comfortable'
    } catch {
      return 'comfortable'
    }
  })
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    map: false,
    route: false,
    params: false,
    batch: false,
    export: false,
  })
  const [toast, setToast] = useState<{ message: string; kind: 'success' | 'error' } | null>(null)
  const [diagnosis, setDiagnosis] = useState('')
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('guided')
  const [guidedStep, setGuidedStep] = useState<SectionKey>('map')
  const [batchConfig, setBatchConfig] = useState<BatchConfig>({
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
    weekdays: [true, true, true, true, true, true, true],
    windows: [
      { enabled: true, start: '06:30', end: '08:30' },
      { enabled: false, start: '18:00', end: '21:00' },
    ],
    routeOffsetMeters: 40,
    lateralOffsetMeters: 22,
    pointJitterMeters: 8,
    distanceJitterPercent: 14,
    paceJitterPercent: 6,
  })
  const [batchPreview, setBatchPreview] = useState<PlannedBatchActivity[]>([])
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    const seen = localStorage.getItem(ONBOARDING_SEEN_STORAGE_KEY)
    return seen !== '1'
  })
  const [tilt, setTilt] = useState({ x: 0, y: 0 })

  const [config, setConfig] = useState<ExportConfig>(() => normalizeExportConfig(undefined))

  useEffect(() => {
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: markerIcon2x,
      iconUrl: markerIcon,
      shadowUrl: markerShadow,
    })
  }, [])

  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const geoJsonInputRef = useRef<HTMLInputElement | null>(null)
  const routeFileInputRef = useRef<HTMLInputElement | null>(null)
  const configInputRef = useRef<HTMLInputElement | null>(null)
  const routeImportReplaceRef = useRef(false)
  const toastTimerRef = useRef<number | null>(null)
  const overlayRafRef = useRef<number | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<L.Marker[]>([])
  const polylineRef = useRef<L.Polyline | null>(null)
  const tileLayerRef = useRef<L.TileLayer | null>(null)
  const routeHistoryRef = useRef<RoutePoint[][]>([])
  const heroRef = useRef<HTMLDivElement | null>(null)

  const stats = useMemo(() => computeStats(routePoints, config), [routePoints, config])
  const qualityScore = useMemo(() => computeQualityScore(stats, routePoints.length), [routePoints.length, stats])

  const pushToast = useCallback((message: string, kind: 'success' | 'error'): void => {
    setToast({ message, kind })
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current)
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, 2200)
  }, [])

  const updateMapOverlays = useCallback((): void => {
    const map = mapRef.current
    if (!map) {
      return
    }

    for (const marker of markersRef.current) {
      marker.remove()
    }
    markersRef.current = []

    if (polylineRef.current) {
      polylineRef.current.remove()
      polylineRef.current = null
    }

    if (routePoints.length === 0) {
      return
    }

    const path = routePoints.map((point) => [point.lat, point.lng] as [number, number])

    polylineRef.current = L.polyline(path, {
      color: '#3366ff',
      weight: 5,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(map)

    routePoints.forEach((point, index) => {
      const marker = L.marker([point.lat, point.lng], {
        draggable: true,
        title: `轨迹点 ${index + 1}`,
      }).addTo(map)

      marker.on('dragend', () => {
        const pos = marker.getLatLng()
        setRoutePoints((prev) =>
          prev.map((item, i) =>
            i === index
              ? {
                  lng: pos.lng,
                  lat: pos.lat,
                }
              : item,
          ),
        )
      })

      marker.on('contextmenu', () => {
        setRoutePoints((prev) => prev.filter((_, i) => i !== index))
      })

      markersRef.current.push(marker)
    })

    if (polylineRef.current) {
      map.fitBounds(polylineRef.current.getBounds(), { padding: [80, 80] })
    }
  }, [routePoints])

  const scheduleMapOverlays = useCallback((): void => {
    if (overlayRafRef.current !== null) {
      window.cancelAnimationFrame(overlayRafRef.current)
    }
    overlayRafRef.current = window.requestAnimationFrame(() => {
      updateMapOverlays()
      overlayRafRef.current = null
    })
  }, [updateMapOverlays])

  const initializeMap = useCallback(async (): Promise<void> => {
    if (!mapContainerRef.current) {
      return
    }

    setErrorText('')
    setMapStatus('地图加载中...')

    try {
      if (mapRef.current) {
        mapRef.current.remove()
      }

      const map = L.map(mapContainerRef.current, {
        center: [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng],
        zoom: 13,
      })

      const source = TILE_SOURCE_MAP[tileSource]
      const tileLayer = L.tileLayer(source.url, {
        attribution: source.attribution,
        maxZoom: 19,
      }).addTo(map)
      tileLayerRef.current = tileLayer

      map.on('click', (event: L.LeafletMouseEvent) => {
        setRoutePoints((prev) => [...prev, { lng: event.latlng.lng, lat: event.latlng.lat }])
      })

      mapRef.current = map
      setMapStatus(`地图已就绪（${source.label}）：左键添加点，拖拽微调，右键删除点`)
      pushToast('地图加载成功', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMapStatus('地图加载失败')
      setErrorText(`地图加载失败：${message}`)
      pushToast('地图加载失败', 'error')
    }
  }, [pushToast, tileSource])

  const loadMapWithCurrentKey = async (): Promise<void> => {
    await initializeMap()
  }

  const finishOnboarding = (): void => {
    localStorage.setItem(ONBOARDING_SEEN_STORAGE_KEY, '1')
    setShowOnboarding(false)
    pushToast('已进入工作台', 'success')
  }

  const resetOnboarding = (): void => {
    localStorage.removeItem(ONBOARDING_SEEN_STORAGE_KEY)
    setShowOnboarding(true)
  }

  const isSectionVisible = (key: SectionKey): boolean => {
    if (interactionMode === 'control') return true
    return guidedStep === key
  }

  const goToNextGuidedStep = (current: SectionKey): void => {
    const order: SectionKey[] = ['map', 'route', 'params', 'batch', 'export']
    const idx = order.indexOf(current)
    const next = order[idx + 1]
    if (next) {
      setGuidedStep(next)
    }
  }

  const handleImport = (replaceAll: boolean): void => {
    try {
      const parsed = parseCoordinateLines(bulkInput)
      setRoutePoints((prev) => (replaceAll ? parsed : [...prev, ...parsed]))
      setErrorText('')
      pushToast(`已导入 ${parsed.length} 个坐标点`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(message)
      pushToast('坐标导入失败', 'error')
    }
  }

  const openGeoJsonPicker = (replaceAll: boolean): void => {
    setGeoJsonReplaceMode(replaceAll)
    if (geoJsonInputRef.current) {
      geoJsonInputRef.current.value = ''
      geoJsonInputRef.current.click()
    }
  }

  const handleGeoJsonFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const text = await file.text()
      const parsed = parseGeoJsonRoute(text)
      setRoutePoints((prev) => (geoJsonReplaceMode ? parsed : [...prev, ...parsed]))
      setErrorText('')
      setDiagnosis('')
      pushToast(`GeoJSON 导入成功（${parsed.length} 点）`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(`GeoJSON 导入失败：${message}`)
      setDiagnosis('导入诊断：请确认文件结构正确，且至少包含 2 个有效坐标点。')
      pushToast('GeoJSON 导入失败', 'error')
    }
  }

  const openRouteFilePicker = (replaceAll: boolean): void => {
    routeImportReplaceRef.current = replaceAll
    if (routeFileInputRef.current) {
      routeFileInputRef.current.value = ''
      routeFileInputRef.current.click()
    }
  }

  const handleRouteFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const text = await file.text()
      const name = file.name.toLowerCase()
      let parsed: RoutePoint[] = []
      if (name.endsWith('.geojson') || name.endsWith('.json')) {
        parsed = parseGeoJsonRoute(text)
      } else if (name.endsWith('.gpx')) {
        parsed = parseGpxRoute(text)
      } else if (name.endsWith('.tcx')) {
        parsed = parseTcxRoute(text)
      } else {
        throw new Error('仅支持 .geojson/.json/.gpx/.tcx')
      }

      setRoutePoints((prev) => (routeImportReplaceRef.current ? parsed : [...prev, ...parsed]))
      setErrorText('')
      setDiagnosis('')
      pushToast(`轨迹文件导入成功（${parsed.length} 点）`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(`轨迹导入失败：${message}`)
      setDiagnosis('导入诊断：请确认 GPX/TCX/GeoJSON 中含有经纬度轨迹点且文件未损坏。')
      pushToast('轨迹导入失败', 'error')
    }
  }

  const clearRoute = (): void => {
    routeHistoryRef.current.push(routePoints)
    setRoutePoints([])
  }

  const undoPoint = (): void => {
    routeHistoryRef.current.push(routePoints)
    setRoutePoints((prev) => prev.slice(0, -1))
  }

  const fitToRoute = useCallback((): void => {
    const map = mapRef.current
    if (!map || routePoints.length === 0) {
      return
    }
    if (polylineRef.current) {
      map.fitBounds(polylineRef.current.getBounds(), { padding: [80, 80] })
    }
  }, [routePoints.length])

  const reverseRoute = (): void => {
    routeHistoryRef.current.push(routePoints)
    setRoutePoints((prev) => prev.slice().reverse())
  }

  const closeRouteLoop = (): void => {
    routeHistoryRef.current.push(routePoints)
    setRoutePoints((prev) => {
      if (prev.length < 2) {
        return prev
      }
      const first = prev[0]
      const last = prev[prev.length - 1]
      if (pointEquals(first, last)) {
        return prev
      }
      return [...prev, first]
    })
  }

  const rollbackRoute = (): void => {
    const last = routeHistoryRef.current.pop()
    if (!last || last.length === 0) {
      pushToast('没有可回退的快照', 'error')
      return
    }
    setRoutePoints(last)
    pushToast('已回退到上一个快照', 'success')
  }

  const fixRouteOneClick = (): void => {
    if (routePoints.length < 2) {
      pushToast('轨迹点不足，无法修复', 'error')
      return
    }
    routeHistoryRef.current.push(routePoints)
    const cleaned = cleanupRoute(routePoints, config.maxSegmentMeters)
    const smoothed = smoothRoute(cleaned, Math.max(3, config.smoothWindowSize || 3))
    const simplified = simplifyDouglasPeucker(smoothed, Math.max(2, config.simplifyToleranceMeters || 2))
    setRoutePoints(simplified.length >= 2 ? simplified : smoothed)
    pushToast('一键修复已完成', 'success')
  }

  const exportGeoJson = (): void => {
    setErrorText('')
    if (routePoints.length < 2) {
      setErrorText('至少需要 2 个轨迹点才能导出 GeoJSON')
      return
    }

    const wgs84Points = toNativePath(routePoints)

    const featureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            name: config.activityName,
            coordinateSystem: 'WGS84',
            keepCompatibilityProfile: config.keepCompatibilityProfile,
            paceMinPerKm: config.paceMinPerKm,
            sampleIntervalSec: config.sampleIntervalSec,
            outAndBack: config.outAndBack,
          },
          geometry: {
            type: 'LineString',
            coordinates: wgs84Points.map((point) => [point.lng, point.lat]),
          },
        },
      ],
    }

    const content = JSON.stringify(featureCollection, null, 2)
    const blob = new Blob([content], { type: 'application/geo+json' })
    const url = URL.createObjectURL(blob)
    const safeName = config.activityName.replace(/[^a-zA-Z0-9_-]+/g, '_')
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${safeName || 'keep_route'}.geojson`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    pushToast('GeoJSON 已导出', 'success')
  }

  const exportGpx = (): void => {
    const wgs84Points = toNativePath(routePoints)
    if (wgs84Points.length < 2) {
      setErrorText('处理后轨迹不足，无法导出 GPX')
      pushToast('GPX 导出失败', 'error')
      return
    }
    const xml = buildGpx(wgs84Points, config.activityName)
    const blob = new Blob([xml], { type: 'application/gpx+xml' })
    const url = URL.createObjectURL(blob)
    const safeName = config.activityName.replace(/[^a-zA-Z0-9_-]+/g, '_')
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${safeName || 'keep_route'}.gpx`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    pushToast('GPX 已导出', 'success')
  }

  const exportTcx = (): void => {
    const wgs84Points = toNativePath(routePoints)
    if (wgs84Points.length < 2) {
      setErrorText('处理后轨迹不足，无法导出 TCX')
      pushToast('TCX 导出失败', 'error')
      return
    }
    const xml = buildTcx(wgs84Points, config.activityName)
    const blob = new Blob([xml], { type: 'application/xml' })
    const url = URL.createObjectURL(blob)
    const safeName = config.activityName.replace(/[^a-zA-Z0-9_-]+/g, '_')
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${safeName || 'keep_route'}.tcx`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    pushToast('TCX 已导出', 'success')
  }

  const exportConfigSnapshot = (): void => {
    const payload = JSON.stringify(config, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'keep-fit-config-snapshot.json'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    pushToast('配置快照已导出', 'success')
  }

  const importConfigSnapshot = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as Partial<ExportConfig>
      setConfig(normalizeExportConfig(parsed))
      setErrorText('')
      setDiagnosis('')
      pushToast('配置快照已导入', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(`配置导入失败：${message}`)
      setDiagnosis('配置诊断：请使用本工具导出的 JSON 快照导入。')
      pushToast('配置导入失败', 'error')
    }
  }

  const saveCurrentPreset = (): void => {
    const trimmed = presetNameInput.trim()
    if (trimmed.length === 0) {
      setErrorText('请先输入预设名称')
      return
    }

    setConfigPresets((prev) => {
      const next = [...prev.filter((item) => item.name !== trimmed), { name: trimmed, config }]
      localStorage.setItem(CONFIG_PRESET_STORAGE_KEY, JSON.stringify(next))
      return next
    })
    setSelectedPresetName(trimmed)
    setErrorText('')
    pushToast('预设已保存', 'success')
  }

  const applySelectedPreset = (): void => {
    const preset = configPresets.find((item) => item.name === selectedPresetName)
    if (!preset) {
      setErrorText('请选择有效的预设')
      return
    }
    setConfig(normalizeExportConfig(preset.config))
    setErrorText('')
    pushToast('预设已应用', 'success')
  }

  const deleteSelectedPreset = (): void => {
    if (selectedPresetName.length === 0) {
      setErrorText('请先选择要删除的预设')
      return
    }
    setConfigPresets((prev) => {
      const next = prev.filter((item) => item.name !== selectedPresetName)
      localStorage.setItem(CONFIG_PRESET_STORAGE_KEY, JSON.stringify(next))
      return next
    })
    setSelectedPresetName('')
    setErrorText('')
    pushToast('预设已删除', 'success')
  }

  const downloadFit = useCallback((): void => {
    setErrorText('')
    if (routePoints.length < 2) {
      setErrorText('至少需要 2 个轨迹点才能导出 FIT 文件')
      return
    }

    const startDate = new Date(config.startTime)
    if (Number.isNaN(startDate.getTime())) {
      setErrorText('开始时间格式不正确')
      return
    }

    if (config.paceMinPerKm <= 0 || config.sampleIntervalSec <= 0) {
      setErrorText('配速和采样间隔必须大于 0')
      return
    }

    try {
      if (stats.sampledPoints.length < 2) {
        throw new Error('采样后的轨迹点不足，请调整路线或参数')
      }

      const encoder = new RunningFitEncoder(stats.sampledPoints, config, stats)
      const file = encoder.getFile()
      const copiedBytes = new Uint8Array(file.byteLength)
      copiedBytes.set(new Uint8Array(file))
      const blob = new Blob([copiedBytes.buffer], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)

      const fileDate = startDate.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, '')
      const safeName = config.activityName.replace(/[^a-zA-Z0-9_-]+/g, '_')
      const filename = `${safeName || 'keep_run'}_${fileDate}.fit`

      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      pushToast('FIT 导出成功', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(`FIT 生成失败：${message}`)
      pushToast('FIT 导出失败', 'error')
    }
  }, [config, pushToast, routePoints.length, stats])

  const downloadAllProfiles = useCallback((): void => {
    setErrorText('')
    if (routePoints.length < 2) {
      setErrorText('至少需要 2 个轨迹点才能导出 FIT 文件')
      return
    }

    const startDate = new Date(config.startTime)
    if (Number.isNaN(startDate.getTime())) {
      setErrorText('开始时间格式不正确')
      return
    }

    if (config.paceMinPerKm <= 0 || config.sampleIntervalSec <= 0) {
      setErrorText('配速和采样间隔必须大于 0')
      return
    }

    try {
      if (stats.sampledPoints.length < 2) {
        throw new Error('采样后的轨迹点不足，请调整路线或参数')
      }

      const fileDate = startDate.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, '')
      const safeName = config.activityName.replace(/[^a-zA-Z0-9_-]+/g, '_')

      for (const profile of KEEP_PROFILES) {
        const profileConfig: ExportConfig = {
          ...config,
          keepCompatibilityProfile: profile,
        }

        const encoder = new RunningFitEncoder(stats.sampledPoints, profileConfig, stats)
        const file = encoder.getFile()
        const copiedBytes = new Uint8Array(file.byteLength)
        copiedBytes.set(new Uint8Array(file))
        const blob = new Blob([copiedBytes.buffer], { type: 'application/octet-stream' })
        const url = URL.createObjectURL(blob)

        const filename = `${safeName || 'keep_run'}_${profile}_${fileDate}.fit`
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(url)
      }
      pushToast('已导出全部兼容策略', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(`批量 FIT 生成失败：${message}`)
      pushToast('批量导出失败', 'error')
    }
  }, [config, pushToast, routePoints.length, stats])

  const buildBatchPlan = (): PlannedBatchActivity[] => {
    const start = new Date(batchConfig.startDate)
    const end = new Date(batchConfig.endDate)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      throw new Error('批量日期范围无效')
    }
    const activeWindows = batchConfig.windows.filter((w) => w.enabled)
    if (activeWindows.length === 0) {
      throw new Error('至少启用一个时间段')
    }
    const dates = listDatesInclusive(start, end)
    const plan: PlannedBatchActivity[] = []
    for (const day of dates) {
      const weekday = day.getDay()
      if (!batchConfig.weekdays[weekday]) continue
      const chosenWindow = activeWindows[Math.floor(Math.random() * activeWindows.length)]
      const s = parseTimeToMinutes(chosenWindow.start)
      const e = parseTimeToMinutes(chosenWindow.end)
      if (e <= s) continue
      const randomMinute = Math.round(randomBetween(s, e))
      const startTime = new Date(day)
      startTime.setHours(0, 0, 0, 0)
      startTime.setMinutes(randomMinute)

      const angle = randomBetween(0, Math.PI * 2)
      const offset = randomBetween(0, batchConfig.routeOffsetMeters)
      const baseShift = shiftRouteByMeters(routePoints, Math.cos(angle) * offset, Math.sin(angle) * offset)
      const lateralShifted = applyLateralOffset(baseShift, batchConfig.lateralOffsetMeters)
      const jittered = jitterRoutePoints(lateralShifted, batchConfig.pointJitterMeters)
      const distanceFactor =
        1 + randomBetween(-batchConfig.distanceJitterPercent, batchConfig.distanceJitterPercent) / 100
      const shiftedRoute = trimRouteToDistance(jittered, Math.max(0.4, distanceFactor))
      const paceFactor = 1 + randomBetween(-batchConfig.paceJitterPercent, batchConfig.paceJitterPercent) / 100
      plan.push({
        id: `${day.toISOString()}-${Math.round(randomBetween(1, 999999))}`,
        startTime,
        shiftedRoute,
        profile: config.keepCompatibilityProfile,
        paceFactor,
        distanceFactor,
        estimatedDistanceMeters: distanceOfPath(shiftedRoute),
        lockedStart: false,
      })
    }
    return plan
  }

  const generateBatchPreview = (): void => {
    try {
      const plan = buildBatchPlan()
      if (plan.length === 0) {
        throw new Error('未生成任何批量活动，请检查日期与时间段')
      }
      setBatchPreview(plan)
      pushToast(`已生成预览：${plan.length} 条`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(`预览生成失败：${message}`)
      pushToast('预览生成失败', 'error')
    }
  }

  const clearBatchPreview = (): void => {
    setBatchPreview([])
  }

  const removeBatchPreviewItem = (id: string): void => {
    setBatchPreview((prev) => prev.filter((item) => item.id !== id))
  }

  const rerandomizeBatchPreviewItem = (id: string): void => {
    setBatchPreview((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item
        const angle = randomBetween(0, Math.PI * 2)
        const offset = randomBetween(0, batchConfig.routeOffsetMeters)
        const baseShift = shiftRouteByMeters(routePoints, Math.cos(angle) * offset, Math.sin(angle) * offset)
        const lateralShifted = applyLateralOffset(baseShift, batchConfig.lateralOffsetMeters)
        const jittered = jitterRoutePoints(lateralShifted, batchConfig.pointJitterMeters)
        const distanceFactor =
          1 + randomBetween(-batchConfig.distanceJitterPercent, batchConfig.distanceJitterPercent) / 100
        const shiftedRoute = trimRouteToDistance(jittered, Math.max(0.4, distanceFactor))
        const paceFactor = 1 + randomBetween(-batchConfig.paceJitterPercent, batchConfig.paceJitterPercent) / 100
        return {
          ...item,
          shiftedRoute,
          distanceFactor,
          paceFactor,
          estimatedDistanceMeters: distanceOfPath(shiftedRoute),
        }
      }),
    )
  }

  const updateBatchPreviewStartTime = (id: string, value: string): void => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return
    }
    setBatchPreview((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              startTime: date,
              lockedStart: true,
            }
          : item,
      ),
    )
  }

  const toggleBatchPreviewLock = (id: string): void => {
    setBatchPreview((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              lockedStart: !item.lockedStart,
            }
          : item,
      ),
    )
  }

  const downloadBatchFits = (): void => {
    setErrorText('')
    if (routePoints.length < 2) {
      setErrorText('批量生成前请先准备轨迹')
      return
    }
    try {
      const plan = batchPreview.length > 0 ? batchPreview : buildBatchPlan()
      if (plan.length === 0) {
        throw new Error('批量计划为空，请检查日期、星期和时间段')
      }
      const safeName = config.activityName.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'keep_batch'
      for (const item of plan) {
        const cfg: ExportConfig = {
          ...config,
          startTime: formatDateTimeLocal(item.startTime),
          paceMinPerKm: clampNumber(config.paceMinPerKm * item.paceFactor, 2, 12),
        }
        const batchStats = computeStats(item.shiftedRoute, cfg)
        const encoder = new RunningFitEncoder(batchStats.sampledPoints, cfg, batchStats)
        const file = encoder.getFile()
        const copiedBytes = new Uint8Array(file.byteLength)
        copiedBytes.set(new Uint8Array(file))
        const blob = new Blob([copiedBytes.buffer], { type: 'application/octet-stream' })
        const url = URL.createObjectURL(blob)
        const stamp = item.startTime.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, '')
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `${safeName}_${stamp}.fit`
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(url)
      }
      pushToast(`批量生成完成：${plan.length} 个活动`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(`批量生成失败：${message}`)
      pushToast('批量生成失败', 'error')
    }
  }

  useEffect(() => {
    void initializeMap()

    return () => {
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
      }
    }
  }, [initializeMap])

  useEffect(() => {
    scheduleMapOverlays()
    return () => {
      if (overlayRafRef.current !== null) {
        window.cancelAnimationFrame(overlayRafRef.current)
        overlayRafRef.current = null
      }
    }
  }, [scheduleMapOverlays])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) {
        return
      }
      if (event.key.toLowerCase() === 's' && event.shiftKey) {
        event.preventDefault()
        downloadAllProfiles()
        return
      }
      if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        downloadFit()
        return
      }
      if (event.key.toLowerCase() === 'l') {
        event.preventDefault()
        fitToRoute()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [downloadAllProfiles, downloadFit, fitToRoute])

  useEffect(() => {
    localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({ themeMode, densityMode, tileSource }))
  }, [themeMode, densityMode, tileSource])

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const width = window.innerWidth || 1
      const height = window.innerHeight || 1
      const x = ((event.clientX / width) * 2 - 1) * 10
      const y = ((event.clientY / height) * 2 - 1) * 10
      setTilt({ x, y })
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  if (showOnboarding) {
    return (
      <div className={`app-shell theme-${themeMode} density-${densityMode} onboarding-shell`}>
        <div className="liquid-bg">
          <span className="orb orb-a" />
          <span className="orb orb-b" />
          <span className="orb orb-c" />
        </div>
        <section
          ref={heroRef}
          className="onboarding-card"
          style={{ transform: `translate3d(${tilt.x * 0.35}px, ${tilt.y * 0.35}px, 0)` }}
        >
          <p className="onboarding-kicker">Liquid Glass Experience</p>
          <h1>欢迎来到 Keep FIT 轨迹工作台</h1>
          <p className="hint">
            先通过 30 秒引导完成地图与导出策略选择，再进入完整功能界面。当前为免 API 瓦片地图，天然 WGS84。
          </p>
          <div className="onboarding-points">
            <div>
              <strong>1</strong>
              <span>选择地图源（OSM / CARTO）</span>
            </div>
            <div>
              <strong>2</strong>
              <span>绘制或导入轨迹</span>
            </div>
            <div>
              <strong>3</strong>
              <span>选择兼容策略并导出</span>
            </div>
          </div>
          <div className="button-row onboarding-actions">
            <button type="button" className="download" onClick={finishOnboarding}>
              开始使用工作台
            </button>
            <button
              type="button"
              className="download ghost"
              onClick={() => setThemeMode((prev) => (prev === 'light' ? 'dark' : 'light'))}
            >
              切换{themeMode === 'light' ? '深色' : '浅色'}外观
            </button>
            <a
              className="download ghost star-btn"
              href="https://github.com/dentar142/Fit-Running"
              target="_blank"
              rel="noopener noreferrer"
            >
              Star on GitHub
            </a>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className={`app-shell theme-${themeMode} density-${densityMode} mode-${interactionMode}`}>
      <header className="topbar">
        <div>
          <h1>Keep FIT 轨迹生成器</h1>
          <p className="hint">免 API 地图绘制轨迹（WGS84）+ 参数化生成 + 多策略兼容导出</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="quick-btn" onClick={() => setThemeMode((prev) => (prev === 'light' ? 'dark' : 'light'))}>
            {themeMode === 'light' ? '深色' : '浅色'}
          </button>
          <button
            type="button"
            className="quick-btn"
            onClick={() => setDensityMode((prev) => (prev === 'comfortable' ? 'compact' : 'comfortable'))}
          >
            {densityMode === 'comfortable' ? '紧凑' : '舒适'}
          </button>
          <button
            type="button"
            className="quick-btn"
            onClick={() => {
              setInteractionMode((prev) => (prev === 'guided' ? 'control' : 'guided'))
              setGuidedStep('map')
            }}
          >
            {interactionMode === 'guided' ? '切换完全控制' : '切换引导式'}
          </button>
          <button type="button" className="quick-btn" onClick={downloadFit}>
            快速导出
          </button>
          <button type="button" className="quick-btn" onClick={resetOnboarding}>
            返回引导页
          </button>
          <button type="button" className="quick-btn" onClick={exportConfigSnapshot}>
            导出配置
          </button>
          <button
            type="button"
            className="quick-btn"
            onClick={() => {
              if (configInputRef.current) {
                configInputRef.current.value = ''
                configInputRef.current.click()
              }
            }}
          >
            导入配置
          </button>
          <a
            className="quick-btn star-btn"
            href="https://github.com/dentar142/Fit-Running"
            target="_blank"
            rel="noopener noreferrer"
          >
            Star on GitHub
          </a>
        </div>
      </header>
      <aside className="panel">
        <input
          ref={configInputRef}
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            void importConfigSnapshot(event)
          }}
          hidden
        />
        <p className="hint tiny">建议流程：画路线 → 调参数 → 批量设置 → 导出验证。</p>
        <p className="hint tiny">坐标系：当前地图与导出均为原生 WGS84（无需转换算法）。</p>
        <p className="hint tiny">当前交互模式：{interactionMode === 'guided' ? '引导式（Apple Liquid Glass）' : '完全控制式（Fluent）'}</p>

        <section className={`card ${isSectionVisible('map') ? '' : 'module-hidden'}`}>
          <h2>1) 免API地图</h2>
          <button type="button" className="collapse-btn" onClick={() => setCollapsed((prev) => ({ ...prev, map: !prev.map }))}>
            {collapsed.map ? '展开' : '折叠'}
          </button>
          {!collapsed.map ? (
            <>
          <label>
            地图样式
            <select value={tileSource} onChange={(event) => setTileSource(event.target.value as NoApiTileSource)}>
              <option value="osm">OpenStreetMap（免API）</option>
              <option value="carto_light">CARTO Light（免API）</option>
              <option value="carto_dark">CARTO Dark（免API）</option>
            </select>
          </label>
          <button type="button" onClick={() => void loadMapWithCurrentKey()}>
            加载地图
          </button>
          <p className="status">{mapStatus}</p>
          {interactionMode === 'guided' ? (
            <div className="button-row">
              <button type="button" className="download" onClick={() => goToNextGuidedStep('map')}>
                下一步：轨迹编辑
              </button>
            </div>
          ) : null}
            </>
          ) : null}
        </section>

        <section className={`card ${isSectionVisible('route') ? '' : 'module-hidden'}`}>
          <h2>2) 路线编辑</h2>
          <button type="button" className="collapse-btn" onClick={() => setCollapsed((prev) => ({ ...prev, route: !prev.route }))}>
            {collapsed.route ? '展开' : '折叠'}
          </button>
          {!collapsed.route ? (
            <>
          <input
            ref={geoJsonInputRef}
            type="file"
            accept=".geojson,.json,application/geo+json,application/json"
            onChange={(event) => {
              void handleGeoJsonFileChange(event)
            }}
            hidden
          />
          <input
            ref={routeFileInputRef}
            type="file"
            accept=".geojson,.json,.gpx,.tcx,application/geo+json,application/json,application/xml,text/xml"
            onChange={(event) => {
              void handleRouteFileChange(event)
            }}
            hidden
          />
          <div className="button-row">
            <button type="button" onClick={undoPoint} disabled={routePoints.length === 0}>
              撤销最后一点
            </button>
            <button type="button" onClick={clearRoute} disabled={routePoints.length === 0}>
              清空轨迹
            </button>
            <button type="button" onClick={fitToRoute} disabled={routePoints.length === 0}>
              视野适配
            </button>
            <button type="button" onClick={reverseRoute} disabled={routePoints.length < 2}>
              反转方向
            </button>
            <button type="button" onClick={closeRouteLoop} disabled={routePoints.length < 2}>
              闭环连接
            </button>
            <button type="button" onClick={fixRouteOneClick} disabled={routePoints.length < 2}>
              一键修复
            </button>
            <button type="button" onClick={rollbackRoute}>
              回退快照
            </button>
          </div>
          <p className="status">当前点数：{routePoints.length}</p>

          <label>
            批量导入坐标（每行：lng,lat）
            <textarea
              rows={5}
              value={bulkInput}
              onChange={(event) => setBulkInput(event.target.value)}
              placeholder="116.397428,39.90923"
            />
          </label>

          <div className="button-row">
            <button type="button" onClick={() => handleImport(false)}>
              追加导入
            </button>
            <button type="button" onClick={() => handleImport(true)}>
              覆盖导入
            </button>
            <button type="button" onClick={() => openGeoJsonPicker(false)}>
              导入GeoJSON(追加)
            </button>
            <button type="button" onClick={() => openGeoJsonPicker(true)}>
              导入GeoJSON(覆盖)
            </button>
            <button type="button" onClick={() => openRouteFilePicker(false)}>
              导入GPX/TCX(追加)
            </button>
            <button type="button" onClick={() => openRouteFilePicker(true)}>
              导入GPX/TCX(覆盖)
            </button>
          </div>
          {interactionMode === 'guided' ? (
            <div className="button-row">
              <button type="button" className="download" onClick={() => goToNextGuidedStep('route')}>
                下一步：参数配置
              </button>
            </div>
          ) : null}
            </>
          ) : null}
        </section>

        <section className={`card ${isSectionVisible('params') ? '' : 'module-hidden'}`}>
          <h2>3) 运动参数</h2>
          <button type="button" className="collapse-btn" onClick={() => setCollapsed((prev) => ({ ...prev, params: !prev.params }))}>
            {collapsed.params ? '展开' : '折叠'}
          </button>
          {!collapsed.params ? (
            <>
          <label>
            参数预设名
            <input
              value={presetNameInput}
              onChange={(event) => setPresetNameInput(event.target.value)}
              placeholder="例如：5K_晨跑_稳定版"
            />
          </label>
          <div className="button-row">
            <button type="button" onClick={saveCurrentPreset}>
              保存当前参数为预设
            </button>
          </div>

          <label>
            选择参数预设
            <select value={selectedPresetName} onChange={(event) => setSelectedPresetName(event.target.value)}>
              <option value="">请选择</option>
              {configPresets.map((preset) => (
                <option key={preset.name} value={preset.name}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button type="button" onClick={applySelectedPreset}>
              应用预设
            </button>
            <button type="button" onClick={deleteSelectedPreset} disabled={selectedPresetName.length === 0}>
              删除预设
            </button>
          </div>

          <label>
            活动名称
            <input
              value={config.activityName}
              onChange={(event) =>
                setConfig((prev) => ({
                  ...prev,
                  activityName: event.target.value,
                }))
              }
            />
          </label>

          <label>
            Keep 兼容策略
            <select
              value={config.keepCompatibilityProfile}
              onChange={(event) =>
                setConfig((prev) => ({
                  ...prev,
                  keepCompatibilityProfile: event.target.value as KeepCompatibilityProfile,
                }))
              }
            >
              <option value="balanced">{KEEP_PROFILE_LABEL.balanced}</option>
              <option value="strict_keep">{KEEP_PROFILE_LABEL.strict_keep}</option>
              <option value="legacy_simple">{KEEP_PROFILE_LABEL.legacy_simple}</option>
              <option value="aggressive_minimal">{KEEP_PROFILE_LABEL.aggressive_minimal}</option>
              <option value="device_compat">{KEEP_PROFILE_LABEL.device_compat}</option>
            </select>
          </label>
          <p className="status">{KEEP_PROFILE_DESC[config.keepCompatibilityProfile]}</p>

          <label>
            采样策略
            <select
              value={config.samplingStrategy}
              onChange={(event) =>
                setConfig((prev) => ({
                  ...prev,
                  samplingStrategy: event.target.value as SamplingStrategy,
                }))
              }
            >
              <option value="distance">按距离采样（稳定）</option>
              <option value="time">按时间采样（真实时序）</option>
            </select>
          </label>

          <label>
            开始时间
            <input
              type="datetime-local"
              value={config.startTime}
              onChange={(event) =>
                setConfig((prev) => ({
                  ...prev,
                  startTime: event.target.value,
                }))
              }
            />
          </label>

          <div className="grid-two">
            <label>
              配速 (min/km)
              <input
                type="number"
                min={2}
                step={0.1}
                value={config.paceMinPerKm}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    paceMinPerKm: clampNumber(Number(event.target.value), 2, 12),
                  }))
                }
              />
            </label>
            <label>
              采样间隔 (s)
              <input
                type="number"
                min={1}
                step={0.5}
                value={config.sampleIntervalSec}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    sampleIntervalSec: clampNumber(Number(event.target.value), 1, 20),
                  }))
                }
              />
            </label>
            <label>
              起始心率
              <input
                type="number"
                min={60}
                max={220}
                value={config.heartRateStart}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    heartRateStart: clampNumber(Number(event.target.value), 60, 220),
                  }))
                }
              />
            </label>
            <label>
              结束心率
              <input
                type="number"
                min={60}
                max={220}
                value={config.heartRateEnd}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    heartRateEnd: clampNumber(Number(event.target.value), 60, 220),
                  }))
                }
              />
            </label>
            <label>
              步频 (spm)
              <input
                type="number"
                min={100}
                max={210}
                value={config.cadence}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    cadence: clampNumber(Number(event.target.value), 100, 210),
                  }))
                }
              />
            </label>
            <label>
              卡路里 (kcal/km)
              <input
                type="number"
                min={20}
                step={1}
                value={config.caloriesPerKm}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    caloriesPerKm: clampNumber(Number(event.target.value), 20, 200),
                  }))
                }
              />
            </label>
            <label>
              基础海拔 (m)
              <input
                type="number"
                value={config.baseAltitude}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    baseAltitude: clampNumber(Number(event.target.value), -100, 4000),
                  }))
                }
              />
            </label>
            <label>
              海拔波动 (m)
              <input
                type="number"
                min={0}
                step={0.5}
                value={config.altitudeSwing}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    altitudeSwing: clampNumber(Number(event.target.value), 0, 120),
                  }))
                }
              />
            </label>
            <label>
              平滑窗口 (点)
              <input
                type="number"
                min={0}
                max={15}
                step={1}
                value={config.smoothWindowSize}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    smoothWindowSize: clampNumber(Number(event.target.value), 0, 15),
                  }))
                }
              />
            </label>
            <label>
              精简阈值 (m)
              <input
                type="number"
                min={0}
                max={50}
                step={0.5}
                value={config.simplifyToleranceMeters}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    simplifyToleranceMeters: clampNumber(Number(event.target.value), 0, 50),
                  }))
                }
              />
            </label>
            <label>
              最大段长阈值 (m)
              <input
                type="number"
                min={50}
                max={10000}
                step={10}
                value={config.maxSegmentMeters}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    maxSegmentMeters: clampNumber(Number(event.target.value), 50, 10000),
                  }))
                }
              />
            </label>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={config.autoCleanup}
              onChange={(event) =>
                setConfig((prev) => ({
                  ...prev,
                  autoCleanup: event.target.checked,
                }))
              }
            />
            导出前自动清洗（去重点 + 超长跳点过滤）
          </label>

          <p className="hint tiny">
            建议：平滑窗口 3~5，精简阈值 2~6m，最大段长 800~1500m。自动清洗开启时能减少异常跳点。
          </p>
          {interactionMode === 'guided' ? (
            <div className="button-row">
              <button type="button" className="download" onClick={() => goToNextGuidedStep('params')}>
                下一步：批量生成
              </button>
            </div>
          ) : null}
            </>
          ) : null}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={config.outAndBack}
              onChange={(event) =>
                setConfig((prev) => ({
                  ...prev,
                  outAndBack: event.target.checked,
                }))
              }
            />
            自动折返（到终点后按原路返回）
          </label>
        </section>

        <section className={`card ${isSectionVisible('batch') ? '' : 'module-hidden'}`}>
          <h2>4) 批量生成</h2>
          <label>
            开始日期
            <input
              type="date"
              value={batchConfig.startDate}
              onChange={(event) =>
                setBatchConfig((prev) => ({
                  ...prev,
                  startDate: event.target.value,
                }))
              }
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              value={batchConfig.endDate}
              onChange={(event) =>
                setBatchConfig((prev) => ({
                  ...prev,
                  endDate: event.target.value,
                }))
              }
            />
          </label>
          <p className="status">按星期选择是否生成：</p>
          <div className="button-row">
            {['日', '一', '二', '三', '四', '五', '六'].map((label, index) => (
              <button
                type="button"
                key={label}
                onClick={() =>
                  setBatchConfig((prev) => {
                    const next = [...prev.weekdays] as BatchConfig['weekdays']
                    next[index] = !next[index]
                    return { ...prev, weekdays: next }
                  })
                }
              >
                {label}:{batchConfig.weekdays[index] ? '开' : '关'}
              </button>
            ))}
          </div>
          <div className="grid-two">
            {batchConfig.windows.map((w, idx) => (
              <div key={idx}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={w.enabled}
                    onChange={(event) =>
                      setBatchConfig((prev) => ({
                        ...prev,
                        windows: prev.windows.map((item, i) => (i === idx ? { ...item, enabled: event.target.checked } : item)),
                      }))
                    }
                  />
                  时间段 {idx + 1}
                </label>
                <input
                  type="time"
                  value={w.start}
                  onChange={(event) =>
                    setBatchConfig((prev) => ({
                      ...prev,
                      windows: prev.windows.map((item, i) => (i === idx ? { ...item, start: event.target.value } : item)),
                    }))
                  }
                />
                <input
                  type="time"
                  value={w.end}
                  onChange={(event) =>
                    setBatchConfig((prev) => ({
                      ...prev,
                      windows: prev.windows.map((item, i) => (i === idx ? { ...item, end: event.target.value } : item)),
                    }))
                  }
                />
              </div>
            ))}
          </div>
          <div className="grid-two">
            <label>
              轨迹随机偏移 (m)
              <input
                type="number"
                min={0}
                max={500}
                value={batchConfig.routeOffsetMeters}
                onChange={(event) =>
                  setBatchConfig((prev) => ({
                    ...prev,
                    routeOffsetMeters: clampNumber(Number(event.target.value), 0, 500),
                  }))
                }
              />
            </label>
            <label>
              左右偏移幅度 (m)
              <input
                type="number"
                min={0}
                max={200}
                value={batchConfig.lateralOffsetMeters}
                onChange={(event) =>
                  setBatchConfig((prev) => ({
                    ...prev,
                    lateralOffsetMeters: clampNumber(Number(event.target.value), 0, 200),
                  }))
                }
              />
            </label>
            <label>
              轨迹随机打点 (m)
              <input
                type="number"
                min={0}
                max={80}
                value={batchConfig.pointJitterMeters}
                onChange={(event) =>
                  setBatchConfig((prev) => ({
                    ...prev,
                    pointJitterMeters: clampNumber(Number(event.target.value), 0, 80),
                  }))
                }
              />
            </label>
            <label>
              距离随机浮动 (%)
              <input
                type="number"
                min={0}
                max={40}
                value={batchConfig.distanceJitterPercent}
                onChange={(event) =>
                  setBatchConfig((prev) => ({
                    ...prev,
                    distanceJitterPercent: clampNumber(Number(event.target.value), 0, 40),
                  }))
                }
              />
            </label>
            <label>
              配速随机浮动 (%)
              <input
                type="number"
                min={0}
                max={30}
                value={batchConfig.paceJitterPercent}
                onChange={(event) =>
                  setBatchConfig((prev) => ({
                    ...prev,
                    paceJitterPercent: clampNumber(Number(event.target.value), 0, 30),
                  }))
                }
              />
            </label>
          </div>
          <div className="button-row">
            <button type="button" className="download ghost" onClick={generateBatchPreview}>
              生成批量预览
            </button>
            <button type="button" className="download ghost" onClick={clearBatchPreview}>
              清空预览
            </button>
            <button type="button" className="download" onClick={downloadBatchFits}>
              批量生成并下载
            </button>
          </div>
          {batchPreview.length > 0 ? (
            <>
              <p className="status">预览条目：{batchPreview.length}</p>
              <div className="batch-preview-list">
                {batchPreview.map((item, index) => (
                  <div key={item.id} className="batch-preview-item">
                    <strong>
                      {index + 1}. {item.startTime.toLocaleString()}
                    </strong>
                    <label>
                      开始时间（可锁定）
                      <input
                        type="datetime-local"
                        value={formatDateTimeLocal(item.startTime)}
                        onChange={(event) => updateBatchPreviewStartTime(item.id, event.target.value)}
                      />
                    </label>
                    <span>预计距离：{(item.estimatedDistanceMeters / 1000).toFixed(2)} km</span>
                    <span>配速系数：x{item.paceFactor.toFixed(3)}</span>
                    <span>距离系数：x{item.distanceFactor.toFixed(3)}</span>
                    <div className="button-row">
                      <button type="button" onClick={() => rerandomizeBatchPreviewItem(item.id)}>
                        单条重随机
                      </button>
                      <button type="button" onClick={() => toggleBatchPreviewLock(item.id)}>
                        {item.lockedStart ? '解除锁定' : '锁定开始时间'}
                      </button>
                      <button type="button" onClick={() => removeBatchPreviewItem(item.id)}>
                        删除该条
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {interactionMode === 'guided' ? (
            <div className="button-row">
              <button type="button" className="download" onClick={() => goToNextGuidedStep('batch')}>
                下一步：导出与检查
              </button>
            </div>
          ) : null}
        </section>

        <section className={`card ${isSectionVisible('export') ? '' : 'module-hidden'}`}>
          <h2>4) 导出 FIT</h2>
          <button type="button" className="collapse-btn" onClick={() => setCollapsed((prev) => ({ ...prev, export: !prev.export }))}>
            {collapsed.export ? '展开' : '折叠'}
          </button>
          {!collapsed.export ? (
            <>
          <ul className="summary">
            <li>距离：{(stats.distanceMeters / 1000).toFixed(2)} km</li>
            <li>时长：{Math.round(stats.durationSec / 60)} min</li>
            <li>采样点：{stats.sampledPoints.length}</li>
            <li>原始点：{routePoints.length}</li>
            <li>处理后点：{stats.processedPoints.length}</li>
            <li>重复段：{stats.report.duplicatePoints}</li>
            <li>跳点段：{stats.report.jumpSegments}</li>
            <li>最大段长：{stats.report.maxSegmentMeters.toFixed(1)} m</li>
            <li>质量评分：{qualityScore} / 100</li>
            <li>风险等级：{getRiskLevel(qualityScore)}</li>
          </ul>

          <div className="button-stack">
            <button type="button" className="download" onClick={downloadFit}>
              生成当前策略 .fit
            </button>
            <button type="button" className="download ghost" onClick={downloadAllProfiles}>
              一键导出全部策略（5份）
            </button>
            <button type="button" className="download ghost" onClick={exportGeoJson}>
              导出 GeoJSON
            </button>
            <button type="button" className="download ghost" onClick={exportGpx}>
              导出 GPX
            </button>
            <button type="button" className="download ghost" onClick={exportTcx}>
              导出 TCX
            </button>
          </div>
          {errorText.length > 0 ? <p className="error">{errorText}</p> : null}
          {diagnosis.length > 0 ? <p className="status">{diagnosis}</p> : null}
          <p className="hint tiny">
            当前策略：{KEEP_PROFILE_LABEL[config.keepCompatibilityProfile]}。导入失败时建议按顺序尝试：平衡 → Keep优先 →
            简化兼容。
          </p>
          {qualityScore < 70 ? (
            <p className="status">诊断建议：当前轨迹质量偏低，建议开启自动清洗并增大平滑窗口。</p>
          ) : null}
            </>
          ) : null}
        </section>
      </aside>

      <main className="map-stage">
        <div ref={mapContainerRef} className="map" />
      </main>
      {toast ? <div className={`toast toast-${toast.kind}`}>{toast.message}</div> : null}
    </div>
  )
}

export default App
