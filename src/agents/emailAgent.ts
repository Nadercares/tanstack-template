// ─────────────────────────────────────────────────────────────────────────────
// Gmail Agent
//
// Reads incoming emails, drafts professional responses, and manages claim
// communications.  IMPORTANT: By default, emails are DRAFTED (not sent).
// The user must review and send manually unless explicitly instructed otherwise.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import type { AgentResult } from './types.js'
import { emailToolSchemas, dispatchEmailTool } from './tools/googleTools.js'

const client = new Anthropic({ apiKey: process.env['VITE_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] })

const SYSTEM_PROMPT = `You are an email communications assistant for a public adjusting firm.
You help manage claim-related email correspondence professionally and effectively.

YOUR CAPABILITIES:
- Read and summarize incoming emails
- Draft professional responses
- Flag urgent communications (denials, ROR letters, appraisal demands)
- Help compose demand letters and follow-up correspondence

COMMUNICATION GUIDELINES:
1. Always be professional, factual, and non-confrontational in tone
2. Do NOT admit fault or make concessions on behalf of the firm
3. Do NOT agree to policy interpretations — always say "we will review"
4. Do NOT provide legal advice — refer legal questions to the attorney
5. ALWAYS save as draft first unless explicitly told to send immediately
6. Reference claim numbers in every email subject line

EMAIL TYPES AND TONE:
- Carrier correspondence: Professional, firm, document-everything tone
- Insured correspondence: Warm, reassuring, clear explanations
- Expert correspondence (engineers, contractors): Technical, concise
- Attorney correspondence: Formal, precise, with specific dates and facts

PRIORITY FLAGS — always highlight these immediately:
🚨 DENIAL LETTERS — respond within 30 days, flag for attorney review
🚨 RESERVATION OF RIGHTS (ROR) — flag immediately, requires attorney review
🚨 APPRAISAL DEMANDS from carrier — strict response timeline
🚨 SUIT LIMITATION NOTICES — statute of limitations concerns
⚠️ INSPECTION SCHEDULING REQUESTS — coordinate with calendar agent
⚠️ DOCUMENT REQUESTS — compile and respond within carrier's deadline

RESPONSE FORMAT:
- Lead with the email summary and any priority flags
- Then provide draft response(s) as needed
- Note whether draft was saved or sent`

export async function runEmailAgent(task: string): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }]

  try {
    let iterations = 0
    const maxIterations = 10

    while (iterations < maxIterations) {
      iterations++

      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 8096,
        system: SYSTEM_PROMPT,
        tools: emailToolSchemas as Anthropic.Tool[],
        messages,
      })

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
        return {
          success: true,
          data: textBlock?.text ?? 'Email task complete.',
          agentRole: 'email',
        }
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content })

        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          try {
            const result = await dispatchEmailTool(block.name, block.input as Record<string, unknown>)
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

    return { success: false, error: 'Max iterations reached.', agentRole: 'email' }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), agentRole: 'email' }
  }
}

// Convenience: read and triage all unread emails
export async function triageUnreadEmails(): Promise<AgentResult> {
  return runEmailAgent(
    'Read all unread emails in my inbox. Summarize each one, flag any urgent items (denials, ROR letters, appraisal demands, suit limitation notices), and draft responses for any that need a reply. Save all replies as drafts — do NOT send.',
  )
}
