import { google } from 'googleapis';
import { z } from 'zod';

export async function listEvents(auth, { calendarId = 'primary', timeMin, timeMax, maxResults = 20 } = {}) {
  const calendar = google.calendar({ version: 'v3', auth });
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

export async function createEvent(auth, { calendarId = 'primary', summary, description, location, start, end, attendees, recurrence }) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.insert({
    calendarId,
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

export async function updateEvent(auth, { calendarId = 'primary', eventId, updates }) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.patch({ calendarId, eventId, requestBody: updates });
  return res.data;
}

export async function deleteEvent(auth, { calendarId = 'primary', eventId }) {
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({ calendarId, eventId });
}

export function registerCalendarTools(server, getClient) {
  // Google's event API distinguishes timed events from all-day ones by which
  // field is set, and supplying both is the usual cause of a confusing 400.
  const dateTimeShape = z
    .object({
      dateTime: z.string().optional().describe('RFC 3339 timestamp for a timed event, e.g. "2026-08-01T14:30:00-04:00". Use this or date, never both.'),
      date: z.string().optional().describe('Date as YYYY-MM-DD for an all-day event. Use this or dateTime, never both.'),
      timeZone: z.string().optional().describe('IANA time zone name, e.g. "America/Toronto". Optional when dateTime carries an offset.'),
    })
    .describe('An event boundary: set dateTime for a timed event, or date for an all-day event.');

  const CALENDAR_ID = z
    .string()
    .optional()
    .describe('Calendar id — an email-like address such as "you@gmail.com", or "primary" for the default calendar. Defaults to "primary".');

  const EVENT_ID = z.string().describe('Event id as returned by calendar_list_events. Not the event title.');

  server.registerTool(
    'calendar_list_events',
    {
      title: 'List calendar events',
      description: 'Lists upcoming events on a Google Calendar.',
      inputSchema: {
        calendarId: CALENDAR_ID,
        timeMin: z.string().optional().describe('Only return events ending after this RFC 3339 timestamp, e.g. "2026-08-01T00:00:00Z". Defaults to now.'),
        timeMax: z.string().optional().describe('Only return events starting before this RFC 3339 timestamp.'),
        maxResults: z.number().int().min(1).max(100).optional().describe('Maximum events to return, 1-100. Defaults to 10.'),
      },
    },
    async (args) => {
      const auth = await getClient();
      const events = await listEvents(auth, args);
      return { content: [{ type: 'text', text: JSON.stringify(events, null, 2) }] };
    }
  );

  server.registerTool(
    'calendar_create_event',
    {
      title: 'Create calendar event',
      description:
        'Creates a real event on the calendar immediately, including sending invites to any attendees listed. No confirmation step.',
      inputSchema: {
        calendarId: CALENDAR_ID,
        summary: z.string().describe('Event title, shown in the calendar grid.'),
        description: z.string().optional().describe('Longer event notes, shown in the event detail view.'),
        location: z.string().optional().describe('Free-text location, e.g. an address or a room name.'),
        start: dateTimeShape,
        end: dateTimeShape,
        attendees: z
          .array(z.string().email())
          .optional()
          .describe('Attendee email addresses. Adding someone sends them a real invitation immediately.'),
        recurrence: z
          .array(z.string())
          .optional()
          .describe('RFC 5545 RRULE lines, e.g. ["RRULE:FREQ=WEEKLY;INTERVAL=1"]'),
      },
    },
    async (args) => {
      const auth = await getClient();
      const event = await createEvent(auth, args);
      return { content: [{ type: 'text', text: `Created: ${event.summary} (${event.id})\n${event.htmlLink ?? ''}` }] };
    }
  );

  server.registerTool(
    'calendar_update_event',
    {
      title: 'Update calendar event',
      description: 'Updates fields on an existing calendar event immediately.',
      inputSchema: {
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        updates: z
          .record(z.string(), z.any())
          .describe('Partial event object with only the fields to change, e.g. {"summary":"New title"} or {"start":{"dateTime":"..."}}. Unlisted fields are left as they are.'),
      },
    },
    async ({ calendarId, eventId, updates }) => {
      const auth = await getClient();
      const event = await updateEvent(auth, { calendarId, eventId, updates });
      return { content: [{ type: 'text', text: `Updated: ${event.summary} (${event.id})` }] };
    }
  );

  server.registerTool(
    'calendar_delete_event',
    {
      title: 'Delete calendar event',
      description: 'Permanently deletes a calendar event. No confirmation step, not reversible.',
      inputSchema: { calendarId: CALENDAR_ID, eventId: EVENT_ID },
    },
    async ({ calendarId, eventId }) => {
      const auth = await getClient();
      await deleteEvent(auth, { calendarId, eventId });
      return { content: [{ type: 'text', text: `Deleted event ${eventId}` }] };
    }
  );
}
