#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getAuthorizedClient } from './auth.js';
import { registerGmailTools } from './gmail.js';
import { registerDriveTools } from './drive.js';
import { registerCalendarTools } from './calendar.js';
import { registerSheetsTools } from './sheets.js';
import { registerYoutubeTools } from './youtube.js';

const server = new McpServer({ name: 'google-workspace', version: '1.0.0' });

registerGmailTools(server, getAuthorizedClient);
registerDriveTools(server, getAuthorizedClient);
registerCalendarTools(server, getAuthorizedClient);
registerSheetsTools(server, getAuthorizedClient);
registerYoutubeTools(server, getAuthorizedClient);

const transport = new StdioServerTransport();
await server.connect(transport);
