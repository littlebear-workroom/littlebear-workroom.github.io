// Phone notifications for the home-screen app (Web Push).
// The database calls this when a class's shared data changes; we tell the other teachers in that class.
// A signed-in teacher can also call it with mode "test" to get one notification right away.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
webpush.setVapidDetails("mailto:noreply@littlebear-workroom.app", Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);

const QUIET_MINUTES = 10; // one notification per class + item within this window
const LABELS: Record<string, [string, string]> = {
  bear_roster_rows: ["全園班表", "roster"],
  bear_sub_records: ["代班紀錄", "roster"],
  bear_routine: ["班級作息表", "routine"],
  bear_student_records: ["學生名冊", "students"],
  bear_forms: ["回條小幫手", "forms"],
  bear_fund_records: ["班費紀錄", "funds"],
  bear_fund_types: ["班級資金分類", "funds"],
  bear_teacher_map: ["老師名單", "roster"],
  bear_motor_days: ["大肌肉活動", "motor"],
  bear_motor_plans: ["大肌肉活動", "motor"],
  bear_lessons: ["教案花園", "lessons"],
  bear_lesson_themes: ["教案主題", "lessons"],
};

async function sendTo(userIds: string[], payload: Record<string, unknown>) {
  if (!userIds.length) return 0;
  const { data: subs } = await admin.from("push_subs").select("endpoint, sub").in("user_id", userIds);
  let sent = 0;
  await Promise.all((subs || []).map(async (s: any) => {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 86400 }); sent++; }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint); else console.log("push error", e?.statusCode, e?.body || e?.message); }
  }));
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.mode === "test") {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = await admin.auth.getUser(jwt);
      if (!u?.user) return json({ error: "請先登入" }, 401);
      const n = await sendTo([u.user.id], { title: "小熊工作室", body: "手機通知開好了！班級有新資料時會通知你 ♡", view: "home" });
      return n ? json({ ok: true, sent: n }) : json({ error: "這支手機還沒開啟通知" }, 400);
    }
    if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return json({ error: "forbidden" }, 403);
    const { ws, key, by } = body;
    let label = LABELS[key], logKey = key;
    if (!ws || !label) return json({ ok: true, skipped: "not notified" });
    // 寶貝補給品 lives inside the student list: tell the two apart by what changed.
    if (key === "bear_student_records" && Array.isArray(body.old) && Array.isArray(body.new)) {
      const strip = (list: any[]) => JSON.stringify(list.map((r) => Object.fromEntries(Object.entries(r || {}).filter(([k]) => !/suppl|diaper/i.test(k)))));
      if (strip(body.old) === strip(body.new)) {
        if (JSON.stringify(body.old) === JSON.stringify(body.new)) return json({ ok: true, skipped: "no change" });
        label = ["寶貝補給品", "supplies"]; logKey = key + "#supplies";
      }
    }
    const { data: last } = await admin.from("push_log").select("sent_at").eq("workspace_id", ws).eq("key", logKey).maybeSingle();
    if (last && Date.now() - new Date(last.sent_at).getTime() < QUIET_MINUTES * 60e3) return json({ ok: true, skipped: "quiet" });
    await admin.from("push_log").upsert({ workspace_id: ws, key: logKey, sent_at: new Date().toISOString() });
    const [{ data: members }, { data: w }, { data: who }] = await Promise.all([
      admin.from("workspace_members").select("user_id").eq("workspace_id", ws),
      admin.from("workspaces").select("name").eq("id", ws).maybeSingle(),
      by ? admin.from("profiles").select("display_name").eq("id", by).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const to = (members || []).map((m: any) => m.user_id).filter((id: string) => id !== by);
    const name = (who as any)?.display_name || "同班老師";
    const sent = await sendTo(to, { title: `${w?.name || "班級"}有新資料`, body: `${name} 更新了「${label[0]}」，點開看看`, view: label[1], tag: `${ws}:${logKey}` });
    return json({ ok: true, sent });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
