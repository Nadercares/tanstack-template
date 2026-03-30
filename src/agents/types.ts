// ─────────────────────────────────────────────────────────────────────────────
// Shared types for the Public Adjuster AI Agent System
// ─────────────────────────────────────────────────────────────────────────────

import type Anthropic from '@anthropic-ai/sdk'

// ── Core agent primitives ─────────────────────────────────────────────────────

export type AgentRole = 'orchestrator' | 'claimwizard' | 'policy' | 'calendar' | 'email' | 'analytics' | 'weather'

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AgentResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
  agentRole: AgentRole
}

export interface RunAgentOptions {
  messages: Anthropic.MessageParam[]
  maxIterations?: number
}

// ── ClaimWizard / Claims ──────────────────────────────────────────────────────

export type ClaimStatus =
  | 'new'
  | 'inspection_scheduled'
  | 'inspection_complete'
  | 'estimate_in_progress'
  | 'estimate_submitted'
  | 'negotiation'
  | 'appraisal'
  | 'litigation'
  | 'closed_paid'
  | 'closed_denied'
  | 'on_hold'

export interface Claim {
  id: string
  claimNumber: string
  insuredName: string
  propertyAddress: string
  city: string
  state: string
  zip: string
  dateOfLoss: string
  reportedDate: string
  insuranceCompany: string
  policyNumber: string
  claimType: 'wind' | 'hail' | 'water' | 'fire' | 'mold' | 'other'
  status: ClaimStatus
  assignedAdjusterId?: string
  assignedAdjusterName?: string
  estimatedValue?: number
  settledAmount?: number
  nextSteps?: string
  nextStepDueDate?: string
  notes?: string
  lastUpdated: string
  createdAt: string
}

export interface ClaimNote {
  id: string
  claimId: string
  authorName: string
  content: string
  createdAt: string
  noteType: 'general' | 'action_item' | 'communication' | 'document' | 'negotiation'
}

export interface PublicAdjuster {
  id: string
  name: string
  email: string
  phone: string
  licenseNumber: string
  states: string[]
  activeClaimsCount: number
}

export interface DailyTaskSummary {
  adjusterId: string
  adjusterName: string
  date: string
  claimsRequiringAttention: Claim[]
  overdueNextSteps: Claim[]
  upcomingInspections: Claim[]
  recentlyUpdated: Claim[]
}

// ── Insurance Policy ──────────────────────────────────────────────────────────

export interface PolicyCoverage {
  type: string
  description: string
  coverageAmount?: number
  sublimit?: number
  deductible?: number
  coinsurance?: number
  notes?: string
}

export interface PolicyLimit {
  type: string
  amount: number
  perOccurrence?: number
  aggregate?: number
  notes?: string
}

export interface PolicyExclusion {
  name: string
  description: string
  exceptions?: string[]
  applicability?: string
}

export interface Endorsement {
  formNumber: string
  name: string
  description: string
  impactOnCoverage: 'broadens' | 'restricts' | 'neutral'
  relevanceToLoss?: string
}

export interface AppraisalClause {
  hasAppraisalClause: boolean
  languageVerbatim?: string
  demandRequirements?: string
  appraiserRequirements?: string
  umpireSelection?: string
  bindingNature?: string
  notes?: string
}

export interface PolicyAnalysis {
  insuranceCompany: string
  policyNumber: string
  policyPeriod: { start: string; end: string }
  insuredName: string
  propertyAddress: string
  coverages: PolicyCoverage[]
  limits: PolicyLimit[]
  exclusions: PolicyExclusion[]
  endorsements: Endorsement[]
  appraisalClause: AppraisalClause
  claimStrategy: string
  keyStrengths: string[]
  keyWeaknesses: string[]
  recommendedApproach: string
  estimatedRecoveryRange?: { low: number; high: number }
}

// ── Weather / Storm Data ──────────────────────────────────────────────────────

export type StormType = 'hail' | 'wind' | 'tornado' | 'hurricane' | 'flood' | 'lightning' | 'winter_storm'

export interface StormEvent {
  eventId?: string
  date: string
  stormType: StormType
  location: string
  county?: string
  state: string
  latitude?: number
  longitude?: number
  magnitude?: string
  hailSize?: number
  windSpeed?: number
  description?: string
  source: 'noaa' | 'hailtrace' | 'nws' | 'other'
  reportUrl?: string
}

export interface WeatherSearchParams {
  address: string
  city: string
  state: string
  zip?: string
  dateOfLoss: string
  radiusMiles?: number
  stormTypes?: StormType[]
}

export interface WeatherSearchResult {
  searchParams: WeatherSearchParams
  events: StormEvent[]
  summary: string
  lossDateConfirmed: boolean
  nearestEvent?: StormEvent
  recommendation: string
}

// ── Google Calendar ───────────────────────────────────────────────────────────

export interface Appointment {
  id?: string
  title: string
  description?: string
  startDateTime: string  // ISO 8601
  endDateTime: string    // ISO 8601
  location?: string
  attendees?: string[]   // email addresses
  claimId?: string
  claimNumber?: string
  appointmentType?: 'inspection' | 'meeting' | 'call' | 'appraisal' | 'mediation' | 'other'
  reminderMinutes?: number
}

export interface CalendarSlot {
  startDateTime: string
  endDateTime: string
  available: boolean
}

// ── Gmail / Email ─────────────────────────────────────────────────────────────

export interface EmailMessage {
  id?: string
  threadId?: string
  from: string
  to: string[]
  cc?: string[]
  subject: string
  body: string
  bodyHtml?: string
  date?: string
  attachments?: EmailAttachment[]
  labels?: string[]
  isRead?: boolean
  claimId?: string
}

export interface EmailAttachment {
  filename: string
  mimeType: string
  size: number
  attachmentId?: string
}

export interface EmailDraft {
  to: string[]
  cc?: string[]
  subject: string
  body: string
  replyToId?: string
  claimId?: string
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export interface ClaimDataPoint {
  claimId: string
  claimType: string
  insuranceCompany: string
  state: string
  dateOfLoss: string
  estimatedValue: number
  settledAmount: number
  daysToSettle: number
  outcome: 'paid_full' | 'paid_partial' | 'denied' | 'pending'
  resolutionMethod: 'negotiation' | 'appraisal' | 'litigation' | 'direct_payment' | 'pending'
  hadAppraisal: boolean
}

export interface ClaimInsight {
  category: string
  insight: string
  confidence: 'high' | 'medium' | 'low'
  supportingData?: string
  actionableRecommendation?: string
}

export interface AnalyticsReport {
  generatedAt: string
  totalClaims: number
  averageSettlement: number
  averageDaysToSettle: number
  settlementRateByCarrier: Record<string, number>
  outcomeDistribution: Record<string, number>
  topInsights: ClaimInsight[]
  resolutionRecommendations: string[]
  similarClaims?: Claim[]
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface OrchestratorRequest {
  task: string
  context?: Record<string, unknown>
  claimId?: string
  adjusterId?: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
}

export interface OrchestratorResponse {
  summary: string
  agentsInvoked: AgentRole[]
  results: AgentResult[]
  nextActions?: string[]
  requiresHumanReview?: boolean
}
