import { google } from 'googleapis';
import { z } from 'zod';

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// YouTube ids are all opaque strings of similar shape, so the useful thing to
// say is where each one comes from and how to tell them apart — a channel id
// passed where a playlist id belongs fails with an unhelpful 404.
const VIDEO_ID = z.string().describe('Video id — the 11-character code after "watch?v=" or "youtu.be/", e.g. "dQw4w9WgXcQ". Not the full URL.');
const CHANNEL_ID = z.string().describe('Channel id, a 24-character string beginning "UC", e.g. "UCBJycsmduvYEL83R_U4JriQ". Not the @handle and not the display name.');
const PLAYLIST_ID = z.string().describe('Playlist id — the value after "list=" in a playlist URL, usually beginning "PL", "UU", or "LL".');
// Named `limitField` rather than `maxResults` so it doesn't shadow the handler
// parameter of the same name further down.
const limitField = (max, dflt) =>
  z.number().int().min(1).max(max).optional().describe(`Maximum results to return, 1-${max}. Defaults to ${dflt}.`);

export function registerYoutubeTools(server, getClient) {
  async function yt(auth) {
    return google.youtube({ version: 'v3', auth });
  }

  server.registerTool(
    'youtube_search',
    {
      title: 'Search YouTube',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Searches YouTube for videos, channels, or playlists matching a query.',
      inputSchema: {
        query: z.string().describe('Search terms.'),
        type: z.enum(['video', 'channel', 'playlist']).optional().describe('Restrict results to one resource type. Omit to return a mix of all three.'),
        maxResults: limitField(50, 10),
        order: z.enum(['relevance', 'date', 'rating', 'title', 'viewCount']).optional().describe('Result ordering. Defaults to relevance.'),
      },
    },
    async ({ query, type, maxResults, order }) => {
      const client = await yt(await getClient());
      const res = await client.search.list({
        part: ['snippet'],
        q: query,
        type: type ? [type] : undefined,
        maxResults: maxResults ?? 10,
        order,
      });
      return json(res.data.items);
    }
  );

  server.registerTool(
    'youtube_get_video',
    {
      title: 'Get video details',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Gets snippet, statistics (views/likes/comments), and content details for one or more video IDs.',
      inputSchema: { videoIds: z.array(VIDEO_ID).min(1).max(50).describe('One to 50 video ids to look up in a single call.') },
    },
    async ({ videoIds }) => {
      const client = await yt(await getClient());
      const res = await client.videos.list({ part: ['snippet', 'statistics', 'contentDetails'], id: videoIds });
      return json(res.data.items);
    }
  );

  server.registerTool(
    'youtube_get_channel',
    {
      title: 'Get channel details',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Gets info for a channel by id, by @handle, or "mine" for the authorized account\'s own channel.',
      inputSchema: {
        channelId: CHANNEL_ID.optional().describe('Channel id beginning "UC". Provide exactly one of channelId, handle, or mine.'),
        handle: z.string().optional().describe('Channel @handle including the leading @, e.g. "@mkbhd".'),
        mine: z.boolean().optional().describe("Set true to return the authorized account's own channel."),
      },
    },
    async ({ channelId, handle, mine }) => {
      const client = await yt(await getClient());
      const res = await client.channels.list({
        part: ['snippet', 'statistics', 'contentDetails'],
        id: channelId ? [channelId] : undefined,
        forHandle: handle,
        mine: mine || undefined,
      });
      return json(res.data.items);
    }
  );

  server.registerTool(
    'youtube_list_playlists',
    {
      title: 'List playlists',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Lists playlists for "mine" or a given channel id.',
      inputSchema: {
        channelId: CHANNEL_ID.optional().describe('List playlists belonging to this channel. Omit and set mine=true for your own.'),
        mine: z.boolean().optional().describe("Set true to list the authorized account's own playlists."),
        maxResults: limitField(50, 25),
      },
    },
    async ({ channelId, mine, maxResults }) => {
      const client = await yt(await getClient());
      const res = await client.playlists.list({
        part: ['snippet', 'contentDetails'],
        channelId,
        mine: mine || undefined,
        maxResults: maxResults ?? 25,
      });
      return json(res.data.items);
    }
  );

  server.registerTool(
    'youtube_list_playlist_items',
    {
      title: 'List videos in a playlist',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Lists the videos contained in a playlist, in order.',
      inputSchema: { playlistId: PLAYLIST_ID, maxResults: limitField(50, 50) },
    },
    async ({ playlistId, maxResults }) => {
      const client = await yt(await getClient());
      const res = await client.playlistItems.list({ part: ['snippet', 'contentDetails'], playlistId, maxResults: maxResults ?? 50 });
      return json(res.data.items);
    }
  );

  server.registerTool(
    'youtube_create_playlist',
    {
      title: 'Create a playlist',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: 'Creates a real playlist on the authorized channel immediately.',
      inputSchema: {
        title: z.string().describe('Playlist title, max 150 characters.'),
        description: z.string().optional().describe('Playlist description, max 5000 characters.'),
        privacyStatus: z.enum(['private', 'public', 'unlisted']).optional().describe('Visibility. Defaults to "private".'),
      },
    },
    async ({ title, description, privacyStatus }) => {
      const client = await yt(await getClient());
      const res = await client.playlists.insert({
        part: ['snippet', 'status'],
        requestBody: { snippet: { title, description }, status: { privacyStatus: privacyStatus ?? 'private' } },
      });
      return json(res.data);
    }
  );

  server.registerTool(
    'youtube_add_to_playlist',
    {
      title: 'Add a video to a playlist',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: 'Inserts a video into a playlist immediately.',
      inputSchema: {
        playlistId: PLAYLIST_ID,
        videoId: VIDEO_ID,
        position: z.number().int().min(0).optional().describe('Zero-based insert position. Omit to append to the end.'),
      },
    },
    async ({ playlistId, videoId, position }) => {
      const client = await yt(await getClient());
      const res = await client.playlistItems.insert({
        part: ['snippet'],
        requestBody: { snippet: { playlistId, position, resourceId: { kind: 'youtube#video', videoId } } },
      });
      return json(res.data);
    }
  );

  server.registerTool(
    'youtube_list_subscriptions',
    {
      title: 'List subscriptions',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Lists channels the authorized account is subscribed to.',
      inputSchema: { maxResults: limitField(50, 50) },
    },
    async ({ maxResults }) => {
      const client = await yt(await getClient());
      const res = await client.subscriptions.list({ part: ['snippet'], mine: true, maxResults: maxResults ?? 50 });
      return json(res.data.items);
    }
  );

  server.registerTool(
    'youtube_subscribe',
    {
      title: 'Subscribe to a channel',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: 'Subscribes the authorized account to a channel immediately.',
      inputSchema: { channelId: CHANNEL_ID },
    },
    async ({ channelId }) => {
      const client = await yt(await getClient());
      const res = await client.subscriptions.insert({ part: ['snippet'], requestBody: { snippet: { resourceId: { kind: 'youtube#channel', channelId } } } });
      return json(res.data);
    }
  );

  server.registerTool(
    'youtube_get_comments',
    {
      title: 'Get comments on a video',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Lists top-level comment threads on a video.',
      inputSchema: {
        videoId: VIDEO_ID,
        maxResults: limitField(100, 20),
        order: z.enum(['time', 'relevance']).optional().describe('Comment ordering. Defaults to YouTube\'s own relevance ranking.'),
      },
    },
    async ({ videoId, maxResults, order }) => {
      const client = await yt(await getClient());
      const res = await client.commentThreads.list({ part: ['snippet', 'replies'], videoId, maxResults: maxResults ?? 20, order });
      return json(res.data.items);
    }
  );

  server.registerTool(
    'youtube_post_comment',
    {
      title: 'Post a comment on a video',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: 'Posts a real top-level comment on a video immediately.',
      inputSchema: { videoId: VIDEO_ID, text: z.string().describe('Comment body as plain text.') },
    },
    async ({ videoId, text }) => {
      const client = await yt(await getClient());
      const res = await client.commentThreads.insert({
        part: ['snippet'],
        requestBody: { snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } },
      });
      return json(res.data);
    }
  );

  server.registerTool(
    'youtube_reply_to_comment',
    {
      title: 'Reply to a comment',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: 'Posts a real reply to an existing comment thread immediately.',
      inputSchema: {
        parentCommentId: z.string().describe('Id of the top-level comment thread being replied to, from youtube_get_comments.'),
        text: z.string().describe('Reply body as plain text.'),
      },
    },
    async ({ parentCommentId, text }) => {
      const client = await yt(await getClient());
      const res = await client.comments.insert({ part: ['snippet'], requestBody: { snippet: { parentId: parentCommentId, textOriginal: text } } });
      return json(res.data);
    }
  );

  server.registerTool(
    'youtube_rate_video',
    {
      title: 'Like / dislike a video',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: "Sets the authorized account's rating on a video immediately.",
      inputSchema: { videoId: VIDEO_ID, rating: z.enum(['like', 'dislike', 'none']).describe('"like" or "dislike" to rate, "none" to remove an existing rating.') },
    },
    async ({ videoId, rating }) => {
      const client = await yt(await getClient());
      await client.videos.rate({ id: videoId, rating });
      return { content: [{ type: 'text', text: `Rated ${videoId}: ${rating}` }] };
    }
  );
}
