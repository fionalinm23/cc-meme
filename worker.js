// ==============================
// Meme MCP Server - Cloudflare Worker
// 小梦的表情包MCP服务器（完全体盲盒版）
// ==============================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, mcp-session-id",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

// 图片 fetch 结果缓存时长（秒）。同一张图片在这段时间内不会重复回源拉取。
const IMAGE_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 小时

// 兜底标签：找不到对应tag时使用
const FALLBACK_TAG = "在干嘛";

// 表情包工具的静态描述（当 KV 不可用时的兜底文案）
const STATIC_TAGS_HINT =
  "贴贴、哭哭、卖萌、开心、心虚、平静、严肃、宝宝、老婆、思考、累累、来了、亲亲、摸摸、害羞、震惊、叹气、困困、在干嘛";

// 根据 KV 里实际存在的 key 动态生成工具定义，保证标签列表和描述永远同步
async function buildTools(env) {
  let tagsHint = STATIC_TAGS_HINT;
  try {
    const list = await env.MEME_DB.list();
    const tags = list.keys.map((k) => k.name);
    if (tags.length > 0) tagsHint = tags.join("、");
  } catch (e) {
    // KV 列举失败时退回静态文案，不影响工具可用性
  }

  return [
    {
      name: "get_tagged_meme",
      description: `根据标签或情绪发送表情包。支持多图片随机盲盒！标签如：${tagsHint}`,
      inputSchema: {
        type: "object",
        properties: {
          tag: {
            type: "string",
            description: "表情包的标签种类，如'贴贴'、'哭哭'、'在干嘛'",
          },
        },
        required: ["tag"],
      },
    },
  ];
}

// 解析 KV 存的 value：可能是单个 URL 字符串，也可能是 JSON 数组（多图盲盒）
// 统一走 JSON.parse，不再靠"是不是以 [ 开头"这种脆弱的字符串猜测
function pickImageUrl(rawValue) {
  const trimmed = rawValue.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed[Math.floor(Math.random() * parsed.length)];
    }
  } catch (e) {
    // 不是合法 JSON，说明就是一个普通的 URL 字符串
  }
  return trimmed;
}

// 带缓存的图片拉取：优先读 Cloudflare 边缘缓存，未命中才回源
async function fetchImageCached(imageUrl) {
  const cache = caches.default;
  const cacheKey = new Request(imageUrl);

  let res = await cache.match(cacheKey);
  if (res) return res;

  res = await fetch(imageUrl);
  if (res.ok) {
    const cacheable = new Response(res.body, res);
    cacheable.headers.set("Cache-Control", `public, max-age=${IMAGE_CACHE_TTL_SECONDS}`);
    // 不阻塞主流程，缓存写入失败也不影响本次返回
    await cache.put(cacheKey, cacheable.clone());
    return cacheable;
  }
  return res;
}

// 处理单条 MCP JSON-RPC 消息
async function handleMessage(msg, env) {
  const { method, id, params } = msg;

  // 通知类消息没有 id，不需要回复
  if (id === undefined || id === null) return null;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "meme-mcp", version: "1.0.0" },
        },
      };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: await buildTools(env) } };

    case "tools/call": {
      const toolName = params?.name;
      if (toolName !== "get_tagged_meme") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        };
      }

      const tag = params?.arguments?.tag || "";

      // 1. 从 KV 数据库读取，找不到就用兜底标签的图
      let memeValue = await env.MEME_DB.get(tag);
      if (!memeValue) memeValue = await env.MEME_DB.get(FALLBACK_TAG);

      if (!memeValue) {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "这个标签还没有表情包哦~" }] },
        };
      }

      // 2. 盲盒逻辑：数组则随机抽一张，单个 URL 则直接用
      const imageUrl = pickImageUrl(memeValue);

      // 3. 拉图片（带缓存），转 base64
      let imgRes;
      try {
        imgRes = await fetchImageCached(imageUrl);
      } catch (e) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: "表情包图片加载失败了，网络好像抽风了~" }],
          },
        };
      }

      if (!imgRes.ok) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              { type: "text", text: `表情包图片暂时打不开（状态码 ${imgRes.status}），换个标签试试？` },
            ],
          },
        };
      }

      const buf = await imgRes.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "image",
              data: base64,
              mimeType: imgRes.headers.get("content-type") || "image/jpeg",
            },
          ],
        },
      };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ====== MCP 端点 (Streamable HTTP Transport) ======
    if (url.pathname === "/mcp") {
      // SSE 传输
      if (request.method === "GET") {
        const messageUrl = new URL("/mcp", url.origin).toString();

        const body = [
          `event: endpoint`,
          `data: ${messageUrl}`,
          ``,
          ``,
        ].join("\n");

        return new Response(body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            ...corsHeaders,
          },
        });
      }

      // POST：接收 JSON-RPC 消息
      if (request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            }
          );
        }

        // 支持批量消息
        if (Array.isArray(body)) {
          const responses = [];
          for (const msg of body) {
            const res = await handleMessage(msg, env);
            if (res) responses.push(res);
          }
          if (responses.length === 0) {
            return new Response("", { status: 202, headers: corsHeaders });
          }
          return new Response(JSON.stringify(responses), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        const response = await handleMessage(body, env);
        if (!response) {
          return new Response("", { status: 202, headers: corsHeaders });
        }

        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // DELETE：关闭会话
      if (request.method === "DELETE") {
        return new Response("", { status: 200, headers: corsHeaders });
      }
    }

    // ====== 原始 REST API（方便调试） ======
    if (url.pathname === "/get-meme") {
      const tag = url.searchParams.get("tag") || FALLBACK_TAG;
      const memeValue = await env.MEME_DB.get(tag);

      if (!memeValue) {
        return new Response(JSON.stringify({ error: "No meme found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const imageUrl = pickImageUrl(memeValue);

      const htmlContent = `
        <div style="display: flex; justify-content: center; align-items: center; padding: 10px;">
          <img src="${imageUrl}" alt="meme" style="max-width: 100%; max-height: 300px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);" />
        </div>
      `;

      return new Response(htmlContent, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ...corsHeaders,
        },
      });
    }

    // 根路径
    return new Response(
      JSON.stringify({ message: "Meme MCP Server is running!" }),
      {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  },
};
