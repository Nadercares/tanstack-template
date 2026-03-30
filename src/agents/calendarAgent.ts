// ─────────────────────────────────────────────────────────────────────────────
// Google Calendar Agent
//
// Manages scheduling for inspections, meetings, appraisals, and mediations.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import type { AgentResult } from './types.js'
import { calendarToolSchemas, dispatchCalendarTool } from './tools/googleTools.js'

const client = new Anthropic({ apiKey: process.env['VITE_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] })

const SYSTEM_PROMPT = `You are a scheduling assistant for a public adjusting firm.
You manage the Google Calendar for inspections, meetings, appraisals, mediations, and other claim-related appointments.

SCHEDULING RULES:
1. Inspections: Schedule Monday–Saturday, 8 AM – 5 PM.  Allow 2–3 hours per inspection.
2. Appraisals: Full-day blocks; notify all parties 7 days in advance.
3. Carrier meetings: 30–60 minutes; include dial-in or video link in description.
4. Always check availability before booking.
5. Send reminders 24 hours and 1 hour before appointments.
6. Include claim number in ALL event titles for easy search.

EVENT TITLE FORMAT: [TYPE] - Claim #[NUMBER] - [Insured Name or Property]
Examples:
  "INSPECTION - Claim #CL-2024-047 - Johnson Residence"
  "APPRAISAL - Claim #CL-2024-012 - 123 Main St"
  "CALL - Claim #CL-2024-033 - Citizens Insurance"

DESCRIPTION FORMAT:
  Claim #: [number]
  Insured: [name]
  Property: [address]
  Adjuster: [PA name]
  Carrier Contact: [name and phone]
  Notes: [any relevant info]

When scheduling:
1. First check availability for the requested time
2. If not available, suggest 2–3 alternative times
3. Create the event with full details
4. Confirm the booking with event ID and link`

export async function runCalendarAgent(task: string): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }]

  try {
    let iterations = 0
    const maxIterations = 8

    while (iterations < maxIterations) {
      iterations++

      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: calendarToolSchemas as Anthropic.Tool[],
        messages,
      })

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
        return {
          success: true,
          data: textBlock?.text ?? 'Calendar task complete.',
          agentRole: 'calendar',
        }
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content })

        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          try {
            const result = await dispatchCalendarTool(block.name, block.input as Record<string, unknown>)
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

    return { success: false, error: 'Max iterations reached.', agentRole: 'calendar' }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), agentRole: 'calendar' }
  }
}
