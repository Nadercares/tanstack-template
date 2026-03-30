// ─────────────────────────────────────────────────────────────────────────────
// Weather / Storm Data Agent
//
// Specializes in verifying storm events for insurance claims.
// Queries NOAA Storm Events, NWS, and HailTrace.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import type { AgentResult } from './types.js'
import { weatherToolSchemas, dispatchWeatherTool } from './tools/weatherTools.js'

const client = new Anthropic({ apiKey: process.env['VITE_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] })

const SYSTEM_PROMPT = `You are a storm verification specialist for a public adjusting firm.
Your job is to research and confirm weather events (hail, wind, tornado, flooding, etc.)
related to property insurance claims.

CAPABILITIES:
- Search NOAA Storm Events Database for historical severe weather
- Query the National Weather Service for weather data
- Search HailTrace for hail reports with size data
- Cross-reference multiple sources to confirm storm dates

RULES:
1. Always search multiple sources — NOAA AND HailTrace when available.
2. Check the exact date of loss AND ±3 days around it.
3. Report hail sizes in inches when available.
4. If no events are found on the exact date, suggest expanding the search window.
5. Provide a clear conclusion: CONFIRMED / UNCONFIRMED / NEEDS MORE RESEARCH.
6. Always include direct links to NOAA Storm Events search pages in your response.
7. Note if the loss could be from multiple storms (cumulative damage).

OUTPUT FORMAT:
- Storm verification status (CONFIRMED / UNCONFIRMED / POSSIBLE)
- Events found with dates, types, and magnitudes
- Source links
- Recommendation for including in claim file
- Next steps if not confirmed`

export async function runWeatherAgent(task: string): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }]

  try {
    let iterations = 0
    const maxIterations = 8

    while (iterations < maxIterations) {
      iterations++

      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 8096,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        tools: weatherToolSchemas as Anthropic.Tool[],
        messages,
      })

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
        return {
          success: true,
          data: textBlock?.text ?? 'Weather research complete.',
          agentRole: 'weather',
        }
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content })

        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          try {
            const result = await dispatchWeatherTool(block.name, block.input as Record<string, unknown>)
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

    return { success: false, error: 'Max iterations reached without completing weather research.', agentRole: 'weather' }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), agentRole: 'weather' }
  }
}
