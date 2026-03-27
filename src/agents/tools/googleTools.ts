// ─────────────────────────────────────────────────────────────────────────────
// Google Calendar + Gmail Tools
//
// Uses the Google APIs Node.js client library (googleapis).
// Authentication: OAuth2 with a pre-authorized refresh token (service accounts
// are not suitable here because Calendar/Gmail needs user delegation).
//
// Required env vars:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN   – Obtained once via OAuth2 consent flow
//   GOOGLE_CALENDAR_ID     – Calendar ID to read/write (default: 'primary')
//   GOOGLE_USER_EMAIL      – Gmail address to send/read from
// ─────────────────────────────────────────────────────────────────────────────

import type { Appointment, EmailMessage, EmailDraft } from '../types.js'

// We use dynamic import so the module compiles even if googleapis is not installed
async function getGoogleClients() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { google } = await import('googleapis') as any

  const auth = new google.auth.OAuth2(
    process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_CLIENT_SECRET'],
  )
  auth.setCredentials({ refresh_token: process.env['GOOGLE_REFRESH_TOKEN'] })

  const calendar = google.calendar({ version: 'v3', auth })
  const gmail    = google.gmail({ version: 'v1', auth })

  return { calendar, gmail, auth }
}

const CALENDAR_ID  = process.env['GOOGLE_CALENDAR_ID']  ?? 'primary'
const USER_EMAIL   = process.env['GOOGLE_USER_EMAIL']   ?? 'me'

// ── Calendar helpers ──────────────────────────────────────────────────────────

function encodeEmail(draft: EmailDraft): string {
  const headers = [
    `From: ${USER_EMAIL}`,
    `To: ${draft.to.join(', ')}`,
    ...(draft.cc?.length ? [`Cc: ${draft.cc.join(', ')}`] : []),
    `Subject: ${draft.subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    draft.body,
  ].join('\r\n')

  return Buffer.from(headers).toString('base64url')
}

// ── Calendar tools ────────────────────────────────────────────────────────────

export async function createAppointment(appointment: Appointment): Promise<Appointment> {
  const { calendar } = await getGoogleClients()

  const event = {
    summary: appointment.title,
    description: [
      appointment.description ?? '',
      appointment.claimNumber ? `Claim #: ${appointment.claimNumber}` : '',
      appointment.claimId     ? `Claim ID: ${appointment.claimId}`     : '',
    ].filter(Boolean).join('\n'),
    location: appointment.location,
    start: { dateTime: appointment.startDateTime, timeZone: 'America/New_York' },
    end:   { dateTime: appointment.endDateTime,   timeZone: 'America/New_York' },
    attendees: appointment.attendees?.map(email => ({ email })),
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email',  minutes: appointment.reminderMinutes ?? 1440 },
        { method: 'popup',  minutes: appointment.reminderMinutes ?? 60 },
      ],
    },
    extendedProperties: {
      private: {
        claimId:         appointment.claimId         ?? '',
        appointmentType: appointment.appointmentType ?? 'other',
      },
    },
  }

  const res = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: event })
  return { ...appointment, id: res.data.id }
}

export async function listAppointments(params: {
  startDate?: string
  endDate?: string
  maxResults?: number
  query?: string
}): Promise<Appointment[]> {
  const { calendar } = await getGoogleClients()

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin:    params.startDate ? new Date(params.startDate).toISOString() : new Date().toISOString(),
    timeMax:    params.endDate   ? new Date(params.endDate).toISOString()   : undefined,
    maxResults: params.maxResults ?? 50,
    singleEvents: true,
    orderBy: 'startTime',
    q: params.query,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (res.data.items ?? []).map((e: any) => ({
    id:            e.id,
    title:         e.summary ?? '(No title)',
    description:   e.description,
    startDateTime: e.start?.dateTime ?? e.start?.date,
    endDateTime:   e.end?.dateTime   ?? e.end?.date,
    location:      e.location,
    attendees:     (e.attendees ?? []).map((a: { email: string }) => a.email),
    claimId:       e.extendedProperties?.private?.claimId,
    appointmentType: e.extendedProperties?.private?.appointmentType,
  }))
}

export async function updateAppointment(eventId: string, updates: Partial<Appointment>): Promise<Appointment> {
  const { calendar } = await getGoogleClients()

  const patch: Record<string, unknown> = {}
  if (updates.title)         patch['summary']     = updates.title
  if (updates.description)   patch['description'] = updates.description
  if (updates.location)      patch['location']    = updates.location
  if (updates.startDateTime) patch['start'] = { dateTime: updates.startDateTime, timeZone: 'America/New_York' }
  if (updates.endDateTime)   patch['end']   = { dateTime: updates.endDateTime,   timeZone: 'America/New_York' }
  if (updates.attendees)     patch['attendees'] = updates.attendees.map(email => ({ email }))

  const res = await calendar.events.patch({ calendarId: CALENDAR_ID, eventId, requestBody: patch })
  return { id: res.data.id, title: res.data.summary, startDateTime: res.data.start?.dateTime, endDateTime: res.data.end?.dateTime }
}

export async function deleteAppointment(eventId: string): Promise<void> {
  const { calendar } = await getGoogleClients()
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId })
}

export async function findAvailability(params: {
  date: string
  durationMinutes: number
  workingHoursStart?: string  // e.g. "09:00"
  workingHoursEnd?: string    // e.g. "17:00"
}): Promise<Array<{ start: string; end: string }>> {
  const { calendar } = await getGoogleClients()

  const start = params.workingHoursStart ?? '08:00'
  const end   = params.workingHoursEnd   ?? '18:00'

  const dayStart = new Date(`${params.date}T${start}:00`)
  const dayEnd   = new Date(`${params.date}T${end}:00`)

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      items: [{ id: CALENDAR_ID }],
    },
  })

  const busy: Array<{ start: string; end: string }> = res.data.calendars?.[CALENDAR_ID]?.busy ?? []
  const slots: Array<{ start: string; end: string }> = []

  let cursor = dayStart
  const durationMs = params.durationMinutes * 60 * 1000

  for (const block of busy) {
    const blockStart = new Date(block.start)
    const blockEnd   = new Date(block.end)

    // Add slot before this busy block if there's enough time
    while (cursor.getTime() + durationMs <= blockStart.getTime()) {
      const slotEnd = new Date(cursor.getTime() + durationMs)
      slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() })
      cursor = slotEnd
      break  // Only first slot before next block
    }

    if (blockEnd > cursor) cursor = blockEnd
  }

  // Remaining time after last busy block
  while (cursor.getTime() + durationMs <= dayEnd.getTime()) {
    const slotEnd = new Date(cursor.getTime() + durationMs)
    slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() })
    cursor = slotEnd
    break
  }

  return slots
}

// ── Gmail tools ───────────────────────────────────────────────────────────────

export async function listEmails(params: {
  query?: string
  maxResults?: number
  unreadOnly?: boolean
  labels?: string[]
}): Promise<EmailMessage[]> {
  const { gmail } = await getGoogleClients()

  let q = params.query ?? ''
  if (params.unreadOnly) q += ' is:unread'
  if (params.labels?.length) q += ' ' + params.labels.map(l => `label:${l}`).join(' ')

  const listRes = await gmail.users.messages.list({
    userId: USER_EMAIL,
    q: q.trim(),
    maxResults: params.maxResults ?? 20,
  })

  const messageIds: string[] = (listRes.data.messages ?? []).map((m: { id: string }) => m.id)
  if (!messageIds.length) return []

  const messages = await Promise.all(
    messageIds.map(async (id: string) => {
      const msgRes = await gmail.users.messages.get({ userId: USER_EMAIL, id, format: 'full' })
      return parseGmailMessage(msgRes.data)
    }),
  )

  return messages.filter(Boolean) as EmailMessage[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseGmailMessage(msg: any): EmailMessage | null {
  if (!msg) return null
  const headers: Record<string, string> = {}
  for (const h of msg.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value

  const body = extractBodyText(msg.payload)

  return {
    id:      msg.id,
    threadId: msg.threadId,
    from:    headers['from'] ?? '',
    to:      (headers['to'] ?? '').split(',').map((s: string) => s.trim()),
    cc:      headers['cc'] ? headers['cc'].split(',').map((s: string) => s.trim()) : undefined,
    subject: headers['subject'] ?? '(No subject)',
    body,
    date:    headers['date'],
    labels:  msg.labelIds,
    isRead:  !(msg.labelIds ?? []).includes('UNREAD'),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBodyText(payload: any): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }
  for (const part of payload.parts ?? []) {
    const text = extractBodyText(part)
    if (text) return text
  }
  return ''
}

export async function sendEmail(draft: EmailDraft): Promise<{ messageId: string }> {
  const { gmail } = await getGoogleClients()

  const res = await gmail.users.messages.send({
    userId: USER_EMAIL,
    requestBody: { raw: encodeEmail(draft) },
  })

  return { messageId: res.data.id }
}

export async function draftEmail(draft: EmailDraft): Promise<{ draftId: string }> {
  const { gmail } = await getGoogleClients()

  const res = await gmail.users.drafts.create({
    userId: USER_EMAIL,
    requestBody: { message: { raw: encodeEmail(draft) } },
  })

  return { draftId: res.data.id }
}

export async function replyToEmail(originalMessageId: string, replyBody: string, sendImmediately = false): Promise<{ id: string }> {
  const { gmail } = await getGoogleClients()

  const originalRes = await gmail.users.messages.get({ userId: USER_EMAIL, id: originalMessageId, format: 'full' })
  const original = parseGmailMessage(originalRes.data)
  if (!original) throw new Error(`Could not find email ${originalMessageId}`)

  const draft: EmailDraft = {
    to: [original.from],
    cc: original.cc,
    subject: original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`,
    body: replyBody,
    replyToId: originalMessageId,
  }

  if (sendImmediately) return sendEmail(draft)
  return draftEmail(draft)
}

export async function searchEmails(query: string, maxResults = 10): Promise<EmailMessage[]> {
  return listEmails({ query, maxResults })
}

export async function markEmailRead(messageId: string): Promise<void> {
  const { gmail } = await getGoogleClients()
  await gmail.users.messages.modify({
    userId: USER_EMAIL,
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  })
}

// ── Tool schemas for Claude ───────────────────────────────────────────────────

export const calendarToolSchemas = [
  {
    name: 'cal_create_appointment',
    description: 'Create a new appointment or event in Google Calendar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title:           { type: 'string', description: 'Event title' },
        startDateTime:   { type: 'string', description: 'Start date/time in ISO 8601, e.g. 2024-03-15T10:00:00' },
        endDateTime:     { type: 'string', description: 'End date/time in ISO 8601' },
        description:     { type: 'string', description: 'Event description' },
        location:        { type: 'string', description: 'Physical address or meeting link' },
        attendees:       { type: 'array', items: { type: 'string' }, description: 'List of attendee email addresses' },
        claimId:         { type: 'string', description: 'Associated claim ID' },
        claimNumber:     { type: 'string', description: 'Associated claim number' },
        appointmentType: { type: 'string', enum: ['inspection','meeting','call','appraisal','mediation','other'] },
        reminderMinutes: { type: 'number', description: 'Reminder time in minutes before event (default 60)' },
      },
      required: ['title', 'startDateTime', 'endDateTime'],
    },
  },
  {
    name: 'cal_list_appointments',
    description: 'List upcoming calendar appointments, optionally filtered by date range or search query.',
    input_schema: {
      type: 'object' as const,
      properties: {
        startDate:  { type: 'string', description: 'Start date YYYY-MM-DD (default: today)' },
        endDate:    { type: 'string', description: 'End date YYYY-MM-DD' },
        maxResults: { type: 'number', description: 'Max events to return (default 50)' },
        query:      { type: 'string', description: 'Text search within events' },
      },
    },
  },
  {
    name: 'cal_update_appointment',
    description: 'Update an existing calendar appointment.',
    input_schema: {
      type: 'object' as const,
      properties: {
        eventId:       { type: 'string', description: 'Google Calendar event ID' },
        title:         { type: 'string' },
        startDateTime: { type: 'string', description: 'ISO 8601' },
        endDateTime:   { type: 'string', description: 'ISO 8601' },
        location:      { type: 'string' },
        description:   { type: 'string' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'cal_delete_appointment',
    description: 'Delete a calendar event.',
    input_schema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'string', description: 'Google Calendar event ID' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'cal_find_availability',
    description: 'Find available time slots on a given day, avoiding existing calendar events.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date:              { type: 'string', description: 'Date in YYYY-MM-DD format' },
        durationMinutes:   { type: 'number', description: 'How long the appointment should be in minutes' },
        workingHoursStart: { type: 'string', description: 'Start of working hours e.g. "09:00" (default 08:00)' },
        workingHoursEnd:   { type: 'string', description: 'End of working hours e.g. "17:00" (default 18:00)' },
      },
      required: ['date', 'durationMinutes'],
    },
  },
]

export const emailToolSchemas = [
  {
    name: 'email_list',
    description: 'List recent emails from Gmail inbox, optionally filtered.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query:       { type: 'string', description: 'Gmail search query e.g. "from:insurer@company.com subject:claim"' },
        maxResults:  { type: 'number', description: 'Max emails to return (default 20)' },
        unreadOnly:  { type: 'boolean', description: 'Only return unread emails' },
      },
    },
  },
  {
    name: 'email_search',
    description: 'Search Gmail for emails matching a query.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query:      { type: 'string', description: 'Gmail search query' },
        maxResults: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'email_send',
    description: 'Send an email via Gmail.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to:      { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
        cc:      { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body:    { type: 'string', description: 'Plain text email body' },
        claimId: { type: 'string', description: 'Associated claim ID for tracking' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'email_draft',
    description: 'Save an email as a draft in Gmail (does not send).',
    input_schema: {
      type: 'object' as const,
      properties: {
        to:      { type: 'array', items: { type: 'string' } },
        cc:      { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body:    { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'email_reply',
    description: 'Reply to an existing email.',
    input_schema: {
      type: 'object' as const,
      properties: {
        originalMessageId: { type: 'string', description: 'Gmail message ID to reply to' },
        replyBody:         { type: 'string', description: 'Reply body text' },
        sendImmediately:   { type: 'boolean', description: 'Send immediately (true) or save as draft (false, default)' },
      },
      required: ['originalMessageId', 'replyBody'],
    },
  },
]

export async function dispatchCalendarTool(toolName: string, input: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case 'cal_create_appointment':
      return createAppointment(input as Appointment)
    case 'cal_list_appointments':
      return listAppointments(input as Parameters<typeof listAppointments>[0])
    case 'cal_update_appointment':
      return updateAppointment(input['eventId'] as string, input as Partial<Appointment>)
    case 'cal_delete_appointment':
      return deleteAppointment(input['eventId'] as string)
    case 'cal_find_availability':
      return findAvailability(input as Parameters<typeof findAvailability>[0])
    default:
      throw new Error(`Unknown calendar tool: ${toolName}`)
  }
}

export async function dispatchEmailTool(toolName: string, input: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case 'email_list':
      return listEmails(input as Parameters<typeof listEmails>[0])
    case 'email_search':
      return searchEmails(input['query'] as string, input['maxResults'] as number | undefined)
    case 'email_send':
      return sendEmail(input as EmailDraft)
    case 'email_draft':
      return draftEmail(input as EmailDraft)
    case 'email_reply':
      return replyToEmail(input['originalMessageId'] as string, input['replyBody'] as string, input['sendImmediately'] as boolean | undefined)
    default:
      throw new Error(`Unknown email tool: ${toolName}`)
  }
}
