# Agent platform and protocol compatibility

**Researched 2026-11-08** from official docs, unless an entry is marked UNVERIFIED. Several official pages could not be read and are marked as such: help.openai.com returned 403, as did the OpenAI DevDay recap; the VS Code MCP reference was not reached.

**Availability labels:**
- **Consumer:** in the product end users already have.
- **API:** available to developers through an API.
- **Enterprise:** enterprise plans only.
- **Beta / Preview:** offered, but not generally available.
- **Custom:** possible, but needs our own code.
- **Unsupported:** not available.

## What no platform provides

**No platform** documents a cryptographically verifiable per-agent-instance identity sent to a third-party MCP server.
- **What the server can learn:** at best, which *client application* is connecting. This comes from the OAuth `client_id` (via dynamic registration, a Client ID Metadata Document, or Claude's published identity) or from self-declared `clientInfo`.
- **ChatGPT `_meta["openai/subject"]`:** said to be an anonymised user ID. Reported only in community posts; UNVERIFIED.
- **Google's SPIFFE "Agent Identity":** used for Google Cloud IAM. UNVERIFIED that it is ever passed to a third-party MCP server.
- **Consequence for ProxyProof:** it binds agent identity itself, using a key the agent controls or a ProxyProof-issued connection credential. Each connection's **assurance level** is recorded, and platform identity is never invented.

## Matrix

| Platform | Supported connection | How ProxyProof integrates | Limitations | Demonstration method | Availability |
|---|---|---|---|---|---|
| Claude Code | `claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"` | Localhost MCP URL plus a connection token header | Server-side events (SSE) are deprecated; use Streamable HTTP | **Live, localhost** | Consumer CLI |
| Claude.ai / Desktop custom connectors | Remote MCP connector | Public HTTPS URL; "No sign in", OAuth, or fixed request headers | Reached "from Anthropic's cloud", so localhost cannot work. Free plan allows 1 custom connector | Needs a public URL (tunnel or hosting); otherwise docs only | Consumer |
| Claude API MCP connector | `mcp_servers` with `mcp_toolset` (beta header `mcp-client-2025-11-20` or `mcp-client-2026-09-15`) | `url` plus `authorization_token` | URL must be public `https://`; tools only | Needs a public URL | API (beta) |
| OpenAI Responses API | `{"type":"mcp","server_url",…,"require_approval"}` | `server_url` plus `authorization`, or a Secure MCP Tunnel | Needs a public server or tunnel; approval is per tool call | Needs a public URL or tunnel | API |
| OpenAI Agents API | `{"type":"mcp","transport":{…},"connection_origin"}` | Service origin needs a public server; environment origin reaches the session's own localhost | Beta status is not stated on the page | Docs only | API |
| OpenAI Agents SDK | `MCPServerStreamableHttp(params={"url":…,"headers":…})` | Localhost URL plus header | The client runs in your own process; needs a model key | **Live, localhost** with an OpenAI key | Open-source SDK |
| ChatGPT developer mode / apps | "Add custom MCP server" | Public HTTPS URL, or a Secure MCP Tunnel | Plan eligibility differs between sources (UNVERIFIED); write actions may need confirmation or be blocked | Needs a public URL and an eligible plan | Consumer / Business (beta) |
| OpenAI "Dots" | Uses the connectors already in the ChatGPT account | Indirectly, through a ChatGPT custom connector | No official docs could be read; details UNVERIFIED | Docs only | Consumer beta (secondary sources) |
| Grok (consumer) | grok.com/connectors → Custom | Public URL | "Must be reachable over the public internet"; approval behaviour undocumented | Needs a public URL | Consumer |
| xAI API | `{"type":"mcp","server_url","authorization","headers"}` | URL plus headers | `require_approval` is not supported | Needs a public URL and API credits | API |
| Gemini Interactions API | `{"type":"mcp_server","url","headers"}` | URL plus headers | Streamable HTTP only; the docs contradict each other on Gemini 3 support | Needs a public URL | API (Preview) |
| Gemini SDK | MCP `ClientSession` passed into `tools` | Local client session pointing at localhost | Automatic tool calling runs tools without asking unless disabled | **Live, localhost** with a Gemini key | API / SDK |
| Gemini Enterprise Agent Platform | "BYO-MCP and A2A agents", Agent Registry and Gateway | Register as an MCP server | Paid Google Cloud | Docs only | Enterprise |
| Google ADK | `McpToolset(StreamableHTTPConnectionParams(url, headers))` | Localhost URL plus header | Unclear whether confirmation applies to MCP tools | **Live, localhost** with a model key | Open source |
| MCP Inspector, Cursor, LangChain MCP adapters | Direct HTTP client | Localhost URL plus header | — | **Live, localhost** | Free / open source |
| Any agent or framework | ProxyProof REST API | Ed25519 key held by the agent; signed requests | — | **Live** (independent test agent) | Custom |

## Implications for ProxyProof

1. **Genuine external connections available today, without paid accounts or public hosting:** Claude Code, MCP Inspector, and the ProxyProof REST API used by an independently written agent.
2. **Need a public HTTPS URL** (tunnel or hosting, which needs the user's approval):
   - Claude.ai / Desktop custom connectors
   - Claude API connector
   - OpenAI Responses and ChatGPT
   - Grok and the xAI API
   - Gemini remote MCP
3. **Shown only as documented setup:** OpenAI Dots, OpenAI Agents API environment mode, and Gemini Enterprise Agent Platform. They are never presented as a live connection.
4. **Transport:** Streamable HTTP, which every platform supports and Gemini requires.
5. **Authentication:** a static bearer header for the hackathon, recorded as the assurance level "connection token". OAuth 2.1 with Protected Resource Metadata is future work.
6. **Platform approval prompts** add to ProxyProof's checks; they are never treated as the principal's consent. The prompts differ by platform:
   - xAI has none.
   - OpenAI prompts per call, and this can be switched off.
   - Claude offers "Allow always".

## Sources

**Anthropic**
- [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude API MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)

**OpenAI**
- [Responses API MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [Agents API MCP](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [ChatGPT connect](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
- [Agents SDK MCP](https://openai.github.io/openai-agents-python/mcp/)

**xAI**
- [xAI remote MCP](https://docs.x.ai/developers/tools/remote-mcp)
- [Grok connectors](https://docs.x.ai/grok/connectors)

**Google**
- [Gemini API docs](https://aistudio.google.com/llms-full.txt)
- [Gemini Enterprise Agent Platform](https://docs.cloud.google.com/gemini-enterprise-agent-platform/agents)
- [ADK MCP tools](https://adk.dev/tools-custom/mcp-tools/)
