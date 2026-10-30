import { calendar as calendarApi } from '@googleapis/calendar';
import { z } from 'zod';
import { apiOptions, json, text } from './shared.js';

const api = (auth) => calendarApi({ version: 'v3', ...apiOptions(auth) });

/**
 * Who Google emails about a change. The API's own default is to email no one,
 * which turns "invite alice@example.com" into an event Alice never hears about
 * unless she happens to use Google Calendar. The tools therefore default to
 * "all", and say so, rather than inheriting a default that contradicts what
 * the model was told the tool does.
 */
const DEFAULT_SEND_UPDATES = 'all';

export async function listEvents(auth, { calendarId = 'primary', timeMin, timeMax, maxResults = 20 } = {}) {
  const calendar = api(auth);
  const res = await calendar.events.list({
    calendarId,
    timeMin: timeMin ?? new Date().toISOString(),
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return res.data.items ?? [];
}

export async function createEvent(
  auth,
  { calendarId = 'primary', summary, description, location, start, end, attendees, recurrence, sendUpdates = DEFAULT_SEND_UPDATES }
) {
  const calendar = api(auth);
  const res = await calendar.events.insert({
    calendarId,
    sendUpdates,
    requestBody: {
      summary,
      description,
      location,
      start,
      end,
      attendees: attendees?.map((email) => ({ email })),
      recurrence,
    },
  });
  return res.data;
}

export async function updateEvent(auth, { calendarId = 'primary', eventId, updates, sendUpdates = DEFAULT_SEND_UPDATES }) {
  const res = await api(auth).events.patch({ calendarId, eventId, sendUpdates, requestBody: updates });
  return res.data;
}

export async function deleteEvent(auth, { calendarId = 'primary', eventId, sendUpdates = DEFAULT_SEND_UPDATES }) {
  await api(auth).events.delete({ calendarId, eventId, sendUpdates });
}

export const MAX_ATTENDEES = 100;
export const MAX_RECURRENCE_LINES = 10;

export function registerCalendarTools(server, getClient) {
  // Google's event API distinguishes timed events from all-day ones by which
  // field is set, and supplying both is the usual cause of a confusing 400.
  const dateTimeShape = z
    .object({
      dateTime: z.string().optional().describe('RFC 3339 timestamp for a timed event, e.g. "2026-08-01T14:30:00-04:00". Use this or date, never both.'),
      // The classic off-by-one: a one-day event on the 1st ends on the 2nd.
      date: z.string().optional().describe('YYYY-MM-DD for an all-day event; an all-day end date is exclusive. Use this or dateTime, never both.'),
      timeZone: z.string().optional().describe('IANA time zone name, e.g. "America/Toronto". Optional when dateTime carries an offset.'),
    })
    .describe('Set dateTime for a timed event, or date for an all-day one.');

  const CALENDAR_ID = z
    .string()
    .optional()
    .describe('Calendar id, e.g. "you@gmail.com". Defaults to "primary", the main calendar.');

  const EVENT_ID = z.string().describe('Event id as returned by calendar_list_events. Not the event title.');

  const SEND_UPDATES = z
    .enum(['all', 'externalOnly', 'none'])
    .optional()
    .describe('Who Google emails about the change. Defaults to "all".');

  server.registerTool(
    'calendar_list_events',
    {
      title: 'List calendar events',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Lists upcoming events on a Google Calendar.',
      inputSchema: {
        calendarId: CALENDAR_ID,
        timeMin: z.string().optional().describe('Only return events ending after this RFC 3339 timestamp, e.g. "2026-08-01T00:00:00Z". Defaults to now.'),
        timeMax: z.string().optional().describe('Only return events starting before this RFC 3339 timestamp.'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Maximum events to return. Defaults to 20.'),
      },
    },
    async (args) => json(await listEvents(await getClient(), args))
  );

  server.registerTool(
    'calendar_create_event',
    {
      title: 'Create calendar event',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Creates a real event on the calendar immediately and, by default, emails an invitation to every attendee listed. No confirmation step.',
      inputSchema: {
        calendarId: CALENDAR_ID,
        summary: z.string().describe('Event title, shown in the calendar grid.'),
        description: z.string().optional().describe('Longer event notes, shown in the event detail view.'),
        location: z.string().optional().describe('Free-text location, e.g. an address or a room name.'),
        start: dateTimeShape,
        end: dateTimeShape,
        // Capped like every array input: GHSA-mrhx-c7xc-m3w5 (see gmail.js).
        attendees: z
          .array(z.string().email())
          .max(MAX_ATTENDEES, `attendees accepts at most ${MAX_ATTENDEES} addresses.`)
          .optional()
          .describe('Attendee email addresses. Adding someone sends them a real invitation immediately.'),
        recurrence: z
          .array(z.string())
          .max(MAX_RECURRENCE_LINES, `recurrence accepts at most ${MAX_RECURRENCE_LINES} lines.`)
          .optional()
          .describe('RFC 5545 RRULE lines, e.g. ["RRULE:FREQ=WEEKLY;INTERVAL=1"]'),
        sendUpdates: SEND_UPDATES,
      },
    },
    async (args) => {
      const event = await createEvent(await getClient(), args);
      return text(`Created: ${event.summary} (${event.id})\n${event.htmlLink ?? ''}`);
    }
  );

  server.registerTool(
    'calendar_update_event',
    {
      title: 'Update calendar event',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: 'Updates fields on an existing calendar event immediately and, by default, emails the change to its attendees.',
      inputSchema: {
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        updates: z
          .record(z.string(), z.any())
          .describe('Partial event object with only the fields to change, e.g. {"summary":"New title"} or {"start":{"dateTime":"..."}}. Unlisted fields are left as they are.'),
        sendUpdates: SEND_UPDATES,
      },
    },
    async (args) => {
      const event = await updateEvent(await getClient(), args);
      return text(`Updated: ${event.summary} (${event.id})`);
    }
  );

  server.registerTool(
    'calendar_delete_event',
    {
      title: 'Delete calendar event',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Permanently deletes a calendar event and, by default, emails a cancellation to its attendees. No confirmation step, not reversible.',
      inputSchema: { calendarId: CALENDAR_ID, eventId: EVENT_ID, sendUpdates: SEND_UPDATES },
    },
    async (args) => {
      await deleteEvent(await getClient(), args);
      return text(`Deleted event ${args.eventId}`);
    }
  );
}
