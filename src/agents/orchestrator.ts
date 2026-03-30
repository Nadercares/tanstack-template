// ─────────────────────────────────────────────────────────────────────────────
// Main Orchestrator Agent
//
// The central coordinator.  Receives a high-level task, decides which
// specialized agents to invoke, and synthesizes the results into a final
// response.  Sub-agents are called as "tools" — the orchestrator never
// handles domain logic directly.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import type { OrchestratorRequest, OrchestratorResponse, AgentRole, AgentResult } from './types.js'
import { runClaimWizardAgent, runDailyClaimsReview } from './claimWizardAgent.js'
import { runPolicyReviewAgent, getPolicySummary } from './policyReviewAgent.js'
import { runCalendarAgent } from './calendarAgent.js'
import { runEmailAgent, triageUnreadEmails } from './emailAgent.js'
import { runAnalyticsAgent, getClaimResolutionAdvice, generateMonthlyReport } from './analyticsAgent.js'
import { runWeatherAgent } from './weatherAgent.js'

const client = new Anthropic({ apiKey: process.env['VITE_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] })

// ── Sub-agent tool schemas (used by the orchestrator's Claude instance) ────────

const SUB_AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'invoke_claimwizard_agent',
    description: `Invoke the ClaimWizard CRM agent to manage claims. Use for:
- Listing or searching claims
- Updating claim statuses, next steps, or notes
- Assigning public adjusters to claims
- Daily task reviews and overdue claim checks
- Creating or modifying claim records`,
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Specific task for the ClaimWizard agent' },
        daily_review: { type: 'boolean', description: 'Set true to run the daily claims review workflow' },
        adjuster_id: { type: 'string', description: 'Filter daily review by adjuster ID' },
      },
      required: ['task'],
    },
  },
  {
    name: 'invoke_policy_review_agent',
    description: `Invoke the insurance policy review agent to analyze a policy document. Returns structured analysis of coverages, exclusions, limits, endorsements, appraisal language, and recommended claim strategy.`,
    input_schema: {
      type: 'object',
      properties: {
        policy_text:    { type: 'string', description: 'Full text of the insurance policy to analyze' },
        claim_context:  { type: 'string', description: 'Context about the claim (loss type, date, description)' },
        summary_only:   { type: 'boolean', description: 'Return a text summary instead of full JSON analysis' },
      },
      required: ['policy_text'],
    },
  },
  {
    name: 'invoke_calendar_agent',
    description: `Invoke the Google Calendar agent to manage appointments. Use for:
- Scheduling inspections, appraisals, mediations, and meetings
- Checking availability
- Updating or canceling existing appointments
- Listing upcoming appointments`,
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Specific scheduling task' },
      },
      required: ['task'],
    },
  },
  {
    name: 'invoke_email_agent',
    description: `Invoke the Gmail agent to handle email communications. Use for:
- Reading and triaging unread emails
- Drafting professional responses to carriers, insureds, or experts
- Flagging urgent emails (denials, ROR letters, appraisal demands)
- Searching for specific email threads
NOTE: Emails are saved as DRAFTS by default. Explicit confirmation is required to send.`,
    input_schema: {
      type: 'object',
      properties: {
        task:          { type: 'string', description: 'Specific email task' },
        triage_inbox:  { type: 'boolean', description: 'Set true to run full inbox triage' },
      },
      required: ['task'],
    },
  },
  {
    name: 'invoke_analytics_agent',
    description: `Invoke the analytics agent to analyze claims data and generate recommendations. Use for:
- Getting resolution recommendations for a specific claim
- Analyzing carrier performance and settlement patterns
- Identifying similar historical claims
- Generating monthly performance reports`,
    input_schema: {
      type: 'object',
      properties: {
        task:           { type: 'string', description: 'Specific analytics task' },
        claim_id:       { type: 'string', description: 'Claim ID if running per-claim analysis' },
        monthly_report: { type: 'boolean', description: 'Set true to generate monthly report' },
      },
      required: ['task'],
    },
  },
  {
    name: 'invoke_weather_agent',
    description: `Invoke the weather/storm verification agent to research storm events. Use for:
- Confirming storm events (hail, wind, tornado) on or around the date of loss
- Searching NOAA Storm Events Database
- Searching HailTrace for hail size data
- Providing storm documentation for the claim file`,
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Specific weather research task including address and date of loss' },
      },
      required: ['task'],
    },
  },
]

// ── Orchestrator system prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the chief operations AI for a public adjusting firm.
You coordinate a team of specialized AI agents to handle all aspects of claims management.

YOUR SPECIALIZED AGENTS:
1. 🗂️  ClaimWizard Agent    — CRM access (claims, notes, assignments, status updates)
2. 📋  Policy Review Agent  — Insurance policy analysis (coverages, exclusions, appraisal language)
3. 📅  Calendar Agent       — Google Calendar scheduling (inspections, meetings, appraisals)
4. 📧  Email Agent          — Gmail management (inbox triage, draft responses)
5. 📊  Analytics Agent      — Historical data analysis, carrier insights, resolution recommendations
6. 🌩️  Weather Agent        — Storm verification via NOAA and HailTrace

DECISION RULES:
- For daily operations ("what needs attention today"), invoke ClaimWizard + Email agents
- For a new claim, invoke ClaimWizard (create/update) + Weather (verify storm) + Analytics (strategy)
- For a policy question, invoke Policy Review Agent
- For scheduling, invoke Calendar Agent
- For resolution strategy, invoke Analytics Agent + (optionally) ClaimWizard for current claim details
- Multiple agents can be invoked sequentially when tasks are related

COORDINATION APPROACH:
1. Analyze the request and determine which agents are needed
2. Invoke agents in logical order (fetch data first, then act on it)
3. Pass relevant context between agents (e.g., claim details to weather agent)
4. Synthesize all results into a single clear response
5. Always end with concrete NEXT ACTIONS for the human

RESPONSE FORMAT:
- Start with a brief summary of what was done
- Report key findings from each agent
- End with ✅ NEXT ACTIONS — specific, dated, actionable items
- Flag anything requiring HUMAN REVIEW (legal matters, large settlements, unusual policy language)

SAFETY:
- Never send emails without confirmation (drafts only)
- Never delete calendar events without confirmation
- Flag any potential statute of limitations issues immediately
- Flag any denial letters or reservation of rights for attorney review`

// ── Orchestrator runner ───────────────────────────────────────────────────────

export async function runOrchestrator(request: OrchestratorRequest): Promise<OrchestratorResponse> {
  const agentsInvoked: AgentRole[] = []
  const results: AgentResult[] = []

  const userMessage = [
    request.task,
    request.claimId     ? `\nClaim ID: ${request.claimId}`         : '',
    request.adjusterId  ? `\nAdjuster ID: ${request.adjusterId}`   : '',
    request.priority    ? `\nPriority: ${request.priority.toUpperCase()}` : '',
    request.context     ? `\nAdditional context: ${JSON.stringify(request.context)}` : '',
  ].join('')

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }]

  let iterations = 0
  const maxIterations = 15

  while (iterations < maxIterations) {
    iterations++

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      tools: SUB_AGENT_TOOLS,
      messages,
    })

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
      const summary = textBlock?.text ?? 'Tasks completed.'

      // Extract next actions from the final response
      const nextActionsMatch = summary.match(/✅\s*NEXT ACTIONS[:\s]*([\s\S]*?)(?:\n\n|$)/i)
      const nextActions = nextActionsMatch
        ? nextActionsMatch[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('-') || l.startsWith('•') || /^\d+\./.test(l))
        : undefined

      return {
        summary,
        agentsInvoked: [...new Set(agentsInvoked)],
        results,
        nextActions,
        requiresHumanReview: summary.toLowerCase().includes('human review') || summary.toLowerCase().includes('attorney'),
      }
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        const input = block.input as Record<string, unknown>

        let agentResult: AgentResult

        try {
          switch (block.name) {
            case 'invoke_claimwizard_agent':
              agentsInvoked.push('claimwizard')
              agentResult = input['daily_review']
                ? await runDailyClaimsReview(input['adjuster_id'] as string | undefined)
                : await runClaimWizardAgent(input['task'] as string)
              break

            case 'invoke_policy_review_agent':
              agentsInvoked.push('policy')
              if (input['summary_only']) {
                const summary = await getPolicySummary(input['policy_text'] as string, input['claim_context'] as string | undefined)
                agentResult = { success: true, data: summary, agentRole: 'policy' }
              } else {
                agentResult = await runPolicyReviewAgent(input['policy_text'] as string, input['claim_context'] as string | undefined)
              }
              break

            case 'invoke_calendar_agent':
              agentsInvoked.push('calendar')
              agentResult = await runCalendarAgent(input['task'] as string)
              break

            case 'invoke_email_agent':
              agentsInvoked.push('email')
              agentResult = input['triage_inbox']
                ? await triageUnreadEmails()
                : await runEmailAgent(input['task'] as string)
              break

            case 'invoke_analytics_agent':
              agentsInvoked.push('analytics')
              if (input['monthly_report']) {
                agentResult = await generateMonthlyReport()
              } else if (input['claim_id']) {
                agentResult = await getClaimResolutionAdvice(input['claim_id'] as string)
              } else {
                agentResult = await runAnalyticsAgent(input['task'] as string)
              }
              break

            case 'invoke_weather_agent':
              agentsInvoked.push('weather')
              agentResult = await runWeatherAgent(input['task'] as string)
              break

            default:
              agentResult = { success: false, error: `Unknown agent: ${block.name}`, agentRole: 'orchestrator' }
          }
        } catch (err) {
          agentResult = {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            agentRole: 'orchestrator',
          }
        }

        results.push(agentResult)

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: agentResult.success
            ? JSON.stringify(agentResult.data, null, 2)
            : `Agent error: ${agentResult.error}`,
          is_error: !agentResult.success,
        })
      }

      messages.push({ role: 'user', content: toolResults })
      continue
    }

    break
  }

  return {
    summary: 'Orchestrator reached maximum iterations without completing.',
    agentsInvoked: [...new Set(agentsInvoked)],
    results,
    requiresHumanReview: true,
  }
}

// ── Convenience shortcuts ─────────────────────────────────────────────────────

/** Run the standard morning routine: inbox triage + daily claims review */
export async function runMorningRoutine(adjusterId?: string): Promise<OrchestratorResponse> {
  return runOrchestrator({
    task: `Run the morning routine for ${adjusterId ? `adjuster ${adjusterId}` : 'all adjusters'}:
    1. Triage the Gmail inbox — summarize all unread emails, flag urgent items, draft replies for items needing responses
    2. Run the daily ClaimWizard review — list overdue next steps, claims needing immediate attention
    3. Show today's calendar appointments
    4. Provide a prioritized action plan for the day`,
    adjusterId,
    priority: 'high',
  })
}

/** Research a new claim (storm verification + analytics) */
export async function researchNewClaim(params: {
  claimId: string
  address: string
  city: string
  state: string
  dateOfLoss: string
  claimType: string
  insuranceCompany: string
}): Promise<OrchestratorResponse> {
  return runOrchestrator({
    task: `Research new claim ${params.claimId} for ${params.insuranceCompany}:
    1. Search NOAA and HailTrace for storm events at ${params.address}, ${params.city}, ${params.state} on ${params.dateOfLoss}
    2. Find similar historical claims (same carrier: ${params.insuranceCompany}, type: ${params.claimType}, state: ${params.state})
    3. Generate resolution recommendations based on historical outcomes
    4. Update the claim in ClaimWizard with storm verification results and initial strategy notes`,
    claimId: params.claimId,
    priority: 'high',
  })
}
