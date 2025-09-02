// server.js (ESM)
// GlicoCerto API – Rotas:
// /api/env, /api/paciente/:userId (GET), /api/paciente (POST)
// /api/ns/latest/:userId (GET)
// /api/chat (POST), /api/chat-image (POST)
// /api/refeicoes (GET), /api/refeicoes/serie (GET), /api/refeicoes/:id (DELETE)
// Fallback SPA para ./public/index.html

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import crypto from "crypto";

dotenv.config();

// __dirname (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Avisos de env
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.warn("⚠️  SUPABASE_URL/SUPABASE_ANON_KEY ausentes no .env");
}
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY ausente — usando fallback simples para análise.");
}

// App
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public"))); // sirva ./public

// SDKs
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Supabase client com JWT do request (RLS)
function supabaseFromReq(req) {
  const token = req.headers?.authorization?.split(" ")[1] || null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Utils
const r0 = (n) => Math.round(Number(n || 0));
const sha1Hex = (s) => crypto.createHash("sha1").update(String(s), "utf8").digest("hex");
const stripFences = (s) => String(s || "").replace(/```html|```/g, "").trim();

// Extrai JSON do <pre>…</pre> (carbo_g, pg_cho_equiv_g, refeicao_resumo)
function pickFromPre(html) {
  let carbo_g = 0, pg_cho_equiv_g = 0, resumo = "";
  try {
    const m = String(html || "").match(/<pre[^>]*>\s*({[\s\S]*?})\s*<\/pre>/i);
    if (m) {
      const obj = JSON.parse(m[1]);
      carbo_g = Number(obj.carbo_g || 0);
      pg_cho_equiv_g = Number(obj.pg_cho_equiv_g || 0);
      resumo = String(obj.refeicao_resumo || obj.resumo_refeicao || obj.resumo || "").trim();
    }
  } catch {}
  return { carbo_g, pg_cho_equiv_g, resumo };
}

// Prompt único para texto e imagem – exige tabela HTML (.gc-table) e JSON final em <pre>
function systemPrompt(cfg) {
  const ins = (cfg?.insulina_rapida || "Fiasp").trim();
  const icr = Number(cfg?.icr || cfg?.insulina_cho || 10);
  const isf = Number(cfg?.isf || cfg?.glicose_insulina || 50);
  const target = Number(cfg?.target || 100);
  const pct = Number(cfg?.pct_cal_pf ?? 100);
  const strat = cfg?.pg_strategy || "regular_now";

  return `
Você é um assistente de dose de insulina para DM1 (SBD).
Parâmetros: ICR=${icr} g/U, ISF=${isf} mg/dL/U, Alvo=${target} mg/dL,
Insulina rápida=${ins}, %cal P+G=${pct}%, Estratégia=${strat}.

INSTRUÇÕES DE SAÍDA (obrigatórias):
1) Produza uma TABELA HTML com classe "gc-table" (colunas: Item | Porção | Carbo (g)):
   <table class="gc-table"><thead>…</thead><tbody>…</tbody></table>
2) Em seguida, traga um resumo curto (headings/parágrafos objetivos). Não use cercas de código.
3) No final, devolva um bloco <pre> contendo APENAS JSON:
   {"carbo_g": number, "pg_cho_equiv_g": number,
    "refeicao_resumo": "apenas 'quantidade + alimento', separados por vírgulas; ex: 1 coxinha de frango, 200 g batata frita, 1 coca lata zero"}
`.trim();
}

// Middleware de auth para /api/*
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  if (req.path === "/api/env") return next(); // público
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Não autenticado" });
  }
  next();
});

// ---------- /api/env ----------
app.get("/api/env", (_req, res) => {
  res.json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// ---------- PACIENTE ----------
app.get("/api/paciente/:userId", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId } = req.params;
    const { data, error } = await supabase
      .from("patient_settings")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    res.json({ ok: true, data: data || null });
  } catch (e) {
    console.error("[GET /api/paciente/:userId]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/paciente", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, settings } = req.body || {};
    if (!userId || !settings) {
      return res.status(400).json({ ok: false, error: "userId e settings são obrigatórios" });
    }
    const payload = { user_id: userId, ...settings, updated_at: new Date().toISOString() };
    const { error } = await supabase.from("patient_settings").upsert(payload, { onConflict: "user_id" });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/paciente]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- NIGHTSCOUT ----------
async function fetchNightscoutLatest(nsUrl, nsSecret) {
  const base = String(nsUrl || "").replace(/\/+$/, "");
  const url = `${base}/api/v1/entries.json?count=1`;
  // tentativa 1: plaintext (algumas instâncias aceitam)
  let resp = await fetch(url, { headers: nsSecret ? { "API-SECRET": nsSecret } : {} });
  // fallback: SHA-1 no header api-secret
  if (resp.status === 401 || resp.status === 403) {
    const headers = nsSecret ? { "api-secret": sha1Hex(nsSecret) } : {};
    resp = await fetch(url, { headers });
  }
  return resp;
}

app.get("/api/ns/latest/:userId", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId } = req.params;
    const { data: cfg, error } = await supabase
      .from("patient_settings")
      .select("nightscout_url, nightscout_api_secret")
      .eq("user_id", userId)
      .single();
    if (error && error.code !== "PGRST116") throw error;

    const nsUrl = cfg?.nightscout_url?.trim();
    const nsSecret = cfg?.nightscout_api_secret?.trim();
    if (!nsUrl) return res.json({ ok: false, error: "Nightscout não configurado" });

    const r = await fetchNightscoutLatest(nsUrl, nsSecret);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: `Nightscout HTTP ${r.status}` });
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return res.json({ ok: false, error: "Sem dados" });

    const e = arr[0];
    res.json({
      ok: true,
      data: {
        mgdl: Math.round(e.sgv ?? e.mgdl ?? e.glucose ?? 0),
        trend: e.direction ?? e.trend ?? null,
        date: new Date(e.dateString || e.date).toISOString(),
      },
    });
  } catch (e) {
    console.error("[GET /api/ns/latest]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Upload Storage (dataURL -> arquivo público) ----------
function dataUrlParse(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return {
    mime: m[1],
    buf: Buffer.from(m[2], "base64"),
    ext: (m[1].split("/")[1] || "jpg").split("+")[0],
  };
}
async function uploadMealPhoto(supabase, userId, dataUrl) {
  const p = dataUrlParse(dataUrl);
  if (!p) return null;
  const key = `refeicoes/${userId}/${Date.now()}.${p.ext}`;
  const up = await supabase.storage.from("refeicoes").upload(key, p.buf, {
    contentType: p.mime,
    upsert: true,
  });
  if (up.error) throw up.error;
  const pub = supabase.storage.from("refeicoes").getPublicUrl(key);
  return pub?.data?.publicUrl || null;
}

// ---------- CHAT (texto) ----------
app.post("/api/chat", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, message, glicemia, pg_strategy, tipo } = req.body || {};
    if (!userId || typeof glicemia !== "number") {
      return res.status(400).json({ ok: false, error: "Parâmetros inválidos." });
    }

    const { data: cfgRaw } = await supabase.from("patient_settings").select("*").eq("user_id", userId).single();
    const cfg = { ...cfgRaw, pg_strategy: pg_strategy || cfgRaw?.pg_strategy || "regular_now" };

    let detalhes_html = "";
    let carbo_g = 0, pg_cho_equiv_g = 0, refeicao_resumo = String(message || "").trim();

    if (openai) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.1,
        messages: [
          { role: "system", content: systemPrompt(cfg) },
          { role: "user", content: `Refeição textual: ${refeicao_resumo}\nGlicemia: ${glicemia} mg/dL\nTipo: ${tipo || "outro"}` },
        ],
      });
      const raw = completion.choices?.[0]?.message?.content || "";
      detalhes_html = stripFences(raw);
      const parsed = pickFromPre(raw);
      carbo_g = parsed.carbo_g;
      pg_cho_equiv_g = parsed.pg_cho_equiv_g;
      if (parsed.resumo) refeicao_resumo = parsed.resumo;
    } else {
      detalhes_html = "<em>Análise automática indisponível.</em>";
    }

    const icr = Number(cfg?.icr || cfg?.insulina_cho || 10);
    const isf = Number(cfg?.isf || cfg?.glicose_insulina || 50);
    const target = Number(cfg?.target || 100);
    const strat = cfg?.pg_strategy || "regular_now";

    const doseCho = carbo_g / icr;
    const doseCor = Math.max(0, (Number(glicemia) - target) / isf);
    const dosePg  = strat === "regular_now" ? pg_cho_equiv_g / icr : 0;

    const insertPayload = {
      user_id: userId,
      data_hora: new Date().toISOString(),
      tipo: tipo || "outro",
      descricao: refeicao_resumo || String(message || "").trim(),
      glicemia: Number(glicemia),
      cho_total_g: Number(carbo_g),
      pg_cho_equiv_g: Number(pg_cho_equiv_g),
      dose_rapida_total: r0(doseCho + doseCor),
      dose_regular_pg: r0(dosePg),
      descricao_model: detalhes_html, // pode não existir (fallback abaixo)
    };

    let { error: e1 } = await supabase.from("refeicoes").insert(insertPayload);
    if (e1) {
      const basic = { ...insertPayload };
      delete basic.descricao_model;
      const retry = await supabase.from("refeicoes").insert(basic);
      if (retry.error) throw e1;
    }

    res.json({
      ok: true,
      input: { descricao: insertPayload.descricao, glicemia: Number(glicemia) },
      config: {
        insulina_rapida: cfg?.insulina_rapida || "Fiasp",
        insulina_cho: icr,
        glicose_insulina: isf,
        target,
        pg_strategy: strat,
      },
      totais: { carbo_g, pg_cho_equiv_g },
      detalhes_html,
    });
  } catch (e) {
    console.error("[POST /api/chat]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- CHAT (imagem) ----------
app.post("/api/chat-image", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, glicemia, tipo, pg_strategy, image_data_url, message } = req.body || {};
    if (!userId || typeof glicemia !== "number" || !image_data_url) {
      return res.status(400).json({ ok: false, error: "Parâmetros inválidos." });
    }

    const { data: cfgRaw } = await supabase.from("patient_settings").select("*").eq("user_id", userId).single();
    const cfg = { ...cfgRaw, pg_strategy: pg_strategy || cfgRaw?.pg_strategy || "regular_now" };

    let detalhes_html = "";
    let carbo_g = 0, pg_cho_equiv_g = 0, refeicao_resumo = "[foto]";

    if (openai) {
      const userText =
        `Foto da refeição. Glicemia: ${glicemia} mg/dL. Tipo: ${tipo || "outro"}. ` +
        (message ? `Observações: ${message}` : "");

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.1,
        messages: [
          { role: "system", content: systemPrompt(cfg) },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: { url: image_data_url } },
            ],
          },
        ],
      });

      const raw = completion.choices?.[0]?.message?.content || "";
      detalhes_html = stripFences(raw);
      const parsed = pickFromPre(raw);
      carbo_g = parsed.carbo_g;
      pg_cho_equiv_g = parsed.pg_cho_equiv_g;
      if (parsed.resumo) refeicao_resumo = parsed.resumo;
    } else {
      detalhes_html = "<em>Análise automática indisponível.</em>";
      refeicao_resumo = String(message || "[foto]").trim();
    }

    // Upload foto para Storage
    let foto_url = null;
    try {
      foto_url = await uploadMealPhoto(supabase, userId, image_data_url);
    } catch (e) {
      console.warn("upload foto falhou:", e.message);
    }

    const icr = Number(cfg?.icr || cfg?.insulina_cho || 10);
    const isf = Number(cfg?.isf || cfg?.glicose_insulina || 50);
    const target = Number(cfg?.target || 100);
    const strat = cfg?.pg_strategy || "regular_now";

    const doseCho = carbo_g / icr;
    const doseCor = Math.max(0, (Number(glicemia) - target) / isf);
    const dosePg  = strat === "regular_now" ? pg_cho_equiv_g / icr : 0;

    const insertPayload = {
      user_id: userId,
      data_hora: new Date().toISOString(),
      tipo: tipo || "outro",
      descricao: refeicao_resumo || String(message || "").trim() || "[foto]",
      glicemia: Number(glicemia),
      cho_total_g: Number(carbo_g),
      pg_cho_equiv_g: Number(pg_cho_equiv_g),
      dose_rapida_total: r0(doseCho + doseCor),
      dose_regular_pg: r0(dosePg),
      foto_url: foto_url || null,
      descricao_model: detalhes_html,
    };

    let { error: e1 } = await supabase.from("refeicoes").insert(insertPayload);
    if (e1) {
      const basic = { ...insertPayload };
      delete basic.foto_url;
      delete basic.descricao_model;
      const retry = await supabase.from("refeicoes").insert(basic);
      if (retry.error) throw e1;
    }

    res.json({
      ok: true,
      input: { descricao: insertPayload.descricao, glicemia: Number(glicemia) },
      config: {
        insulina_rapida: cfg?.insulina_rapida || "Fiasp",
        insulina_cho: icr,
        glicose_insulina: isf,
        target,
        pg_strategy: strat,
      },
      totais: { carbo_g, pg_cho_equiv_g },
      detalhes_html,
      foto_url: foto_url || undefined,
    });
  } catch (e) {
    console.error("[POST /api/chat-image]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- HISTÓRICO (lista) ----------
app.get("/api/refeicoes", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, start, end, tipo } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: "userId é obrigatório" });

    let q = supabase.from("refeicoes").select("*").eq("user_id", userId);
    if (start) q = q.gte("data_hora", start);
    if (end) q = q.lte("data_hora", end);
    if (tipo && tipo !== "todos") q = q.eq("tipo", tipo);
    q = q.order("data_hora", { ascending: false });

    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, data: data || [] });
  } catch (e) {
    console.error("[GET /api/refeicoes]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- HISTÓRICO (série para gráficos, opcional) ----------
function toLocalYMD(iso, tz = "America/Sao_Paulo") {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
app.get("/api/refeicoes/serie", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, start, end, tipo, tz = "America/Sao_Paulo" } = req.query;
    if (!userId) return res.status(400).json({ ok: false, error: "userId é obrigatório" });

    let q = supabase.from("refeicoes").select("*").eq("user_id", userId);
    if (start) q = q.gte("data_hora", start);
    if (end) q = q.lte("data_hora", end);
    if (tipo && tipo !== "todos") q = q.eq("tipo", tipo);
    q = q.order("data_hora", { ascending: true });

    const { data, error } = await q;
    if (error) throw error;

    const buckets = new Map();
    for (const r of data || []) {
      const day = toLocalYMD(r.data_hora, tz);
      if (!buckets.has(day)) buckets.set(day, { glyVals: [], cho: 0, ins: 0 });
      const b = buckets.get(day);
      if (r.glicemia != null && r.glicemia !== "") b.glyVals.push(Number(r.glicemia));
      b.cho += Number(r.cho_total_g || 0);
      b.ins += Number(r.dose_rapida_total || 0) + Number(r.dose_regular_pg || 0);
    }

    const days = Array.from(buckets.keys()).sort();
    const gly = [], cho = [], ins = [];
    for (const day of days) {
      const b = buckets.get(day);
      const mean = b.glyVals.length ? b.glyVals.reduce((a, v) => a + v, 0) / b.glyVals.length : 0;
      gly.push({ x: day, y: mean });
      cho.push({ x: day, y: b.cho });
      ins.push({ x: day, y: b.ins });
    }
    res.json({ ok: true, series: { gly, cho, ins } });
  } catch (e) {
    console.error("[GET /api/refeicoes/serie]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- HISTÓRICO (delete) ----------
app.delete("/api/refeicoes/:id", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { id } = req.params;
    const { userId } = req.query;
    if (!id || !userId) {
      return res.status(400).json({ ok: false, error: "id e userId são obrigatórios" });
    }

    const { data: row, error: eSel } = await supabase
      .from("refeicoes")
      .select("id,user_id")
      .eq("id", id)
      .single();
    if (eSel && eSel.code !== "PGRST116") throw eSel;
    if (!row) return res.status(404).json({ ok: false, error: "Registro não encontrado." });
    if ((row.user_id || "").trim() !== (userId || "").trim()) {
      return res.status(403).json({ ok: false, error: "Sem permissão." });
    }

    const { error: eDel } = await supabase.from("refeicoes").delete().eq("id", id);
    if (eDel) throw eDel;
    res.json({ ok: true, deleted: id });
  } catch (e) {
    console.error("[DELETE /api/refeicoes/:id]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- SPA fallback ----------
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api/")) return next();
  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ GlicoCerto API rodando em http://localhost:${PORT}`);
});
