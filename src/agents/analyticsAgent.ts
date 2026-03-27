// ─────────────────────────────────────────────────────────────────────────────
// Analytics Agent
//
// Analyzes historical claims data, identifies patterns, and provides
// resolution recommendations for open claims.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import type { AgentResult } from './types.js'
import { analyticsToolSchemas, dispatchAnalyticsTool } from './tools/analyticsTools.js'
import { claimWizardToolSchemas, dispatchClaimWizardTool } from './tools/claimWizardTools.js'

const client = new Anthropic({ apiKey: process.env['VITE_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] })

// Analytics has access to both analytics tools AND read-only ClaimWizard tools
const analyticsReadOnlyTools = claimWizardToolSchemas.filter(t =>
  ['cw_list_claims', 'cw_get_claim', 'cw_get_claim_by_number', 'cw_list_adjusters'].includes(t.name),
)

const ALL_TOOLS = [
  ...analyticsToolSchemas,
  ...analyticsReadOnlyTools,
] as Anthropic.Tool[]

const SYSTEM_PROMPT = `You are a data analytics specialist for a public adjusting firm.
You analyze historical claims data to identify patterns, benchmark performance, and recommend
resolution strategies for current claims.

YOUR SPECIALTIES:
1. **Carrier Analysis** — Which insurers pay well? Which are adversarial? What tactics do they use?
2. **Claim Type Performance** — What's our recovery rate on wind vs hail vs water vs fire?
3. **Resolution Methods** — When does appraisal outperform negotiation? What triggers better outcomes?
4. **Adjuster Performance** — Who closes claims fastest? Who achieves the best recovery ratios?
5. **Geographic Trends** — Are certain counties or cities seeing higher denial rates?
6. **Time Analysis** — How long does each claim stage typically take? Where are bottlenecks?

ANALYSIS APPROACH:
1. First pull the relevant claims data from ClaimWizard
2. Run analytics tools to process the data
3. Find similar historical claims for any specific claim under review
4. Generate concrete, actionable recommendations

RECOMMENDATION RULES:
- Always base recommendations on actual data, not assumptions
- State confidence level (high/medium/low) based on sample size
- Minimum 5 similar claims for a "medium" confidence recommendation
- Minimum 20 similar claims for a "high" confidence recommendation
- Always suggest next steps — not just observations

DATA PRIVACY: Never include insured names or addresses in summaries. Use claim IDs only.`

export async function runAnalyticsAgent(task: string): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }]

  try {
    let iterations = 0
    const maxIterations = 12

    while (iterations < maxIterations) {
      iterations++

      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        tools: ALL_TOOLS,
        messages,
      })

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
        return {
          success: true,
          data: textBlock?.text ?? 'Analytics complete.',
          agentRole: 'analytics',
        }
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content })

        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          try {
            const isAnalyticsTool = analyticsToolSchemas.some(t => t.name === block.name)
            const result = isAnalyticsTool
              ? await dispatchAnalyticsTool(block.name, block.input as Record<string, unknown>)
              : await dispatchClaimWizardTool(block.name, block.input as Record<string, unknown>)

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result, null, 2),
            })
          } catch (err) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
              is_error: true,
            })
          }
        }

        messages.push({ role: 'user', content: toolResults })
        continue
      }

      break
    }

    return { success: false, error: 'Max iterations reached.', agentRole: 'analytics' }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), agentRole: 'analytics' }
  }
}

// Convenience: get resolution recommendations for a specific claim
export async function getClaimResolutionAdvice(claimId: string): Promise<AgentResult> {
  return runAnalyticsAgent(
    `Analyze claim ID ${claimId} and provide resolution recommendations. Steps:
    1. Fetch the claim details from ClaimWizard
    2. Fetch all historical claims of the same type and carrier
    3. Find the 5 most similar historical claims
    4. Generate a resolution recommendation based on historical outcomes
    5. Provide specific negotiation tactics that have worked for this carrier in the past`,
  )
}

// Convenience: monthly performance report
export async function generateMonthlyReport(): Promise<AgentResult> {
  const now = new Date()
  const monthName = now.toLocaleString('default', { month: 'long', year: 'numeric' })

  return runAnalyticsAgent(
    `Generate a comprehensive performance report for ${monthName}:
    1. Pull all claims from ClaimWizard
    2. Run the full analytics report
    3. Highlight top 3 insights
    4. Identify carriers with the lowest settlement rates (priority for appraisal)
    5. List the top 3 recommendations for improving outcomes next month`,
  )
}
