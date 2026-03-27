// ─────────────────────────────────────────────────────────────────────────────
// Policy Review Agent
//
// Analyzes property insurance policy documents and produces a structured
// summary covering: coverages, exclusions, limits, endorsements, appraisal
// language, and a recommended claim strategy.
//
// The policy text is passed directly into the prompt — no external tools
// are needed.  For PDF extraction, parse the PDF before calling this agent.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import type { AgentResult, PolicyAnalysis } from './types.js'

const client = new Anthropic({ apiKey: process.env['VITE_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] })

const SYSTEM_PROMPT = `You are an expert insurance policy analyst specializing in property insurance for public adjusters.
You have deep knowledge of:
- ISO policy forms (HO-3, HO-5, DP-1, DP-3, CP, etc.)
- Commercial property policies (BOP, commercial package, builder's risk)
- Florida, Texas, Louisiana, and other catastrophe-prone state endorsements
- Anti-concurrent causation clauses and their impact
- Appraisal and alternative dispute resolution provisions
- Replacement Cost Value (RCV) vs Actual Cash Value (ACV)
- Ordinance and law coverage
- Business income and extra expense coverage
- Common carrier defenses and how to counter them

ANALYSIS FRAMEWORK:
1. COVERAGES — What is covered, what form, RCV or ACV, special limits
2. EXCLUSIONS — List all relevant exclusions, flag anti-concurrent causation
3. LIMITS — Per-occurrence, aggregate, sublimits, deductibles
4. ENDORSEMENTS — Number, name, effect on coverage (broadening or restricting)
5. APPRAISAL LANGUAGE — Exact language, demand requirements, umpire selection, binding nature
6. CLAIM STRATEGY — How to position the claim, what arguments to make, what to avoid

IMPORTANT:
- Quote relevant policy language verbatim when analyzing critical provisions
- Flag any "gotcha" clauses that could limit recovery
- Note favorable provisions that support the insured's claim
- For appraisal language, extract EXACT demand requirements (written notice? specific timeframe?)
- Provide estimated recovery range if sufficient data is available
- Flag if the policy has any unusual or non-standard language

OUTPUT: Return your analysis as structured JSON matching the PolicyAnalysis type.`

const EXTRACT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'output_policy_analysis',
    description: 'Output the complete structured policy analysis.',
    input_schema: {
      type: 'object',
      properties: {
        insuranceCompany: { type: 'string' },
        policyNumber:     { type: 'string' },
        policyPeriod: {
          type: 'object',
          properties: { start: { type: 'string' }, end: { type: 'string' } },
          required: ['start', 'end'],
        },
        insuredName:     { type: 'string' },
        propertyAddress: { type: 'string' },
        coverages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type:        { type: 'string' },
              description: { type: 'string' },
              coverageAmount: { type: 'number' },
              sublimit:    { type: 'number' },
              deductible:  { type: 'number' },
              notes:       { type: 'string' },
            },
            required: ['type', 'description'],
          },
        },
        limits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type:          { type: 'string' },
              amount:        { type: 'number' },
              perOccurrence: { type: 'number' },
              aggregate:     { type: 'number' },
              notes:         { type: 'string' },
            },
            required: ['type', 'amount'],
          },
        },
        exclusions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name:          { type: 'string' },
              description:   { type: 'string' },
              exceptions:    { type: 'array', items: { type: 'string' } },
              applicability: { type: 'string' },
            },
            required: ['name', 'description'],
          },
        },
        endorsements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              formNumber:          { type: 'string' },
              name:                { type: 'string' },
              description:         { type: 'string' },
              impactOnCoverage:    { type: 'string', enum: ['broadens', 'restricts', 'neutral'] },
              relevanceToLoss:     { type: 'string' },
            },
            required: ['formNumber', 'name', 'description', 'impactOnCoverage'],
          },
        },
        appraisalClause: {
          type: 'object',
          properties: {
            hasAppraisalClause:  { type: 'boolean' },
            languageVerbatim:    { type: 'string' },
            demandRequirements:  { type: 'string' },
            appraiserRequirements: { type: 'string' },
            umpireSelection:     { type: 'string' },
            bindingNature:       { type: 'string' },
            notes:               { type: 'string' },
          },
          required: ['hasAppraisalClause'],
        },
        claimStrategy:            { type: 'string' },
        keyStrengths:             { type: 'array', items: { type: 'string' } },
        keyWeaknesses:            { type: 'array', items: { type: 'string' } },
        recommendedApproach:      { type: 'string' },
        estimatedRecoveryRange: {
          type: 'object',
          properties: { low: { type: 'number' }, high: { type: 'number' } },
        },
      },
      required: ['insuranceCompany', 'policyNumber', 'coverages', 'exclusions', 'limits', 'endorsements', 'appraisalClause', 'claimStrategy', 'keyStrengths', 'keyWeaknesses', 'recommendedApproach'],
    },
  },
]

export async function runPolicyReviewAgent(policyText: string, claimContext?: string): Promise<AgentResult<PolicyAnalysis>> {
  const userMessage = [
    'Please analyze the following property insurance policy and provide a complete structured analysis.',
    claimContext ? `\nCLAIM CONTEXT:\n${claimContext}` : '',
    '\n\nPOLICY DOCUMENT:\n',
    policyText,
    '\n\nReturn your analysis using the output_policy_analysis tool.',
  ].join('')

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }]

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      tools: EXTRACT_TOOLS,
      tool_choice: { type: 'tool', name: 'output_policy_analysis' },
      messages,
    })

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (!toolUse) {
      return { success: false, error: 'Policy review agent did not produce structured output.', agentRole: 'policy' }
    }

    const analysis = toolUse.input as PolicyAnalysis
    return { success: true, data: analysis, agentRole: 'policy' }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), agentRole: 'policy' }
  }
}

// Convenience wrapper when only a summary (not full JSON) is needed
export async function getPolicySummary(policyText: string, claimContext?: string): Promise<string> {
  const result = await runPolicyReviewAgent(policyText, claimContext)
  if (!result.success || !result.data) return result.error ?? 'Policy review failed.'

  const a = result.data
  return [
    `📋 POLICY ANALYSIS — ${a.insuranceCompany} | Policy #${a.policyNumber}`,
    `Insured: ${a.insuredName} | Property: ${a.propertyAddress}`,
    `Period: ${a.policyPeriod?.start} – ${a.policyPeriod?.end}`,
    '',
    '🔒 KEY COVERAGES:',
    ...a.coverages.map(c => `  • ${c.type}: ${c.description}${c.coverageAmount ? ` ($${c.coverageAmount.toLocaleString()})` : ''}`),
    '',
    '⛔ RELEVANT EXCLUSIONS:',
    ...a.exclusions.map(e => `  • ${e.name}: ${e.description}`),
    '',
    '📎 ENDORSEMENTS:',
    ...a.endorsements.map(e => `  • [${e.formNumber}] ${e.name} — ${e.impactOnCoverage.toUpperCase()}`),
    '',
    '⚖️ APPRAISAL CLAUSE:',
    a.appraisalClause.hasAppraisalClause
      ? `  ${a.appraisalClause.languageVerbatim ?? 'Yes — see full analysis for details'}`
      : '  No appraisal clause found.',
    '',
    '✅ STRENGTHS:',
    ...a.keyStrengths.map(s => `  + ${s}`),
    '',
    '⚠️ WEAKNESSES:',
    ...a.keyWeaknesses.map(w => `  - ${w}`),
    '',
    '🎯 RECOMMENDED APPROACH:',
    `  ${a.recommendedApproach}`,
    '',
    '📊 CLAIM STRATEGY:',
    `  ${a.claimStrategy}`,
  ].join('\n')
}
