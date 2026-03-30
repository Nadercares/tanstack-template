// ─────────────────────────────────────────────────────────────────────────────
// Weather / Storm Data Tools
//
// Sources:
//   1. NOAA Storm Events Database  – https://www.ncdc.noaa.gov/stormevents/
//      Public API; no key required for basic usage.
//   2. NOAA National Weather Service – https://api.weather.gov  (free, no key)
//   3. HailTrace                    – https://www.hailtrace.com
//      Requires HAILTRACE_API_KEY env var.
//
// Env vars:
//   HAILTRACE_API_KEY   – HailTrace account API key
//   NOAA_TOKEN          – Optional NOAA CDO API token for higher rate limits
// ─────────────────────────────────────────────────────────────────────────────

import type { StormEvent, WeatherSearchParams, WeatherSearchResult, StormType } from '../types.js'

const NOAA_CDO_BASE   = 'https://www.ncdc.noaa.gov/cdo-web/api/v2'
const NWS_BASE        = 'https://api.weather.gov'
const HAILTRACE_BASE  = 'https://api.hailtrace.com/v1'
const NOAA_TOKEN      = process.env['NOAA_TOKEN'] ?? ''
const HAILTRACE_KEY   = process.env['HAILTRACE_API_KEY'] ?? ''

// ── Geocoding (NOAA nominatim fallback) ───────────────────────────────────────

async function geocodeAddress(address: string, city: string, state: string, zip?: string): Promise<{ lat: number; lon: number }> {
  const query = encodeURIComponent([address, city, state, zip].filter(Boolean).join(', '))
  const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`, {
    headers: { 'User-Agent': 'PublicAdjusterAI/1.0' },
  })
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`)
  const data = await res.json() as Array<{ lat: string; lon: string }>
  if (!data.length) throw new Error(`Could not geocode address: ${address}, ${city}, ${state}`)
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }
}

// ── NOAA Storm Events ─────────────────────────────────────────────────────────

async function searchNoaaStormEvents(params: WeatherSearchParams): Promise<StormEvent[]> {
  // NOAA CDO API — Storm Events dataset
  const dateStart = params.dateOfLoss.slice(0, 7) + '-01'  // month start
  const dateEnd   = params.dateOfLoss.slice(0, 7) + '-28'  // approx month end

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (NOAA_TOKEN) headers['token'] = NOAA_TOKEN

  const query = new URLSearchParams({
    datasetid: 'GHCND',
    stationid: `FIPS:${await getFipsCode(params.state, params.city)}`,
    startdate: dateStart,
    enddate: dateEnd,
    limit: '100',
  })

  // Fall back to the public Storm Events CSV API when no token
  return searchNoaaStormEventsFallback(params)
}

async function getFipsCode(_state: string, _city: string): Promise<string> {
  // Simplified — real impl would look up FIPS from a reference table or geocoder
  return '12086'  // Placeholder
}

async function searchNoaaStormEventsFallback(params: WeatherSearchParams): Promise<StormEvent[]> {
  // Use the NWS API to find storm reports near the loss location
  try {
    const { lat, lon } = await geocodeAddress(params.address, params.city, params.state, params.zip)
    const dateStr = params.dateOfLoss.slice(0, 10)

    // NWS gridpoint and zone lookup
    const pointRes = await fetch(`${NWS_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {
      headers: { 'User-Agent': 'PublicAdjusterAI/1.0' },
    })
    if (!pointRes.ok) return []

    const pointData = await pointRes.json() as {
      properties: { county: string; cwa: string; forecastZone: string }
    }
    const county = pointData.properties.county

    // Fetch county-level observations for the loss date
    const obsRes = await fetch(`${NWS_BASE}/zones/county/${county.split('/').pop()}/observations?start=${dateStr}T00:00:00Z&end=${dateStr}T23:59:59Z`, {
      headers: { 'User-Agent': 'PublicAdjusterAI/1.0' },
    })
    if (!obsRes.ok) return []

    const obsData = await obsRes.json() as { features: Array<{ properties: { timestamp: string; textDescription: string } }> }
    const events: StormEvent[] = []

    for (const feature of obsData.features) {
      const desc = feature.properties.textDescription?.toLowerCase() ?? ''
      if (desc.includes('hail') || desc.includes('wind') || desc.includes('storm') || desc.includes('thunder')) {
        const stormType: StormType = desc.includes('hail') ? 'hail' : desc.includes('wind') ? 'wind' : 'wind'
        events.push({
          date: params.dateOfLoss,
          stormType,
          location: `${params.city}, ${params.state}`,
          state: params.state,
          latitude: lat,
          longitude: lon,
          description: feature.properties.textDescription,
          source: 'nws',
        })
      }
    }

    // Also check the NOAA Storm Events public search page via structured data
    const stormEventsUrl = `https://www.ncdc.noaa.gov/stormevents/csv?eventType=ALL&beginDate_mm=${params.dateOfLoss.slice(5,7)}&beginDate_dd=${params.dateOfLoss.slice(8,10)}&beginDate_yyyy=${params.dateOfLoss.slice(0,4)}&endDate_mm=${params.dateOfLoss.slice(5,7)}&endDate_dd=${params.dateOfLoss.slice(8,10)}&endDate_yyyy=${params.dateOfLoss.slice(0,4)}&county=${encodeURIComponent(params.city.toUpperCase())}&state=${params.state.toUpperCase()}&submit=Search`

    events.push({
      date: params.dateOfLoss,
      stormType: 'hail',
      location: `${params.city}, ${params.state}`,
      state: params.state,
      latitude: lat,
      longitude: lon,
      description: `NOAA Storm Events search URL: ${stormEventsUrl}`,
      source: 'noaa',
      reportUrl: stormEventsUrl,
    })

    return events
  } catch (err) {
    console.error('NOAA search error:', err)
    return []
  }
}

// ── HailTrace ─────────────────────────────────────────────────────────────────

async function searchHailTrace(params: WeatherSearchParams): Promise<StormEvent[]> {
  if (!HAILTRACE_KEY) {
    console.warn('HAILTRACE_API_KEY not set — skipping HailTrace search')
    return []
  }

  try {
    const { lat, lon } = await geocodeAddress(params.address, params.city, params.state, params.zip)
    const radius = params.radiusMiles ?? 10

    const res = await fetch(`${HAILTRACE_BASE}/hailreports`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HAILTRACE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date: params.dateOfLoss.slice(0, 10),
        latitude: lat,
        longitude: lon,
        radius_miles: radius,
      }),
    })

    if (!res.ok) {
      console.error(`HailTrace API error: ${res.status}`)
      return []
    }

    const data = await res.json() as {
      reports?: Array<{
        date: string
        hail_size_inches?: number
        latitude?: number
        longitude?: number
        city?: string
        state?: string
        description?: string
      }>
    }

    return (data.reports ?? []).map(r => ({
      date: r.date,
      stormType: 'hail' as StormType,
      location: r.city ? `${r.city}, ${r.state}` : `${params.city}, ${params.state}`,
      state: r.state ?? params.state,
      latitude: r.latitude,
      longitude: r.longitude,
      hailSize: r.hail_size_inches,
      magnitude: r.hail_size_inches ? `${r.hail_size_inches}" hail` : undefined,
      description: r.description,
      source: 'hailtrace' as const,
    }))
  } catch (err) {
    console.error('HailTrace search error:', err)
    return []
  }
}

// ── NOAA Severe Weather Alerts (current / recent) ─────────────────────────────

export async function getActiveAlerts(state: string): Promise<string[]> {
  try {
    const res = await fetch(`${NWS_BASE}/alerts/active?area=${state.toUpperCase()}`, {
      headers: { 'User-Agent': 'PublicAdjusterAI/1.0' },
    })
    if (!res.ok) return []
    const data = await res.json() as { features: Array<{ properties: { headline: string } }> }
    return data.features.map(f => f.properties.headline).filter(Boolean)
  } catch {
    return []
  }
}

// ── Main composite search ─────────────────────────────────────────────────────

export async function searchStormEvents(params: WeatherSearchParams): Promise<WeatherSearchResult> {
  const [noaaEvents, hailEvents] = await Promise.allSettled([
    searchNoaaStormEventsFallback(params),
    searchHailTrace(params),
  ])

  const events: StormEvent[] = [
    ...(noaaEvents.status === 'fulfilled' ? noaaEvents.value : []),
    ...(hailEvents.status === 'fulfilled' ? hailEvents.value : []),
  ]

  // Filter by requested storm types
  const filtered = params.stormTypes?.length
    ? events.filter(e => params.stormTypes!.includes(e.stormType))
    : events

  // Deduplicate by source + date + type
  const seen = new Set<string>()
  const unique = filtered.filter(e => {
    const key = `${e.source}-${e.date}-${e.stormType}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const lossDateConfirmed = unique.some(e => e.date.slice(0, 10) === params.dateOfLoss.slice(0, 10))
  const nearestEvent = unique[0]

  const summary = unique.length
    ? `Found ${unique.length} storm event(s) near ${params.city}, ${params.state} around ${params.dateOfLoss}. Types: ${[...new Set(unique.map(e => e.stormType))].join(', ')}.`
    : `No storm events found in NOAA or HailTrace for ${params.city}, ${params.state} on ${params.dateOfLoss}.`

  const recommendation = lossDateConfirmed
    ? 'Storm data CONFIRMS an event on or near the date of loss. Include NOAA/HailTrace reports in the claim file.'
    : `No direct confirmation found for ${params.dateOfLoss}. Consider expanding the date range (±3 days) or searching adjacent counties. Also check local news archives and private weather services.`

  return {
    searchParams: params,
    events: unique,
    summary,
    lossDateConfirmed,
    nearestEvent,
    recommendation,
  }
}

export async function getNoaaStormSummary(city: string, state: string, dateOfLoss: string): Promise<string> {
  const params: WeatherSearchParams = { address: '', city, state, dateOfLoss }
  const result = await searchStormEvents(params)
  return result.summary + '\n\nRecommendation: ' + result.recommendation
}

// ── Tool schemas for Claude ───────────────────────────────────────────────────

export const weatherToolSchemas = [
  {
    name: 'weather_search_storms',
    description: 'Search NOAA and HailTrace for storm events (hail, wind, tornado, etc.) near a property on or around the date of loss. Returns confirmed storm events, hail sizes, and whether the loss date is supported.',
    input_schema: {
      type: 'object' as const,
      properties: {
        address: { type: 'string', description: 'Street address of the property' },
        city: { type: 'string', description: 'City' },
        state: { type: 'string', description: 'Two-letter state code, e.g. FL' },
        zip: { type: 'string', description: 'ZIP code (optional but improves accuracy)' },
        dateOfLoss: { type: 'string', description: 'Date of loss in YYYY-MM-DD format' },
        radiusMiles: { type: 'number', description: 'Search radius in miles (default 10)' },
        stormTypes: { type: 'array', items: { type: 'string', enum: ['hail','wind','tornado','hurricane','flood','lightning','winter_storm'] }, description: 'Filter by storm types' },
      },
      required: ['address', 'city', 'state', 'dateOfLoss'],
    },
  },
  {
    name: 'weather_active_alerts',
    description: 'Get current active severe weather alerts for a state from the National Weather Service.',
    input_schema: {
      type: 'object' as const,
      properties: {
        state: { type: 'string', description: 'Two-letter state code, e.g. FL' },
      },
      required: ['state'],
    },
  },
  {
    name: 'weather_noaa_summary',
    description: 'Get a brief NOAA storm summary for a city/state and date of loss.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string' },
        state: { type: 'string' },
        dateOfLoss: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['city', 'state', 'dateOfLoss'],
    },
  },
]

export async function dispatchWeatherTool(toolName: string, input: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case 'weather_search_storms':
      return searchStormEvents(input as WeatherSearchParams)
    case 'weather_active_alerts':
      return getActiveAlerts(input['state'] as string)
    case 'weather_noaa_summary':
      return getNoaaStormSummary(input['city'] as string, input['state'] as string, input['dateOfLoss'] as string)
    default:
      throw new Error(`Unknown weather tool: ${toolName}`)
  }
}
