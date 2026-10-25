// A teacher deletes their own account and data.
// Classes they own: handed to another active teacher in the class, or deleted when they are the only one.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json({ error: "請先登入" }, 401);
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== "刪除") return json({ error: "請輸入「刪除」確認" }, 400);
    const id = u.user.id;
    const { data: mine } = await admin.from("workspace_members").select("workspace_id, role").eq("user_id", id);
    let handed = 0, removed = 0;
    for (const m of mine || []) {
      if (m.role !== "owner") continue;
      const { data: others } = await admin.from("workspace_members").select("user_id, joined_at").eq("workspace_id", m.workspace_id).eq("status", "active").neq("user_id", id).order("joined_at");
      if (others && others.length) { await admin.from("workspace_members").update({ role: "owner" }).eq("workspace_id", m.workspace_id).eq("user_id", others[0].user_id); handed++; }
      else { await admin.from("workspaces").delete().eq("id", m.workspace_id); await admin.from("subscriptions").delete().eq("subject_type", "workspace").eq("subject_id", m.workspace_id); removed++; }
    }
    await admin.from("workspace_members").delete().eq("user_id", id);
    await admin.from("personal_data").delete().eq("user_id", id);
    await admin.from("push_subs").delete().eq("user_id", id);
    await admin.from("subscriptions").delete().eq("subject_type", "user").eq("subject_id", id);
    await admin.from("admins").delete().eq("user_id", id);
    await admin.from("profiles").delete().eq("id", id);
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw error;
    console.log("account deleted", JSON.stringify({ handed, removed }));
    return json({ ok: true, handed, removed });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
