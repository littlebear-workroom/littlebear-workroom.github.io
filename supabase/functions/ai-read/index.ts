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
const DAILY_LIMIT = 80;

const str = { type: "string" };
const obj = (props: Record<string, unknown>) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
const arr = (items: unknown) => ({ type: "array", items });
const slot = obj({ start: { ...str, description: "HH:MM 24-hour" }, end: { ...str, description: "HH:MM 24-hour, empty if not shown" }, name: str });

const KINDS: Record<string, { schema: unknown; task: (ctx: any) => string; textOnly?: boolean; effort?: string }> = {
  bus: {
    textOnly: true,
    effort: "medium",
    schema: obj({
      riders: arr(obj({
        route: { ...str, description: "車次 as written, e.g. A車 / 1號車 / 南線; empty if the list has only one bus and no name" },
        session: { type: "string", enum: ["am", "pm", "both"], description: "上午(上學/去程)=am, 下午(放學/回程)=pm, both if the row is for both or not stated" },
        order: { type: "integer", description: "搭車順序 number as written; 0 if not shown" },
        name: str,
        className: { ...str, description: "班級 as written, else empty" },
        address: { ...str, description: "住址/上下車地點 as written, else empty" },
        eta: { ...str, description: "預計時間 HH:MM 24-hour, else empty" },
        contacts: arr(obj({ name: str, relation: { ...str, description: "e.g. 媽媽, 爸爸, 阿嬤; empty if unknown" }, phone: str })),
        noRide: arr(obj({ weekday: { type: "integer", description: "1=Mon … 5=Fri" }, session: { type: "string", enum: ["am", "pm"] } })),
        note: { ...str, description: "other remarks for this child, else empty" },
      })),
    }),
    task: (ctx) =>
      "這是幼兒園的「娃娃車（幼童專用車）搭車名單」。請逐一列出每一位搭車的幼兒：車次、上午或下午、搭車順序、姓名、班級、住址（或上下車地點）、預計到達時間、緊急聯絡人（姓名、關係、電話；有幾位就列幾位）。" +
      "如果名單分成上午（上學）和下午（放學）兩張表，同一位幼兒在兩張表各列一筆，session 分別填 am 和 pm；如果沒有區分上下午，session 填 both。" +
      "備註裡如果寫到固定某天不搭車（例如「週三下午不搭」「每週五自行接送」），填到 noRide（週五自行接送＝週五 pm；沒寫上下午就上午、下午都填）。其他說明放 note。" +
      (ctx.routes?.length ? `園所目前已有的車次：${ctx.routes.join("、")}。如果名單上的車次就是其中之一，請用一樣的寫法。` : "") +
      (ctx.text ? `\n\n以下是檔案裡的文字內容（表格的每一列用 | 分隔）：\n${String(ctx.text).slice(0, 30000)}` : ""),
  },
  lessonChat: {
    textOnly: true,
    effort: "medium",
    schema: obj({
      reply: { ...str, description: "a short, warm reply to the teacher in Traditional Chinese (1-3 sentences): what you filled or changed, or one question if something essential is missing" },
      lesson: obj({
        title: str,
        theme: { ...str, description: "one of the class's theme names, or empty" },
        age: { type: "string", enum: ["幼幼班", "小班", "中班", "大班"] },
        teachGoals: { ...str, description: "教學目標, numbered lines 1. 2. 3." },
        behaviorGoals: { ...str, description: "行為目標: observable child behaviours, numbered lines, each starting with 幼兒能…" },
        indicators: arr({ ...str, description: "learning indicator code copied exactly from the list" }),
        courseGoals: { ...str, description: "課程目標: one numbered line per chosen indicator, same order, each ending with the code in full-width brackets, e.g. 1. 透過觀察南瓜，認識南瓜的外形特徵（認-幼-1-2-1）" },
        steps: { ...str, description: "活動內容與流程: 引起動機 / 發展活動 / 綜合活動 sections with minutes, numbered steps, short teacher prompts in 「」" },
        materials: { ...str, description: "需準備材料, one item per line with quantity" },
      }),
    }),
    task: (ctx) => {
      const l = ctx.lesson || {}, list = (ctx.candidates || []).slice(0, 200).map((c: string[]) => `${c[0]} ${c[1]}`).join("\n");
      const talk = (ctx.messages || []).slice(-14).map((m: any) => `${m.role === "ai" ? "AI" : "老師"}：${String(m.text || "").slice(0, 1500)}`).join("\n");
      return `你是臺灣幼兒園的資深教保老師，熟悉《幼兒園教保活動課程大綱》，正在幫同事一起寫教案。請依照老師的想法，完成或修改整份教案，用臺灣幼教常用的寫法、繁體中文。\n` +
        `規則：\n1. 老師說要改哪裡就改哪裡，其他欄位保留目前的內容（目前內容是空的就幫忙補上）。\n2. 學習指標選 3～6 條，只能用下面清單裡的代碼，代碼要完全照抄；要和活動內容真的對得上。\n` +
        `3. 教學目標寫老師要引導的方向；行為目標寫看得到的幼兒行為（例如「幼兒能說出…」）。\n` +
        `3-1. 課程目標：每一條學習指標各寫一條，說明「透過這個活動的什麼內容，希望幼兒學到什麼」，要把指標落實到這堂課的具體東西。例如指標是「認-幼-1-2-1 觀察動植物的特徵」、活動在看南瓜，就寫「1. 透過觀察南瓜，認識南瓜的外形、顏色等特徵（認-幼-1-2-1）」。順序和 indicators 一致，每條最後用全形括號寫指標代碼。學習指標有改，課程目標就要跟著改。\n4. 活動流程分成「引起動機、發展活動、綜合活動」，寫出每段時間（分鐘）和簡短的引導語，總時間符合老師說的或適合該年齡。\n` +
        `5. 主題分類從這些裡面選一個最接近的：${(ctx.themes || []).join("、") || "（沒有）"}；都不適合就留空。\n6. 適用班級沒被老師要求更改就維持「${l.age || "小班"}」。\n7. reply 簡短說明你做了什麼；如果老師的想法太少、真的無法寫，就先在 reply 問一個問題，但仍盡量填出草稿。\n\n` +
        `【目前的教案內容】\n${JSON.stringify(l, null, 1)}\n\n【可選的學習指標（${l.age || ""}）】\n${list}\n\n【對話】\n${talk}`;
    },
  },
  lesson: {
    textOnly: true,
    effort: "low",
    schema: obj({ suggestions: arr(obj({ code: { ...str, description: "indicator code copied exactly from the list" }, reason: { ...str, description: "why it fits, under 25 Chinese characters" } })) }),
    task: (ctx) => {
      const l = ctx.lesson || {}, list = (ctx.candidates || []).slice(0, 200).map((c: string[]) => `${c[0]} ${c[1]}`).join("\n");
      return `你是熟悉《幼兒園教保活動課程大綱》的幼教老師。請根據下面這份教案，從「可選的學習指標」中挑出 3～8 條最適合的，依適合程度排序。只能使用清單裡的代碼，代碼要完全照抄。理由用一句話說明這個活動的哪個部分對應到這條指標（25 字以內）。\n\n` +
        `【教案】\n活動名稱：${l.title || ""}\n主題：${l.theme || ""}\n適用班級：${l.age || ""}\n學習目標：${l.goal || ""}\n材料與活動流程：${l.steps || ""}\n\n【可選的學習指標（${l.age || ""}）】\n${list}`;
    },
  },
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
    if (!images.length && !kind.textOnly) return json({ error: "沒有收到圖片" }, 400);
    if (!Deno.env.get("ANTHROPIC_API_KEY")) return json({ error: "AI 讀圖還沒設定好", fallback: true }, 503);

    // daily cap per teacher
    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const { data: use } = await admin.from("ai_usage").select("count").eq("user_id", u.user.id).eq("day", day).maybeSingle();
    if ((use?.count || 0) >= DAILY_LIMIT) return json({ error: `今天已經用 AI 讀了 ${DAILY_LIMIT} 次，明天再試，或改用手動輸入`, fallback: true }, 429);
    await admin.from("ai_usage").upsert({ user_id: u.user.id, day, count: (use?.count || 0) + 1 });

    const client = new Anthropic();
    const content: any[] = images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }));
    content.push({ type: "text", text: kind.task(body.context || {}) + (kind.textOnly ? "" : "\n只根據圖片上真的看得到的內容回答，看不清楚的字照你最有把握的讀法填寫，不要自己編造沒有的項目。") });

    let response: any;
    try {
      response = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        output_config: { effort: kind.effort || "medium", format: { type: "json_schema", schema: kind.schema } },
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
    console.log(JSON.stringify({ kind: body.kind, images: images.length, in: response.usage?.input_tokens, out: response.usage?.output_tokens, items: (d.events || d.rows || d.slots || d.weeks || d.suggestions || []).length, sample: JSON.stringify(d).slice(0, 300) }));
    return json({ ok: true, data, usage: { input: response.usage?.input_tokens, output: response.usage?.output_tokens } });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e), fallback: true }, 500);
  }
});
