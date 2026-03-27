// ─────────────────────────────────────────────────────────────────────────────
// Public Adjuster AI Agent System — Entry Point
//
// Usage:
//   import { runOrchestrator, runMorningRoutine } from '~/agents'
//
// Quick starts:
//   Morning routine:       await runMorningRoutine()
//   New claim research:    await researchNewClaim({ ... })
//   Policy review:         await getPolicySummary(policyText)
//   Storm verification:    await runWeatherAgent('Search storms at 123 Main St...')
//   Analytics report:      await generateMonthlyReport()
// ─────────────────────────────────────────────────────────────────────────────

// Orchestrator (recommended entry point for most tasks)
export { runOrchestrator, runMorningRoutine, researchNewClaim } from './orchestrator.js'

// Individual agents (use directly for focused tasks)
export { runClaimWizardAgent, runDailyClaimsReview }          from './claimWizardAgent.js'
export { runPolicyReviewAgent, getPolicySummary }              from './policyReviewAgent.js'
export { runCalendarAgent }                                    from './calendarAgent.js'
export { runEmailAgent, triageUnreadEmails }                   from './emailAgent.js'
export { runAnalyticsAgent, getClaimResolutionAdvice, generateMonthlyReport } from './analyticsAgent.js'
export { runWeatherAgent }                                     from './weatherAgent.js'

// Types
export type {
  AgentResult,
  AgentRole,
  OrchestratorRequest,
  OrchestratorResponse,
  Claim,
  PolicyAnalysis,
  WeatherSearchResult,
  StormEvent,
  Appointment,
  EmailMessage,
  AnalyticsReport,
  DailyTaskSummary,
} from './types.js'
