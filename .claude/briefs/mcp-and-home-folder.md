# Brief: home folder as start fallback, MCP servers in CodePal

Date: 2026-11-15. Answers given by the user in chat; nothing here is assumed.

## The user's solution

1. **Start folder.** Keep today's order (folder given on the command line, else the last
   folder) but fall back to the user's **home folder** instead of the launch directory
   when there is no last folder or it no longer exists. (A Store or Start-menu launch has
   an odd system folder as its launch directory.)
2. **MCP servers**, using **pi's built-in MCP extension** (already in
   `@earendil-works/pi-coding-agent` 1.5.0), not the third-party pi-mcp-extension.
   - Config: **CodePal's own** `<userData>/pi-agent/mcp.json`, plus `.pi/mcp.json` in
     trusted projects. Not shared with the pi CLI's `~/.pi/agent`.
   - UI: an **MCP panel** listing servers with status and enable/disable, an
     **add-server form** (name, command or URL, optional env/headers) that writes
     `mcp.json`, **"Edit mcp.json"** in a Monaco tab for advanced cases, **presets** for a
     few common servers, and **browsing MCP resources and prompts**.
   - Approval: an approval card for every MCP tool call **except tools the server marks
     `readOnlyHint`**; "don't ask again" per tool for the conversation, as today.
3. **Store release**: build and submit a new version (0.2.0) to the Microsoft Store.

## Who it is for

All CodePal customers, including non-technical users (hence the form and presets).

## Out of scope

- MCP servers that need an OAuth browser sign-in. They are listed with a
  "needs sign-in, not supported yet" status.

## Done, in measurable terms

- An automated smoke test configures a real local stdio MCP server, starts a CodePal
  agent session, and asserts that the server's tool is available and that calling it
  returns the expected result through the approval gate.

## Conflicts resolved with the user

- "All customers" vs "panel + JSON only": resolved by adding the add-server form; the
  JSON editor stays for advanced use.
- Out-of-scope list: the user confirmed presets, the resources/prompts UI and the Store
  release are in scope; only OAuth is out.
