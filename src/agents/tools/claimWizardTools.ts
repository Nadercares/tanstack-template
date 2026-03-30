// ─────────────────────────────────────────────────────────────────────────────
// ClaimWizard API Tools
//
// ClaimWizard (www.claimwizard.com) is a web-based CRM for public adjusters.
// These tools communicate with their REST API using a session cookie obtained
// via username/password login.  Set the following env vars:
//   CLAIMWIZARD_BASE_URL  – e.g. https://app.claimwizard.com
//   CLAIMWIZARD_USERNAME
//   CLAIMWIZARD_PASSWORD
//   CLAIMWIZARD_API_KEY   – if the account has an API key (preferred over password)
// ─────────────────────────────────────────────────────────────────────────────

import type { Claim, ClaimNote, PublicAdjuster, DailyTaskSummary, ClaimStatus } from '../types.js'

const BASE_URL = process.env['CLAIMWIZARD_BASE_URL'] ?? 'https://app.claimwizard.com'
const API_KEY  = process.env['CLAIMWIZARD_API_KEY']
const USERNAME = process.env['CLAIMWIZARD_USERNAME']
const PASSWORD = process.env['CLAIMWIZARD_PASSWORD']

// ── Auth ──────────────────────────────────────────────────────────────────────

let sessionCookie: string | null = null

async function getAuthHeaders(): Promise<Record<string, string>> {
  if (API_KEY) {
    return { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }
  }
  if (!sessionCookie) {
    sessionCookie = await login()
  }
  return { 'Cookie': sessionCookie, 'Content-Type': 'application/json' }
}

async function login(): Promise<string> {
  if (!USERNAME || !PASSWORD) {
    throw new Error('CLAIMWIZARD_USERNAME and CLAIMWIZARD_PASSWORD env vars are required when no API key is set')
  }
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`ClaimWizard login failed: ${res.status} ${res.statusText}`)
  const cookie = res.headers.get('set-cookie')
  if (!cookie) throw new Error('ClaimWizard login returned no session cookie')
  return cookie
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = await getAuthHeaders()
  const res = await fetch(`${BASE_URL}/api${path}`, { ...options, headers: { ...headers, ...(options?.headers as Record<string, string> | undefined) } })
  if (res.status === 401) {
    // Invalidate session and retry once
    sessionCookie = null
    const retryHeaders = await getAuthHeaders()
    const retryRes = await fetch(`${BASE_URL}/api${path}`, { ...options, headers: { ...retryHeaders, ...(options?.headers as Record<string, string> | undefined) } })
    if (!retryRes.ok) throw new Error(`ClaimWizard API error: ${retryRes.status} ${retryRes.statusText}`)
    return retryRes.json() as Promise<T>
  }
  if (!res.ok) throw new Error(`ClaimWizard API error: ${res.status} ${res.statusText} — ${path}`)
  return res.json() as Promise<T>
}

// ── Tool implementations ──────────────────────────────────────────────────────

export async function listClaims(params: {
  status?: ClaimStatus
  adjusterId?: string
  search?: string
  page?: number
  pageSize?: number
}): Promise<{ claims: Claim[]; total: number }> {
  const query = new URLSearchParams()
  if (params.status)     query.set('status', params.status)
  if (params.adjusterId) query.set('adjuster_id', params.adjusterId)
  if (params.search)     query.set('q', params.search)
  if (params.page)       query.set('page', String(params.page))
  if (params.pageSize)   query.set('page_size', String(params.pageSize ?? 25))
  return apiRequest(`/claims?${query.toString()}`)
}

export async function getClaimDetails(claimId: string): Promise<Claim> {
  return apiRequest(`/claims/${claimId}`)
}

export async function getClaimByNumber(claimNumber: string): Promise<Claim> {
  const result = await listClaims({ search: claimNumber, pageSize: 1 })
  const claim = result.claims[0]
  if (!claim) throw new Error(`No claim found with number ${claimNumber}`)
  return claim
}

export async function updateClaimStatus(claimId: string, status: ClaimStatus, notes?: string): Promise<Claim> {
  return apiRequest(`/claims/${claimId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, notes }),
  })
}

export async function updateNextSteps(claimId: string, nextSteps: string, dueDate?: string): Promise<Claim> {
  return apiRequest(`/claims/${claimId}`, {
    method: 'PATCH',
    body: JSON.stringify({ next_steps: nextSteps, next_step_due_date: dueDate }),
  })
}

export async function assignAdjuster(claimId: string, adjusterId: string): Promise<Claim> {
  return apiRequest(`/claims/${claimId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ adjuster_id: adjusterId }),
  })
}

export async function addClaimNote(claimId: string, note: {
  content: string
  noteType?: ClaimNote['noteType']
  authorName?: string
}): Promise<ClaimNote> {
  return apiRequest(`/claims/${claimId}/notes`, {
    method: 'POST',
    body: JSON.stringify({
      content: note.content,
      note_type: note.noteType ?? 'general',
      author_name: note.authorName ?? 'AI Assistant',
    }),
  })
}

export async function getClaimNotes(claimId: string): Promise<ClaimNote[]> {
  return apiRequest(`/claims/${claimId}/notes`)
}

export async function listAdjusters(): Promise<PublicAdjuster[]> {
  return apiRequest('/adjusters')
}

export async function getDailyTaskSummary(adjusterId?: string): Promise<DailyTaskSummary[]> {
  const query = adjusterId ? `?adjuster_id=${adjusterId}` : ''
  return apiRequest(`/dashboard/daily-tasks${query}`)
}

export async function getOverdueNextSteps(): Promise<Claim[]> {
  return apiRequest('/claims/overdue-next-steps')
}

export async function createClaim(claimData: Omit<Claim, 'id' | 'createdAt' | 'lastUpdated'>): Promise<Claim> {
  return apiRequest('/claims', {
    method: 'POST',
    body: JSON.stringify(claimData),
  })
}

export async function uploadClaimDocument(claimId: string, fileBuffer: Buffer, filename: string, mimeType: string): Promise<{ documentId: string; url: string }> {
  const form = new FormData()
  form.append('file', new Blob([fileBuffer], { type: mimeType }), filename)
  form.append('claim_id', claimId)

  const headers = await getAuthHeaders()
  // Remove Content-Type so fetch sets multipart boundary automatically
  delete (headers as Record<string, string>)['Content-Type']

  const res = await fetch(`${BASE_URL}/api/claims/${claimId}/documents`, {
    method: 'POST',
    headers,
    body: form,
  })
  if (!res.ok) throw new Error(`Document upload failed: ${res.status}`)
  return res.json() as Promise<{ documentId: string; url: string }>
}

// ── Tool schemas for Claude ───────────────────────────────────────────────────

export const claimWizardToolSchemas = [
  {
    name: 'cw_list_claims',
    description: 'List claims from ClaimWizard. Optionally filter by status, adjuster, or search term.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter by claim status', enum: ['new','inspection_scheduled','inspection_complete','estimate_in_progress','estimate_submitted','negotiation','appraisal','litigation','closed_paid','closed_denied','on_hold'] },
        adjusterId: { type: 'string', description: 'Filter by assigned adjuster ID' },
        search: { type: 'string', description: 'Search by claim number, insured name, or address' },
        page: { type: 'number', description: 'Page number for pagination (default 1)' },
        pageSize: { type: 'number', description: 'Results per page (default 25)' },
      },
    },
  },
  {
    name: 'cw_get_claim',
    description: 'Get full details of a specific claim by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        claimId: { type: 'string', description: 'The claim ID' },
      },
      required: ['claimId'],
    },
  },
  {
    name: 'cw_get_claim_by_number',
    description: 'Get a claim by its human-readable claim number (e.g. CL-2024-001).',
    input_schema: {
      type: 'object' as const,
      properties: {
        claimNumber: { type: 'string', description: 'The claim number' },
      },
      required: ['claimNumber'],
    },
  },
  {
    name: 'cw_update_status',
    description: 'Update the status of a claim.',
    input_schema: {
      type: 'object' as const,
      properties: {
        claimId: { type: 'string', description: 'The claim ID' },
        status: { type: 'string', description: 'New status', enum: ['new','inspection_scheduled','inspection_complete','estimate_in_progress','estimate_submitted','negotiation','appraisal','litigation','closed_paid','closed_denied','on_hold'] },
        notes: { type: 'string', description: 'Optional notes about the status change' },
      },
      required: ['claimId', 'status'],
    },
  },
  {
    name: 'cw_update_next_steps',
    description: 'Update the next steps and due date for a claim.',
    input_schema: {
      type: 'object' as const,
      properties: {
        claimId: { type: 'string', description: 'The claim ID' },
        nextSteps: { type: 'string', description: 'Description of next steps to take' },
        dueDate: { type: 'string', description: 'Due date for next steps in YYYY-MM-DD format' },
      },
      required: ['claimId', 'nextSteps'],
    },
  },
  {
    name: 'cw_assign_adjuster',
    description: 'Assign or reassign a public adjuster to a claim.',
    input_schema: {
      type: 'object' as const,
      properties: {
        claimId: { type: 'string', description: 'The claim ID' },
        adjusterId: { type: 'string', description: 'The adjuster ID to assign' },
      },
      required: ['claimId', 'adjusterId'],
    },
  },
  {
    name: 'cw_add_note',
    description: 'Add a note to a claim.',
    input_schema: {
      type: 'object' as const,
      properties: {
        claimId: { type: 'string', description: 'The claim ID' },
        content: { type: 'string', description: 'Note content' },
        noteType: { type: 'string', enum: ['general','action_item','communication','document','negotiation'], description: 'Type of note' },
      },
      required: ['claimId', 'content'],
    },
  },
  {
    name: 'cw_get_notes',
    description: 'Get all notes for a claim.',
    input_schema: {
      type: 'object' as const,
      properties: {
        claimId: { type: 'string', description: 'The claim ID' },
      },
      required: ['claimId'],
    },
  },
  {
    name: 'cw_list_adjusters',
    description: 'List all public adjusters in the system.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'cw_daily_tasks',
    description: 'Get the daily task summary — claims needing attention, overdue next steps, upcoming inspections.',
    input_schema: {
      type: 'object' as const,
      properties: {
        adjusterId: { type: 'string', description: 'Filter by adjuster ID (omit for all adjusters)' },
      },
    },
  },
]

// ── Tool dispatcher ───────────────────────────────────────────────────────────

export async function dispatchClaimWizardTool(toolName: string, input: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case 'cw_list_claims':
      return listClaims(input as Parameters<typeof listClaims>[0])
    case 'cw_get_claim':
      return getClaimDetails(input['claimId'] as string)
    case 'cw_get_claim_by_number':
      return getClaimByNumber(input['claimNumber'] as string)
    case 'cw_update_status':
      return updateClaimStatus(input['claimId'] as string, input['status'] as ClaimStatus, input['notes'] as string | undefined)
    case 'cw_update_next_steps':
      return updateNextSteps(input['claimId'] as string, input['nextSteps'] as string, input['dueDate'] as string | undefined)
    case 'cw_assign_adjuster':
      return assignAdjuster(input['claimId'] as string, input['adjusterId'] as string)
    case 'cw_add_note':
      return addClaimNote(input['claimId'] as string, { content: input['content'] as string, noteType: input['noteType'] as ClaimNote['noteType'] | undefined })
    case 'cw_get_notes':
      return getClaimNotes(input['claimId'] as string)
    case 'cw_list_adjusters':
      return listAdjusters()
    case 'cw_daily_tasks':
      return getDailyTaskSummary(input['adjusterId'] as string | undefined)
    default:
      throw new Error(`Unknown ClaimWizard tool: ${toolName}`)
  }
}
