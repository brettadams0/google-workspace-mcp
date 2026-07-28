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
  const dateTimeShape = z.object({
    dateTime: z.string().optional(),
    date: z.string().optional(),
    timeZone: z.string().optional(),
  });

  server.registerTool(
    'calendar_list_events',
    {
      title: 'List calendar events',
      description: 'Lists upcoming events on a Google Calendar.',
      inputSchema: {
        calendarId: z.string().optional(),
        timeMin: z.string().optional(),
        timeMax: z.string().optional(),
        maxResults: z.number().int().min(1).max(100).optional(),
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
        calendarId: z.string().optional(),
        summary: z.string(),
        description: z.string().optional(),
        location: z.string().optional(),
        start: dateTimeShape,
        end: dateTimeShape,
        attendees: z.array(z.string().email()).optional(),
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
        calendarId: z.string().optional(),
        eventId: z.string(),
        updates: z.record(z.string(), z.any()),
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
      inputSchema: { calendarId: z.string().optional(), eventId: z.string() },
    },
    async ({ calendarId, eventId }) => {
      const auth = await getClient();
      await deleteEvent(auth, { calendarId, eventId });
      return { content: [{ type: 'text', text: `Deleted event ${eventId}` }] };
    }
  );
}
