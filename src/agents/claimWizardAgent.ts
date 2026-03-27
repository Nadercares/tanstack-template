// ─────────────────────────────────────────────────────────────────────────────
// ClaimWizard Agent
//
// Manages all interactions with the ClaimWizard CRM.  Handles daily task
// reviews, claim updates, PA assignments, and file notes.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import type { AgentResult } from './types.js'
import { claimWizardToolSchemas, dispatchClaimWizardTool } from './tools/claimWizardTools.js'

const client = new Anthropic({ apiKey: process.env['VITE_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] })

const SYSTEM_PROMPT = `You are a claims management assistant for a public adjusting firm.
You have direct access to the ClaimWizard CRM system and can view, update, and manage insurance claims.

YOUR RESPONSIBILITIES:
1. Daily task reviews — identify claims needing immediate attention
2. Update next steps and due dates to keep files moving
3. Assign claims to the appropriate public adjuster based on workload and expertise
4. Add detailed notes to claim files documenting all communications and actions
5. Track claim statuses and flag any that are stalled or overdue
6. Generate daily/weekly summaries for management

CLAIM PRIORITIES:
- URGENT: Appraisal or litigation deadlines within 7 days
- HIGH: Overdue next steps or inspection not scheduled within 5 business days of assignment
- MEDIUM: Claims in negotiation without updates in 14+ days
- LOW: New claims not yet assigned or acknowledged

WHEN UPDATING CLAIMS:
- Always add a note explaining WHY a status or next-step was changed
- Use specific dates (never "soon" or "next week")
- Include carrier contact name/number in notes when relevant
- Flag any red flags: denial letters, reservation of rights, statute of limitations concerns

WHEN ASSIGNING ADJUSTERS:
- Check current active claim counts before assigning
- Consider geographic proximity and claim type expertise
- Note the assignment in the claim file with the adjuster's contact info

Always be concise and action-oriented. Focus on moving claims forward.`

export async function runClaimWizardAgent(task: string): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }]

  try {
    let iterations = 0
    const maxIterations = 12

    while (iterations < maxIterations) {
      iterations++

      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 8096,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        tools: claimWizardToolSchemas as Anthropic.Tool[],
        messages,
      })

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
        return {
          success: true,
          data: textBlock?.text ?? 'ClaimWizard task complete.',
          agentRole: 'claimwizard',
        }
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content })

        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          try {
            const result = await dispatchClaimWizardTool(block.name, block.input as Record<string, unknown>)
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

    return { success: false, error: 'Max iterations reached without completing ClaimWizard task.', agentRole: 'claimwizard' }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), agentRole: 'claimwizard' }
  }
}

// Pre-built daily task: review all overdue and high-priority claims
export async function runDailyClaimsReview(adjusterId?: string): Promise<AgentResult> {
  const task = adjusterId
    ? `Run the daily claims review for adjuster ID ${adjusterId}. Check for: (1) overdue next steps, (2) claims not updated in 14+ days, (3) claims in appraisal or litigation needing immediate attention. Provide a prioritized action list.`
    : `Run the complete daily claims review for ALL adjusters. Get the daily task summary, identify the most urgent claims, list overdue next steps, and provide a prioritized action plan for the day.`

  return runClaimWizardAgent(task)
}
