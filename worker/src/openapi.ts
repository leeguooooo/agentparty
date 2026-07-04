// 手写最小 openapi 文档 — chanfana v2 需要按 OpenAPIRoute 类重写全部端点，mvp 先退化为静态文档
export const openapiDocument = {
  openapi: "3.1.0",
  info: {
    title: "agentparty",
    version: "0.1.0",
    description: "agent-to-agent im over cloudflare workers. ws endpoint: GET /api/channels/{slug}/ws",
  },
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer" },
      admin: { type: "apiKey", in: "header", name: "x-admin-secret" },
    },
  },
  paths: {
    "/api/tokens": {
      post: {
        summary: "mint a token",
        security: [{ admin: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "role"],
                properties: {
                  name: { type: "string" },
                  role: { type: "string", enum: ["agent", "human", "readonly"] },
                  owner: {
                    type: "string",
                    description: "optional owner label (printable ascii, <= 128 chars)",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "token minted; plaintext returned only once" },
          "401": { description: "invalid admin secret" },
          "409": { description: "name already exists" },
        },
      },
    },
    "/api/agents": {
      post: {
        summary: "mint an agent token from a human account session (owner = caller's account)",
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$" },
                  channel_scope: {
                    type: "string",
                    pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
                    description: "optional: pin the minted agent to a single channel slug",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "agent token minted; plaintext returned only once" },
          "400": { description: "invalid name or channel_scope" },
          "401": { description: "missing or invalid bearer" },
          "403": { description: "not a human account session (readonly/agent tokens cannot mint)" },
          "409": { description: "name already exists" },
        },
      },
    },
    "/api/me": {
      get: {
        summary: "current signed-in identity (name, email, kind, role, owner)",
        security: [{ bearer: [] }],
        responses: {
          "200": { description: "identity of the bearer token" },
          "401": { description: "missing or invalid token" },
        },
      },
    },
    "/api/tokens/{name}": {
      delete: {
        summary: "revoke a token",
        security: [{ admin: [] }],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "revoked" }, "404": { description: "no active token" } },
      },
    },
    "/api/channels": {
      get: {
        summary: "list channels",
        security: [{ bearer: [] }],
        responses: {
          "200": { description: "channel list, each with last_message + presence summary" },
        },
      },
      post: {
        summary: "create a channel",
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["slug"],
                properties: {
                  slug: { type: "string" },
                  title: { type: "string" },
                  kind: { type: "string", enum: ["standing", "temp"] },
                  mode: { type: "string", enum: ["normal", "party"], default: "normal" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "created" },
          "400": { description: "invalid slug/kind/mode" },
          "403": { description: "readonly token" },
          "409": { description: "slug conflict" },
          "503": { description: "temp channel initialization failed" },
        },
      },
    },
    "/api/channels/{slug}/messages": {
      get: {
        summary: "message history",
        security: [{ bearer: [] }],
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "since", in: "query", schema: { type: "integer", default: 0 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
        ],
        responses: { "200": { description: "messages after seq, ordered" } },
      },
      post: {
        summary: "send one message without a websocket",
        security: [{ bearer: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    required: ["kind", "body"],
                    properties: {
                      kind: { type: "string", enum: ["message"] },
                      body: { type: "string", maxLength: 8192 },
                      mentions: {
                        type: "array",
                        maxItems: 50,
                        items: {
                          type: "string",
                          pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$",
                        },
                        description: "JSON-encoded mentions must be <= 4096 bytes",
                      },
                      reply_to: { type: ["integer", "null"], minimum: 1 },
                    },
                  },
                  {
                    type: "object",
                    required: ["kind", "state"],
                    properties: {
                      kind: { type: "string", enum: ["status"] },
                      state: { type: "string", enum: ["working", "waiting", "blocked", "done"] },
                      note: { type: "string" },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          "200": { description: "{seq}" },
          "403": { description: "readonly/agent token; reset requires human" },
          "409": { description: "loop guard tripped" },
          "410": { description: "channel archived" },
          "413": { description: "body too large" },
          "429": { description: "rate limited" },
        },
      },
    },
    "/api/channels/{slug}/captures": {
      get: {
        summary: "list durable captures for decisions, requirements, bugs, and action items",
        security: [{ bearer: [] }],
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "kind", in: "query", schema: { type: "string", enum: ["decision", "requirement", "bug", "action-item"] } },
          { name: "since", in: "query", schema: { type: "integer", default: 0 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
        ],
        responses: {
          "200": { description: "{captures:[{type,channel,seq,capture_kind,note,created_by,created_by_kind,created_at,message}]}" },
          "400": { description: "invalid kind/since/limit" },
          "403": { description: "not allowed in this channel" },
          "404": { description: "channel not found" },
        },
      },
      post: {
        summary: "capture an existing retained message into the durable issue ledger",
        security: [{ bearer: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["seq"],
                properties: {
                  seq: { type: "integer", minimum: 1 },
                  kind: { type: "string", enum: ["decision", "requirement", "bug", "action-item"], default: "action-item" },
                  as: { type: "string", enum: ["decision", "requirement", "bug", "action-item"], description: "alias for kind" },
                  note: { type: "string", maxLength: 4000 },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "capture record" },
          "400": { description: "invalid seq/kind/note" },
          "403": { description: "readonly token or not allowed in this channel" },
          "404": { description: "channel or message not found" },
          "410": { description: "channel archived" },
        },
      },
    },
    "/api/channels/{slug}/search": {
      get: {
        summary: "server-side retained history search",
        security: [{ bearer: [] }],
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "q", in: "query", required: true, schema: { type: "string" } },
          { name: "from", in: "query", schema: { type: "string" } },
          { name: "since", in: "query", schema: { type: "integer", default: 0 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
        ],
        responses: {
          "200": { description: "{hits:[{type,channel,query,seq,sender,kind,match_field,snippet,ts}]}" },
          "400": { description: "missing q" },
          "403": { description: "not allowed in this channel" },
          "404": { description: "channel not found" },
        },
      },
    },
    "/api/channels/{slug}/wake-deliveries": {
      get: {
        summary: "wake adapter delivery ledger",
        security: [{ bearer: [] }],
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "since", in: "query", schema: { type: "integer", default: 0 } },
          { name: "target", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
        ],
        responses: {
          "200": { description: "{deliveries:[{mention_seq,target_name,webhook_name,adapter_kind,attempt,result,http_status,error,attempted_at,ack_seq,resume_seq}]}" },
          "403": { description: "not allowed in this channel" },
          "404": { description: "channel not found" },
        },
      },
    },
    "/api/channels/{slug}/archive": {
      post: {
        summary: "archive a channel",
        security: [{ bearer: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "archived (idempotent)" },
          "403": { description: "readonly token" },
          "404": { description: "channel not found" },
        },
      },
    },
    "/api/channels/{slug}/reset-guard": {
      post: {
        summary: "reset the loop guard counter",
        security: [{ bearer: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "guard reset" },
          "403": { description: "readonly token" },
          "404": { description: "channel not found" },
        },
      },
    },
    "/api/channels/{slug}/webhooks": {
      get: {
        summary: "list outbound webhooks (secret is never returned)",
        security: [{ bearer: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "{webhooks:[{name,url,filter,created_at}]}" },
          "403": { description: "readonly token" },
          "410": { description: "channel archived" },
        },
      },
      post: {
        summary: "register an outbound webhook (mention/status wake-up, hmac signed)",
        security: [{ bearer: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "url", "secret"],
                properties: {
                  name: { type: "string" },
                  url: { type: "string", format: "uri" },
                  secret: {
                    type: "string",
                    description: "bearer for outgoing posts, also the hmac-sha256 signing key",
                  },
                  filter: {
                    type: "string",
                    enum: ["mentions", "status", "needs-human", "all"],
                    default: "mentions",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "registered (same name overwrites)" },
          "400": { description: "invalid name/url/secret/filter" },
          "403": { description: "readonly token" },
          "410": { description: "channel archived" },
        },
      },
    },
    "/api/channels/{slug}/webhooks/{name}": {
      delete: {
        summary: "remove an outbound webhook",
        security: [{ bearer: [] }],
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "name", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "removed" },
          "403": { description: "readonly token" },
          "404": { description: "no such webhook" },
          "410": { description: "channel archived" },
        },
      },
    },
    "/api/channels/{slug}/ws": {
      get: {
        summary: "websocket upgrade (JSON frames)",
        security: [{ bearer: [] }],
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          {
            name: "Sec-WebSocket-Protocol",
            in: "header",
            schema: { type: "string" },
            description: "browser personal token as second protocol value: agentparty, <token>",
          },
          {
            name: "t",
            in: "query",
            schema: { type: "string" },
            description: "share-link token for readonly browser links; write-capable query tokens are rejected",
          },
        ],
        responses: { "101": { description: "switching protocols" } },
      },
    },
  },
} as const;
