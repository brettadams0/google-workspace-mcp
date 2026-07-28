import { google } from 'googleapis';
import { z } from 'zod';

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function registerYoutubeTools(server, getClient) {
  async function yt(auth) {
    return google.youtube({ version: 'v3', auth });
  }

  server.registerTool(
    'youtube_search',
    {
      title: 'Search YouTube',
      description: 'Searches YouTube for videos, channels, or playlists matching a query.',
      inputSchema: {
        query: z.string(),
        type: z.enum(['video', 'channel', 'playlist']).optional(),
        maxResults: z.number().int().min(1).max(50).optional(),
        order: z.enum(['relevance', 'date', 'rating', 'title', 'viewCount']).optional(),
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
      description: 'Gets snippet, statistics (views/likes/comments), and content details for one or more video IDs.',
      inputSchema: { videoIds: z.array(z.string()).min(1).max(50) },
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
      description: 'Gets info for a channel by id, by @handle, or "mine" for the authorized account\'s own channel.',
      inputSchema: {
        channelId: z.string().optional(),
        handle: z.string().optional().describe('e.g. "@mkbhd" including the @'),
        mine: z.boolean().optional(),
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
      description: 'Lists playlists for "mine" or a given channel id.',
      inputSchema: { channelId: z.string().optional(), mine: z.boolean().optional(), maxResults: z.number().int().min(1).max(50).optional() },
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
      description: 'Lists the videos contained in a playlist, in order.',
      inputSchema: { playlistId: z.string(), maxResults: z.number().int().min(1).max(50).optional() },
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
      description: 'Creates a real playlist on the authorized channel immediately.',
      inputSchema: { title: z.string(), description: z.string().optional(), privacyStatus: z.enum(['private', 'public', 'unlisted']).optional() },
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
      description: 'Inserts a video into a playlist immediately.',
      inputSchema: { playlistId: z.string(), videoId: z.string(), position: z.number().int().min(0).optional() },
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
      description: 'Lists channels the authorized account is subscribed to.',
      inputSchema: { maxResults: z.number().int().min(1).max(50).optional() },
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
      description: 'Subscribes the authorized account to a channel immediately.',
      inputSchema: { channelId: z.string() },
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
      description: 'Lists top-level comment threads on a video.',
      inputSchema: { videoId: z.string(), maxResults: z.number().int().min(1).max(100).optional(), order: z.enum(['time', 'relevance']).optional() },
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
      description: 'Posts a real top-level comment on a video immediately.',
      inputSchema: { videoId: z.string(), text: z.string() },
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
      description: 'Posts a real reply to an existing comment thread immediately.',
      inputSchema: { parentCommentId: z.string(), text: z.string() },
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
      description: "Sets the authorized account's rating on a video immediately.",
      inputSchema: { videoId: z.string(), rating: z.enum(['like', 'dislike', 'none']) },
    },
    async ({ videoId, rating }) => {
      const client = await yt(await getClient());
      await client.videos.rate({ id: videoId, rating });
      return { content: [{ type: 'text', text: `Rated ${videoId}: ${rating}` }] };
    }
  );
}
