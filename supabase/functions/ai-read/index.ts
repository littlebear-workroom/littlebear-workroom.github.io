// Read photos / scanned PDFs with Claude and return structured data for the upload screens.
// Only signed-in teachers can call it, with a daily cap per teacher to keep costs predictable.
import Anthropic from "npm:@anthropic-ai/sdk@0.133.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const DAILY_LIMIT = 40;

const str = { type: "string" };
const obj = (props: Record<string, unknown>) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
const arr = (items: unknown) => ({ type: "array", items });
const slot = obj({ start: { ...str, description: "HH:MM 24-hour" }, end: { ...str, description: "HH:MM 24-hour, empty if not shown" }, name: str });

const KINDS: Record<string, { schema: unknown; task: (ctx: any) => string }> = {
  routine: {
    schema: obj({
      slots: arr(slot),
      byWeekday: arr(obj({ weekday: { type: "integer", description: "1=Mon … 5=Fri" }, slots: arr(slot) })),
    }),
    task: () =>
      "這是幼兒園班級的「作息表」。請逐列讀出每個時段的開始時間、結束時間和活動名稱（名稱照原文完整抄寫，包含括號內容；跨兩行的名稱要合併）。" +
      "如果表格是週一到週五分開不同欄位，請填 byWeekday（每一天各自的時段），slots 留空陣列；如果每天都一樣，只填 slots，byWeekday 留空陣列。時間一律用 24 小時制 HH:MM。",
  },
  roster: {
    schema: obj({
      weekStart: { ...str, description: "M/D of the week's first day, or empty" },
      weekEnd: { ...str, description: "M/D of the week's last day, or empty" },
      rows: arr(obj({
        period: { type: "string", enum: ["上午值班", "下午值班"] },
        duty: { ...str, description: "負責區域/職務 exactly as written" },
        start: { ...str, description: "HH:MM from the 值班區間 column, empty if none" },
        end: { ...str, description: "HH:MM, empty if none" },
        assignees: arr({ ...str, description: "one class code or name per item, e.g. 核桃B" }),
      })),
    }),
    task: (ctx) =>
      "這是幼兒園的「全園值班班表」。每一列有：時段（上午/下午值班）、負責區域（職務名稱）、值班區間（時間）、值班人員。請逐列完整讀出，職務名稱照原文抄寫（包含括號），時間用值班區間欄的時間。" +
      "值班人員通常寫成「班別代碼」，例如「核桃B」「松果A」「行政C」；同一格有兩個人時要拆成兩個。" +
      (ctx.codes?.length ? `這個園所已知的班別代碼有：${ctx.codes.join("、")}。如果圖片上的字是其中某個代碼（即使字有點模糊），請直接用已知代碼；真的對不上才照原文抄寫。` : "") +
      "沒有排人的格子 assignees 給空陣列。表頭如果有日期範圍（例如 10/19-10/23），填到 weekStart/weekEnd。",
  },
  calendar: {
    schema: obj({
      events: arr(obj({
        date: { ...str, description: "YYYY-MM-DD, zero-padded, e.g. 2026-09-07" },
        end: { ...str, description: "YYYY-MM-DD for multi-day items, else empty" },
        time: { ...str, description: "HH:MM or HH:MM–HH:MM, else empty" },
        title: str,
        people: { ...str, description: "負責人 / 負責班級 as written, else empty" },
        mine: { type: "boolean", description: "true if this item is assigned to the teacher described in the instructions" },
      })),
    }),
    task: (ctx) =>
      `這是幼兒園的行事曆或工作分配表。今天是 ${ctx.today}。` +
      (ctx.roc ? `檔案是民國 ${ctx.roc} 學年度：8～12 月是西元 ${ctx.roc + 1911} 年，1～7 月是西元 ${ctx.roc + 1912} 年。` : "沒寫年份的日期，請用離今天最近的年份。") +
      "請列出每一個有日期的行程或工作：日期、（多天的話）結束日期、時間、內容、負責人。表格裡負責人常常寫在日期和內容的下一列或旁邊的格子，請依照表格位置對應到正確的項目。" +
      "只寫月份沒有日期的工作，日期填那個月的 1 號，並在內容最後加上「（只寫月份）」。" +
      (ctx.me?.length ? `使用這個工具的老師是：${ctx.me.join("、")}（本名、暱稱或班級）。負責人或內容裡出現其中任何一個，mine 就填 true，否則 false。` : "mine 一律填 false。"),
  },
  motor: {
    schema: obj({
      weeks: arr(obj({
        range: { ...str, description: "date range like 10/5~10/9" },
        weekLabel: { ...str, description: "e.g. 第八週" },
        name: { ...str, description: "活動名稱/器材 as written, e.g. 小小滾球員/大籠球" },
        indicator: { ...str, description: "學習指標 as written" },
        activities: arr(obj({ no: { type: "integer" }, title: str, desc: str })),
      })),
    }),
    task: () =>
      "這是幼兒園的「大肌肉活動課程規畫表」。每一週有：週次/日期、活動名稱/器材、學習指標，以及課程內容裡編號 1、2、3… 的活動（每個活動有標題和說明）。請逐週完整讀出，文字照原文抄寫，沒填的活動不要列出。",
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json({ error: "請先用 LINE 登入" }, 401);
    const body = await req.json();
    const kind = KINDS[body.kind];
    if (!kind) return json({ error: "unknown kind" }, 400);
    const images: { media_type: string; data: string }[] = (body.images || []).slice(0, 4);
    if (!images.length) return json({ error: "沒有收到圖片" }, 400);
    if (!Deno.env.get("ANTHROPIC_API_KEY")) return json({ error: "AI 讀圖還沒設定好", fallback: true }, 503);

    // daily cap per teacher
    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const { data: use } = await admin.from("ai_usage").select("count").eq("user_id", u.user.id).eq("day", day).maybeSingle();
    if ((use?.count || 0) >= DAILY_LIMIT) return json({ error: `今天已經用 AI 讀了 ${DAILY_LIMIT} 次，明天再試，或改用手動輸入`, fallback: true }, 429);
    await admin.from("ai_usage").upsert({ user_id: u.user.id, day, count: (use?.count || 0) + 1 });

    const client = new Anthropic();
    const content: any[] = images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }));
    content.push({ type: "text", text: kind.task(body.context || {}) + "\n只根據圖片上真的看得到的內容回答，看不清楚的字照你最有把握的讀法填寫，不要自己編造沒有的項目。" });

    let response: any;
    try {
      response = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        output_config: { effort: "medium", format: { type: "json_schema", schema: kind.schema } },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content }],
      } as any);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return json({ error: "AI 金鑰無效，請通知管理者", fallback: true }, 502);
      if (e instanceof Anthropic.RateLimitError) return json({ error: "AI 暫時太忙，請稍後再試", fallback: true }, 429);
      if (e instanceof Anthropic.BadRequestError) return json({ error: "AI 無法讀取這個檔案：" + e.message, fallback: true }, 400);
      if (e instanceof Anthropic.APIError) return json({ error: `AI 服務錯誤（${e.status}），請稍後再試`, fallback: true }, 502);
      throw e;
    }
    if (response.stop_reason === "refusal") return json({ error: "AI 沒有辦法處理這張圖片，請改用手動輸入", fallback: true }, 422);
    if (response.stop_reason === "max_tokens") return json({ error: "內容太多，請分成幾張照片上傳", fallback: true }, 422);
    const text = (response.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    let data: unknown;
    try { data = JSON.parse(text); } catch { return json({ error: "AI 回傳的格式不正確，請再試一次", fallback: true }, 502); }
    const d: any = data;
    console.log(JSON.stringify({ kind: body.kind, images: images.length, in: response.usage?.input_tokens, out: response.usage?.output_tokens, items: (d.events || d.rows || d.slots || d.weeks || []).length, sample: JSON.stringify(d).slice(0, 300) }));
    return json({ ok: true, data, usage: { input: response.usage?.input_tokens, output: response.usage?.output_tokens } });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e), fallback: true }, 500);
  }
});
