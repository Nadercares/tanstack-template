// ─────────────────────────────────────────────────────────────────────────────
// Analytics Tools
//
// Pulls historical claims data (from ClaimWizard or local store) and
// computes statistics, patterns, and resolution recommendations.
// ─────────────────────────────────────────────────────────────────────────────

import type { Claim, ClaimDataPoint, AnalyticsReport, ClaimInsight } from '../types.js'

// ── Data aggregation ──────────────────────────────────────────────────────────

export async function buildDataPoints(claims: Claim[]): Promise<ClaimDataPoint[]> {
  return claims
    .filter(c => c.status === 'closed_paid' || c.status === 'closed_denied')
    .map(c => {
      const lossDate    = new Date(c.dateOfLoss)
      const updatedDate = new Date(c.lastUpdated)
      const daysToSettle = Math.round((updatedDate.getTime() - lossDate.getTime()) / (1000 * 60 * 60 * 24))

      return {
        claimId:          c.id,
        claimType:        c.claimType,
        insuranceCompany: c.insuranceCompany,
        state:            c.state,
        dateOfLoss:       c.dateOfLoss,
        estimatedValue:   c.estimatedValue   ?? 0,
        settledAmount:    c.settledAmount    ?? 0,
        daysToSettle:     Math.max(0, daysToSettle),
        outcome:          c.status === 'closed_paid' ? 'paid_full' : 'denied',
        resolutionMethod: c.status === 'closed_paid' ? 'negotiation' : 'pending',
        hadAppraisal:     false,
      }
    })
}

export async function generateAnalyticsReport(claims: Claim[]): Promise<AnalyticsReport> {
  const dataPoints = await buildDataPoints(claims)
  const closedClaims = dataPoints.filter(d => d.outcome !== 'pending')

  const totalClaims = claims.length
  const avgSettlement = closedClaims.length
    ? closedClaims.reduce((sum, d) => sum + d.settledAmount, 0) / closedClaims.length
    : 0
  const avgDaysToSettle = closedClaims.length
    ? closedClaims.reduce((sum, d) => sum + d.daysToSettle, 0) / closedClaims.length
    : 0

  // Settlement rate by carrier
  const byCarrier: Record<string, { total: number; paid: number }> = {}
  for (const d of closedClaims) {
    if (!byCarrier[d.insuranceCompany]) byCarrier[d.insuranceCompany] = { total: 0, paid: 0 }
    byCarrier[d.insuranceCompany].total++
    if (d.outcome === 'paid_full' || d.outcome === 'paid_partial') byCarrier[d.insuranceCompany].paid++
  }
  const settlementRateByCarrier: Record<string, number> = {}
  for (const [carrier, counts] of Object.entries(byCarrier)) {
    settlementRateByCarrier[carrier] = counts.total > 0 ? Math.round((counts.paid / counts.total) * 100) : 0
  }

  // Outcome distribution
  const outcomeCounts: Record<string, number> = {}
  for (const d of dataPoints) {
    outcomeCounts[d.outcome] = (outcomeCounts[d.outcome] ?? 0) + 1
  }

  // Insights
  const insights: ClaimInsight[] = []

  // Insight 1: Best-paying carrier
  const sortedCarriers = Object.entries(settlementRateByCarrier).sort((a, b) => b[1] - a[1])
  if (sortedCarriers.length > 1) {
    insights.push({
      category: 'Carrier Performance',
      insight: `${sortedCarriers[0][0]} has the highest settlement rate at ${sortedCarriers[0][1]}%. ${sortedCarriers.at(-1)![0]} has the lowest at ${sortedCarriers.at(-1)![1]}%.`,
      confidence: closedClaims.length >= 10 ? 'high' : 'medium',
      actionableRecommendation: `For ${sortedCarriers.at(-1)![0]} claims, consider pursuing appraisal earlier in the process.`,
    })
  }

  // Insight 2: Average days to settle
  if (avgDaysToSettle > 0) {
    const benchmark = 180
    insights.push({
      category: 'Settlement Speed',
      insight: `Average days to settle: ${Math.round(avgDaysToSettle)} days. Industry benchmark is ~${benchmark} days.`,
      confidence: 'medium',
      actionableRecommendation: avgDaysToSettle > benchmark
        ? 'Consider being more aggressive in early negotiations to reduce settlement time.'
        : 'Settlement speed is within normal range. Continue current approach.',
    })
  }

  // Insight 3: Claim type distribution
  const typeGroups: Record<string, number> = {}
  for (const c of claims) typeGroups[c.claimType] = (typeGroups[c.claimType] ?? 0) + 1
  const topType = Object.entries(typeGroups).sort((a, b) => b[1] - a[1])[0]
  if (topType) {
    insights.push({
      category: 'Claim Types',
      insight: `${topType[0]} claims are the most common at ${topType[1]} of ${totalClaims} total (${Math.round((topType[1]/totalClaims)*100)}%).`,
      confidence: 'high',
      supportingData: JSON.stringify(typeGroups),
    })
  }

  // Insight 4: Recovery ratio
  const recoveryRatios = closedClaims.filter(d => d.estimatedValue > 0).map(d => d.settledAmount / d.estimatedValue)
  if (recoveryRatios.length > 0) {
    const avgRecovery = recoveryRatios.reduce((a, b) => a + b, 0) / recoveryRatios.length
    insights.push({
      category: 'Recovery Ratio',
      insight: `Average recovery is ${Math.round(avgRecovery * 100)}% of estimated value.`,
      confidence: recoveryRatios.length >= 5 ? 'high' : 'low',
      actionableRecommendation: avgRecovery < 0.7
        ? 'Recovery ratio below 70% — review estimating methodology and negotiation approach.'
        : 'Recovery ratio is strong. Maintain current estimating standards.',
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    totalClaims,
    averageSettlement: Math.round(avgSettlement),
    averageDaysToSettle: Math.round(avgDaysToSettle),
    settlementRateByCarrier,
    outcomeDistribution: outcomeCounts,
    topInsights: insights,
    resolutionRecommendations: insights.map(i => i.actionableRecommendation).filter(Boolean) as string[],
  }
}

export async function findSimilarClaims(targetClaim: Claim, allClaims: Claim[], limit = 5): Promise<Claim[]> {
  const scored = allClaims
    .filter(c => c.id !== targetClaim.id)
    .map(c => {
      let score = 0
      if (c.claimType        === targetClaim.claimType)        score += 3
      if (c.insuranceCompany === targetClaim.insuranceCompany) score += 3
      if (c.state            === targetClaim.state)            score += 2
      if (c.city             === targetClaim.city)             score += 1
      return { claim: c, score }
    })
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map(s => s.claim)
}

export function generateResolutionSuggestion(claim: Claim, similarClaims: Claim[]): string {
  const paidSimilar  = similarClaims.filter(c => c.status === 'closed_paid')
  const deniedSimilar = similarClaims.filter(c => c.status === 'closed_denied')

  const lines: string[] = [`Resolution recommendation for Claim #${claim.claimNumber}:`]

  if (paidSimilar.length > deniedSimilar.length) {
    const avgSettlement = paidSimilar.reduce((s, c) => s + (c.settledAmount ?? 0), 0) / paidSimilar.length
    lines.push(`• ${paidSimilar.length} of ${similarClaims.length} similar claims settled successfully. Average settlement: $${avgSettlement.toLocaleString()}.`)
    lines.push('• Approach: Standard negotiation. Use settled comparable claims as leverage.')
  } else if (deniedSimilar.length > 0) {
    lines.push(`• Caution: ${deniedSimilar.length} similar claims were denied. This carrier may be adversarial for this loss type.`)
    lines.push('• Approach: Build strong documentation. Consider demanding appraisal if initial offer is inadequate.')
  } else {
    lines.push('• Not enough historical data. Follow standard claims handling protocol.')
  }

  if (claim.claimType === 'hail' || claim.claimType === 'wind') {
    lines.push('• Ensure NOAA / HailTrace storm verification is in the file before submitting to carrier.')
  }

  return lines.join('\n')
}

// ── Tool schemas for Claude ───────────────────────────────────────────────────

export const analyticsToolSchemas = [
  {
    name: 'analytics_report',
    description: 'Generate a comprehensive analytics report from all historical claims data. Includes settlement rates by carrier, average days to settle, outcome distribution, and key insights.',
    input_schema: {
      type: 'object' as const,
      properties: {
        claimsJson: { type: 'string', description: 'JSON array of Claim objects (pass all claims from ClaimWizard)' },
      },
      required: ['claimsJson'],
    },
  },
  {
    name: 'analytics_find_similar',
    description: 'Find historical claims similar to a given claim (same carrier, claim type, state, etc.).',
    input_schema: {
      type: 'object' as const,
      properties: {
        targetClaimJson: { type: 'string', description: 'JSON of the target Claim object' },
        allClaimsJson:   { type: 'string', description: 'JSON array of all historical claims' },
        limit:           { type: 'number', description: 'Max similar claims to return (default 5)' },
      },
      required: ['targetClaimJson', 'allClaimsJson'],
    },
  },
  {
    name: 'analytics_resolution_suggestion',
    description: 'Generate a resolution strategy recommendation based on historical similar claims.',
    input_schema: {
      type: 'object' as const,
      properties: {
        claimJson:        { type: 'string', description: 'JSON of the target claim' },
        similarClaimsJson: { type: 'string', description: 'JSON array of similar claims (from analytics_find_similar)' },
      },
      required: ['claimJson', 'similarClaimsJson'],
    },
  },
]

export async function dispatchAnalyticsTool(toolName: string, input: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case 'analytics_report': {
      const claims = JSON.parse(input['claimsJson'] as string) as Claim[]
      return generateAnalyticsReport(claims)
    }
    case 'analytics_find_similar': {
      const target  = JSON.parse(input['targetClaimJson'] as string) as Claim
      const all     = JSON.parse(input['allClaimsJson']   as string) as Claim[]
      return findSimilarClaims(target, all, input['limit'] as number | undefined)
    }
    case 'analytics_resolution_suggestion': {
      const claim   = JSON.parse(input['claimJson']         as string) as Claim
      const similar = JSON.parse(input['similarClaimsJson'] as string) as Claim[]
      return generateResolutionSuggestion(claim, similar)
    }
    default:
      throw new Error(`Unknown analytics tool: ${toolName}`)
  }
}
