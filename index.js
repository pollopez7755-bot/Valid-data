#!/usr/bin/env node
// Bot Validador DIGI v14 — Anti-Ban / 1500 scan + 1h rest / KeepAlive / LiveMessage
"use strict";

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const TelegramBot = require("node-telegram-bot-api");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// ── CONFIG ──
const TOKEN = "8710402523:AAHzR-ZQ8XR_qSJSOzJ6VPFIZYD1HnLoJtA";
const AUTH = "./auth_session";
const LISTS_DIR = "./listas";

// ── ANTI-BAN ──
const BATCH        = 8;
const DELAY_MIN    = 2500;
const DELAY_MAX    = 6000;
const MAX_ERR      = 10;
const QR_MS        = 60000;
const MAX_RECONN   = 5;
const REST_EVERY   = 100;
const REST_MS_MIN  = 90000;
const REST_MS_MAX  = 210000;
const ERR_PAUSE_MS = 45000;

// ── CICLO: 1500 escaneados → 1h descanso ──
const MAX_PER_CYCLE = 1500;
const CYCLE_REST_MS = 60 * 60 * 1000; // 1 hora exacta
const KEEPALIVE_DURING_REST_MS = 25000; // ping cada 25s durante descanso

// ── PREFIJOS DIGI ──
const PREFIJOS = ["34614", "34624", "34641", "34642", "34643"];

// ── ACCESO RESTRINGIDO ──
const ALLOWED_USERNAME = "K11000K";
const isAllowed = m => m?.from?.username === ALLOWED_USERNAME;

// ── ESTADO ──
const log = pino({ level: "silent" });
let sock = null, connected = false, connecting = false;
let qrTimer = null, qrMsgId = null, qrStart = null;
let qrN = 0, reconnN = 0, reconnTimer = null, connChat = null;

// ── LIVE MESSAGE GLOBAL ──
let liveMsgId = null;
let liveMsgChat = null;

const val = {
    on: false, stop: false,
    scanned: 0, valid: 0, skip: 0, err: 0, errRow: 0,
    start: null, chat: null, lastN: 0, lastErr: "", mode: "leads",
    batchCount: 0, cycleScanned: 0, cycleNum: 1,
    currentFile: null
};
const checked  = new Set();
const names    = new Map();
const waitName = new Map();
const usedNames = new Set();

if (!fs.existsSync(LISTS_DIR)) fs.mkdirSync(LISTS_DIR, { recursive: true });
try {
    const files = fs.readdirSync(LISTS_DIR);
    for (const f of files) {
        if (f.endsWith(".txt")) usedNames.add(f.replace(/\.txt$/, "").toLowerCase());
    }
} catch (_) {}

// ── TELEGRAM ──
const bot = new TelegramBot(TOKEN, { polling: true });
bot.on("polling_error", e => { if (e.code !== "ETELEGRAM" || !e.message?.includes("409")) console.error("[TG]", e.code || e.message); });
bot.on("error", e => console.error("[TG]", e.message));

// ── HELPERS BÁSICOS ──
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const timeout = (p, ms, fb = null) => { let t; return Promise.race([p, new Promise(r => { t = setTimeout(() => r(fb), ms); })]).finally(() => clearTimeout(t)); };
const fmtTime = ms => { if (!ms || ms < 0) return "—"; const s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor(s%3600/60); return h ? `${h}h ${m}m` : m ? `${m}m ${s%60}s` : `${s%60}s`; };
const randDelay = () => DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN));
const randRest  = () => REST_MS_MIN + Math.floor(Math.random() * (REST_MS_MAX - REST_MS_MIN));
const pct = (a, b) => b > 0 ? ((a / b) * 100).toFixed(1) : "0.0";

// ── LIVE SEND: siempre edita el mismo mensaje ──
async function live(chat, txt, ex = {}) {
    const rm = ex?.reply_markup;
    if (liveMsgId && liveMsgChat === chat) {
        const ok = await bot.editMessageText(txt, {
            chat_id: chat,
            message_id: liveMsgId,
            parse_mode: "Markdown",
            reply_markup: rm || undefined
        }).catch(() => null);
        if (ok) return ok;
    }
    const m = await bot.sendMessage(chat, txt, { parse_mode: "Markdown", ...ex }).catch(() => null);
    if (m) { liveMsgId = m.message_id; liveMsgChat = chat; }
    return m;
}

const send = (id, txt, ex = {}) => live(id, txt, ex);

// ── EDIT CAPTION (para foto QR) ──
function editCaption(chat, msg, txt, rm) {
    if (!chat || !msg) return Promise.resolve();
    return bot.editMessageCaption(txt, {
        chat_id: chat, message_id: msg,
        parse_mode: "Markdown", reply_markup: rm
    }).catch(() => live(chat, txt, rm ? { reply_markup: rm } : kb.main()));
}

// ── TECLADOS DINÁMICOS ──
const kb = {
    main: () => {
        const rows = [];
        if (!connected) rows.push([{ text: "📱 Conectar WhatsApp", callback_data: "new_session" }]);
        rows.push([{ text: "🚀 Iniciar validación", callback_data: "validate" }]);
        rows.push([{ text: "📊 Estado", callback_data: "status" }]);
        rows.push([{ text: "📂 Mis listas", callback_data: "my_lists" }]);
        if (connected) rows.push([{ text: "🔌 Desconectar", callback_data: "disconnect" }]);
        return { reply_markup: { inline_keyboard: rows } };
    },
    cancel: () => ({ inline_keyboard: [[{ text: "❌ Cancelar", callback_data: "cancel_qr" }]] }),
    mode: () => ({ reply_markup: { inline_keyboard: [
        [{ text: "👥 Leads", callback_data: "go_leads" }],
        [{ text: "⭐ Leads dedicado", callback_data: "go_dedicados" }],
        [{ text: "🔙 Menú", callback_data: "main" }],
    ]}}),
    running: () => ({ reply_markup: { inline_keyboard: [[{ text: "📊 Estado", callback_data: "status" }, { text: "⛔ Detener", callback_data: "stop" }]] }}),
    done: () => ({ reply_markup: { inline_keyboard: [
        [{ text: "🚀 Nueva validación", callback_data: "validate" }],
        [{ text: "📂 Mis listas", callback_data: "my_lists" }],
        [{ text: "🏠 Menú", callback_data: "main" }],
    ]}})
};

// ── GENERAR NÚMERO DIGI ──
function genNum() {
    const pfx = PREFIJOS[Math.floor(Math.random() * PREFIJOS.length)];
    const suf = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
    return pfx + suf;
}

// ── GUARDAR NÚMERO ──
function saveNum(num, name, mode) {
    if (!val.currentFile) return;
    try {
        if (mode === "dedicados" && name && name !== "Sin nombre") {
            fs.appendFileSync(val.currentFile, `+${num} | ${name}\n`, "utf-8");
        } else {
            fs.appendFileSync(val.currentFile, `+${num}\n`, "utf-8");
        }
    } catch (_) {}
}

// ── CARGAR NÚMEROS PREVIOS ──
function loadChecked() {
    checked.clear();
    try {
        const files = fs.readdirSync(LISTS_DIR);
        for (const f of files) {
            if (!f.endsWith(".txt")) continue;
            try {
                const lines = fs.readFileSync(path.join(LISTS_DIR, f), "utf-8").split("\n");
                for (const l of lines) {
                    const match = l.trim().match(/^\+?(\d{10,})/);
                    if (match) checked.add(match[1]);
                }
            } catch (_) {}
        }
    } catch (_) {}
    if (val.currentFile && fs.existsSync(val.currentFile)) {
        try {
            const lines = fs.readFileSync(val.currentFile, "utf-8").split("\n");
            for (const l of lines) {
                const match = l.trim().match(/^\+?(\d{10,})/);
                if (match) checked.add(match[1]);
            }
        } catch (_) {}
    }
    console.log(`[LOAD] ${checked.size} números previos cargados`);
}

// ── WHATSAPP ──
function destroy() {
    clearTimeout(qrTimer); qrTimer = null;
    clearTimeout(reconnTimer); reconnTimer = null;
    qrMsgId = null; qrStart = null; qrN = 0;
    if (sock) { try { sock.ev.removeAllListeners(); sock.end(); } catch (_) { try { sock.ws?.close(); } catch (_) {} } sock = null; }
    connected = false; connecting = false;
}

async function connectWA(chat) {
    if (connecting) { if (chat) live(chat, "⏳ *Conexión en curso, espera...*"); return; }
    if (connected && sock) return;
    destroy(); connecting = true; connChat = chat;

    let state, save;
    try { ({ state, saveCreds: save } = await useMultiFileAuthState(AUTH)); } catch (e) {
        connecting = false;
        if (chat) live(chat, "❌ *Error al iniciar sesión*", kb.main());
        return;
    }

    let ver;
    try { const r = await timeout(fetchLatestBaileysVersion(), 10000, null); ver = r?.version; } catch (_) { ver = undefined; }

    try {
        const opts = {
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, log) },
            logger: log, printQRInTerminal: false,
            browser: ["DIGI Bot", "Chrome", "22.0"],
            connectTimeoutMs: 45000, defaultQueryTimeoutMs: 25000,
            keepAliveIntervalMs: 15000, emitOwnEvents: false,
            generateHighQualityLinkPreview: false
        };
        if (ver) opts.version = ver;
        sock = makeWASocket(opts);
    } catch (e) {
        connecting = false;
        if (chat) live(chat, "❌ *Error de conexión*", kb.main());
        return;
    }

    sock.ev.on("contacts.upsert", cc => { for (const c of cc) { const n = c.notify || c.verifiedName || c.name; if (n) names.set(c.id, n); } });
    sock.ev.on("contacts.update", cc => { for (const c of cc) { const n = c.notify || c.verifiedName || c.name; if (n) names.set(c.id, n); } });
    sock.ev.on("creds.update", save);

    sock.ev.on("connection.update", up => {
        const { connection, lastDisconnect, qr } = up;

        if (qr) {
            qrN++; qrStart = Date.now(); clearTimeout(qrTimer);
            qrTimer = setTimeout(() => {
                if (!connected && qrStart) {
                    const c = chat, m = qrMsgId; destroy();
                    if (c && m) editCaption(c, m, "⏰ *QR expirado*\nPulsa 📱 *Conectar* para generar uno nuevo.", kb.main().reply_markup);
                    else if (c) live(c, "⏰ *QR expirado*\nPulsa 📱 *Conectar* para generar uno nuevo.", kb.main());
                }
            }, QR_MS);

            QRCode.toBuffer(qr, { scale: 8 }).then(async buf => {
                if (!chat) return;
                if (qrMsgId) { bot.deleteMessage(chat, qrMsgId).catch(() => {}); qrMsgId = null; }
                const cap = qrN > 1
                    ? `📱 *Nuevo QR generado (${qrN})*\n1️⃣ WhatsApp → ⋮ → Dispositivos vinculados\n2️⃣ Vincular dispositivo\n3️⃣ Escanea el código`
                    : `📱 *Escanea este código QR*\n1️⃣ WhatsApp → ⋮ → Dispositivos vinculados\n2️⃣ Vincular dispositivo\n3️⃣ Escanea el código`;
                const m = await bot.sendPhoto(chat, buf, { caption: cap, parse_mode: "Markdown", reply_markup: kb.cancel() }).catch(() => null);
                if (m) qrMsgId = m.message_id;
            }).catch(() => {});
        }

        if (connection === "open") {
            connected = true; connecting = false; reconnN = 0;
            clearTimeout(qrTimer); qrTimer = null;
            const ph = sock?.user?.id?.split(":")[0] || sock?.user?.id?.split("@")[0] || "?";
            const txt = `✅ *WhatsApp vinculado correctamente*\n📱 Cuenta: +${ph}\n🟢 Sistema listo para validar`;
            if (chat && qrMsgId) { editCaption(chat, qrMsgId, txt, kb.main().reply_markup); qrMsgId = null; }
            else if (chat) live(chat, txt, kb.main());
            qrStart = null;
        }

        if (connection === "close") {
            const was = connected;
            connected = false; connecting = false;
            clearTimeout(qrTimer); qrTimer = null;
            const code = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || "desconocido";
            const savedQr = qrMsgId; qrMsgId = null; qrStart = null;
            console.log(`[WA] Close → code=${code} reason=${reason} wasConnected=${was}`);

            if (code === DisconnectReason.loggedOut) {
                try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
                sock = null;
                const t = "🔴 *Sesión finalizada*\nPulsa 📱 *Conectar* para vincular una cuenta.";
                if (chat && savedQr) editCaption(chat, savedQr, t, kb.main().reply_markup);
                else if (chat) live(chat, t, kb.main());
                return;
            }

            const BANNED_CODES = [401, 403, 440, 411, 500];
            if (BANNED_CODES.includes(code)) {
                try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
                sock = null;
                const t = `🚫 *Cuenta bloqueada o sesión inválida* (${code})\nPulsa 📱 *Conectar* para vincular otra cuenta.`;
                if (chat && savedQr) editCaption(chat, savedQr, t, kb.main().reply_markup);
                else if (chat) live(chat, t, kb.main());
                return;
            }

            const hasCreds = fs.existsSync(AUTH) && (() => { try { return fs.readdirSync(AUTH).length > 0; } catch (_) { return false; } })();
            if (!hasCreds) {
                sock = null;
                const t = "🔴 *No hay sesión activa*\nPulsa 📱 *Conectar* para vincular.";
                if (chat && savedQr) editCaption(chat, savedQr, t, kb.main().reply_markup);
                else if (chat) live(chat, t, kb.main());
                return;
            }

            reconnN++;
            if (reconnN > MAX_RECONN) {
                destroy();
                try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
                if (chat) live(chat, `⚠️ *Reconexión fallida tras ${MAX_RECONN} intentos*\nSesión eliminada. Pulsa 📱 *Conectar* para vincular de nuevo.`, kb.main());
                return;
            }

            const delay = !was ? 2000 : Math.min(5000 * Math.pow(1.5, reconnN - 1), 60000);
            if (!was && savedQr && chat) {
                editCaption(chat, savedQr, "🔄 *Vinculando cuenta...*", kb.main().reply_markup);
            } else if (was && chat) {
                live(chat, `⚠️ *Reconectando* (${reconnN}/${MAX_RECONN}) en ${Math.round(delay / 1000)}s...`);
            }

            try { sock.ev.removeAllListeners(); } catch (_) {} sock = null;
            clearTimeout(reconnTimer);
            reconnTimer = setTimeout(() => { connecting = false; connectWA(chat).catch(() => {}); }, delay);
        }
    });
}

// ── CHECK NÚMEROS ──
async function checkNums(nums) {
    if (!sock || !connected) return nums.map(() => null);
    try {
        const r = await timeout(sock.onWhatsApp(...nums.map(n => `${n}@s.whatsapp.net`)), 25000, null);
        if (!r) throw new Error("Timeout");
        return nums.map(n => { const f = r.find(x => x.jid.startsWith(n)); return f ? f.exists === true : false; });
    } catch (e) { val.lastErr = e.message; return nums.map(() => null); }
}

async function getName(num) {
    if (!sock || !connected) return null;
    const jid = `${num}@s.whatsapp.net`;
    const c = names.get(jid); if (c) return c;
    try { const b = await timeout(sock.getBusinessProfile(jid), 5000, null); if (b?.profile?.tag) return b.profile.tag; if (b?.description) return b.description.split("\n")[0].slice(0, 40); } catch (_) {}
    try { if (sock.store?.contacts?.[jid]) { const ct = sock.store.contacts[jid]; return ct.notify || ct.verifiedName || ct.name || null; } } catch (_) {}
    return null;
}

// ── KEEPALIVE DURANTE DESCANSO ──
// Mantiene la conexión WA viva enviando presencia periódicamente
async function keepAliveDuringRest(durationMs) {
    const end = Date.now() + durationMs;
    const startRest = Date.now();

    while (Date.now() < end && !val.stop) {
        // Enviar presencia para mantener la conexión viva
        if (sock && connected) {
            try {
                await sock.sendPresenceUpdate("available");
            } catch (_) {
                // Si falla, no pasa nada, el keepAliveIntervalMs interno también ayuda
            }
        }

        // Actualizar mensaje de Telegram cada 60s con cuenta atrás
        const remaining = end - Date.now();
        if (remaining > 0 && val.chat) {
            const modeLabel = val.mode === "dedicados" ? "⭐ Leads dedicado" : "👥 Leads";
            await live(val.chat,
                `😴 *Descanso — Ciclo ${val.cycleNum} completado*\n` +
                `${modeLabel} · DIGI 🟢\n\n` +
                `✅ Válidos total: ${val.valid.toLocaleString()}\n` +
                `🔍 Escaneados total: ${val.scanned.toLocaleString()}\n` +
                `📊 Este ciclo: ${val.cycleScanned.toLocaleString()}/${MAX_PER_CYCLE}\n\n` +
                `⏳ Reanudación en: *${fmtTime(remaining)}*\n` +
                `📶 Conexión WA: ${connected ? "🟢 Activa" : "🔴 Caída"}\n` +
                `🛡️ KeepAlive activo`,
                kb.running()
            ).catch(() => {});
        }

        // Esperar 30s entre pings (o menos si queda poco)
        const waitMs = Math.min(KEEPALIVE_DURING_REST_MS, end - Date.now());
        if (waitMs > 0) await sleep(waitMs);
    }
}

// ── LIVEMESSAGE: actualiza el mensaje de validación ──
async function updateLive(txt, markup) {
    if (!val.chat) return;
    await live(val.chat, txt, { reply_markup: markup });
}

// ── VALIDACIÓN CONTINUA CON CICLOS 1500 + 1h REST ──
async function runValidation() {
    val.start = Date.now();
    val.scanned = 0; val.valid = 0; val.skip = 0;
    val.err = 0; val.errRow = 0; val.lastN = 0; val.lastErr = "";
    val.stop = false; val.batchCount = 0;
    val.cycleScanned = 0; val.cycleNum = 1;
    val.currentFile = path.join(LISTS_DIR, `_temp_session_${Date.now()}.txt`);

    loadChecked();
    let dcWait = 0;

    const modeLabel = val.mode === "dedicados" ? "⭐ Leads dedicado" : "👥 Leads";
    await updateLive(
        `🚀 *Validación iniciada — Ciclo ${val.cycleNum}*\n${modeLabel} · DIGI 🟢\n🔄 Escaneando ${MAX_PER_CYCLE} números por ciclo...`,
        kb.running().reply_markup
    );

    try {
        while (!val.stop) {
            // ── CONTROL DE CICLO: 1500 escaneados → descanso 1h ──
            if (val.cycleScanned >= MAX_PER_CYCLE) {
                // Enviar presencia "unavailable" antes de descansar
                if (sock && connected) {
                    try { await sock.sendPresenceUpdate("unavailable"); } catch (_) {}
                }

                await updateLive(
                    `🛡️ *Ciclo ${val.cycleNum} completado* (${val.cycleScanned} escaneados)\n` +
                    `😴 Descanso de *1 hora* para proteger la cuenta...\n` +
                    `📶 Conexión WA: ${connected ? "🟢 Activa" : "🔴 Caída"}\n` +
                    `⏳ Reanudación en: *${fmtTime(CYCLE_REST_MS)}*`,
                    kb.running().reply_markup
                );

                // Descanso con keepalive
                await keepAliveDuringRest(CYCLE_REST_MS);

                if (val.stop) break;

                // Nuevo ciclo
                val.cycleNum++;
                val.cycleScanned = 0;
                val.batchCount = 0;
                val.errRow = 0;

                // Reactivar presencia
                if (sock && connected) {
                    try { await sock.sendPresenceUpdate("available"); } catch (_) {}
                }

                await updateLive(
                    `🚀 *Ciclo ${val.cycleNum} iniciado*\n${modeLabel} · DIGI 🟢\n` +
                    `✅ Válidos acumulados: ${val.valid.toLocaleString()}\n` +
                    `🔍 Escaneados acumulados: ${val.scanned.toLocaleString()}\n` +
                    `🔄 Escaneando ${MAX_PER_CYCLE} números más...`,
                    kb.running().reply_markup
                );

                continue;
            }

            if (!connected) {
                dcWait++;
                if (dcWait > 3) {
                    await updateLive("🚫 *WhatsApp desconectado*\nNo se pudo reconectar. Usa 📱 *Conectar*.", kb.main().reply_markup);
                    break;
                }
                await updateLive(`⚠️ *Reconectando* (${dcWait}/3)...`, kb.running().reply_markup);
                let w = 0; while (!connected && w < 30000 && !val.stop) { await sleep(3000); w += 3000; }
                if (!connected) continue;
                dcWait = 0; val.errRow = 0; continue;
            }
            dcWait = 0;

            if (val.errRow >= MAX_ERR) {
                await updateLive(
                    `⚠️ *${val.errRow} errores consecutivos*\n⏸️ Pausa de ${fmtTime(ERR_PAUSE_MS)}...`,
                    kb.running().reply_markup
                );
                await sleep(ERR_PAUSE_MS);
                val.errRow = 0;
                if (!connected) continue;
            }

            if (val.batchCount > 0 && val.batchCount % REST_EVERY === 0) {
                const restMs = randRest();
                await updateLive(
                    `🛡️ *Pausa anti-ban* (lote ${val.batchCount})\n💤 Reanudación en ${fmtTime(restMs)}...`,
                    kb.running().reply_markup
                );
                await sleep(restMs);
                if (val.stop) break;
                if (!connected) continue;
            }

            if (val.stop) break;

            // Calcular cuántos números faltan en este ciclo
            const remaining = MAX_PER_CYCLE - val.cycleScanned;
            const thisBatch = Math.min(BATCH, remaining);

            const batch = [];
            let att = 0;
            while (batch.length < thisBatch && att < thisBatch * 30) {
                att++;
                const n = genNum();
                if (!checked.has(n)) { batch.push(n); checked.add(n); }
            }
            if (!batch.length) { await sleep(2000); continue; }

            const res = await checkNums(batch);
            val.batchCount++;

            let scannedThisBatch = 0;
            for (let i = 0; i < batch.length; i++) {
                if (val.stop) break;
                if (res[i] === null) { val.err++; val.errRow++; continue; }
                val.scanned++; val.cycleScanned++; scannedThisBatch++; val.errRow = 0;
                if (res[i]) {
                    let name = null;
                    try { name = await timeout(getName(batch[i]), 8000, null); } catch (_) {}
                    if (val.mode === "dedicados") {
                        if (name && name !== "Sin nombre") { val.valid++; saveNum(batch[i], name, val.mode); }
                        else val.skip++;
                    } else { val.valid++; saveNum(batch[i], name, val.mode); }
                }
            }

            // Actualizar live cada lote
            const el2 = Date.now() - val.start;
            const spd2 = el2 > 0 ? (val.scanned / (el2 / 1000)).toFixed(2) : "0";
            await updateLive(
                `🔄 *Validando — Ciclo ${val.cycleNum}*\n${modeLabel} · DIGI 🟢\n` +
                `✅ Válidos: ${val.valid.toLocaleString()}\n` +
                `🔍 Escaneados: ${val.scanned.toLocaleString()}\n` +
                (val.skip ? `⏭️ Sin nombre: ${val.skip.toLocaleString()}\n` : "") +
                `📈 Acierto: ${pct(val.valid, val.scanned)}%\n` +
                `⚡ Velocidad: ${spd2}/s\n` +
                `🛡️ Ciclo: ${val.cycleScanned}/${MAX_PER_CYCLE}\n` +
                `⏱️ Tiempo: ${fmtTime(el2)}`,
                kb.running().reply_markup
            );

            await sleep(randDelay());
        }
    } catch (e) {
        if (val.chat) live(val.chat, `💥 *Error crítico:* \`${String(e).slice(0, 200)}\``, kb.done());
    }

    val.on = false;
    const el = Date.now() - val.start;
    const rate = pct(val.valid, val.scanned);

    if (val.valid > 0 && val.currentFile && fs.existsSync(val.currentFile)) {
        live(val.chat,
            `⛔ *Validación finalizada*\n` +
            `${val.mode === "dedicados" ? "⭐ Leads dedicado" : "👥 Leads"} · DIGI 🟢\n` +
            `✅ Válidos: ${val.valid.toLocaleString()}\n` +
            `🔍 Escaneados: ${val.scanned.toLocaleString()}\n` +
            (val.skip ? `⏭️ Sin nombre: ${val.skip.toLocaleString()}\n` : "") +
            `📈 Acierto: ${rate}%\n` +
            `🔄 Ciclos completados: ${val.cycleNum}\n` +
            `⏱️ Duración: ${fmtTime(el)}\n` +
            `📝 *Escribe el nombre para guardar la lista:*`
        );
        const prev = waitName.get(val.chat); if (prev) clearTimeout(prev);
        waitName.set(val.chat, setTimeout(() => {
            const autoName = `lista_${Date.now()}`;
            finalizarLista(val.chat, autoName);
        }, 120000));
    } else {
        live(val.chat,
            `⛔ *Validación finalizada*\n` +
            `✅ Válidos: ${val.valid.toLocaleString()}\n` +
            `🔍 Escaneados: ${val.scanned.toLocaleString()}\n` +
            `🔄 Ciclos: ${val.cycleNum}\n` +
            `⏱️ Duración: ${fmtTime(el)}\n` +
            `_No se encontraron números válidos._`,
            kb.done()
        );
        if (val.currentFile && fs.existsSync(val.currentFile)) {
            try { fs.unlinkSync(val.currentFile); } catch (_) {}
        }
        val.currentFile = null;
    }
}

function finalizarLista(chat, nombre) {
    clearTimeout(waitName.get(chat));
    waitName.delete(chat);
    if (!val.currentFile || !fs.existsSync(val.currentFile)) {
        live(chat, "❌ *No hay datos para guardar*", kb.done());
        val.currentFile = null;
        return;
    }
    const safe = nombre.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ _-]/g, "").trim();
    if (!safe) { live(chat, "❌ *Nombre no válido.* Escribe otro:"); return; }
    if (usedNames.has(safe.toLowerCase())) {
        live(chat, `❌ Ya existe *"${safe}"*. Escribe otro nombre:`);
        return;
    }
    const finalPath = path.join(LISTS_DIR, `${safe}.txt`);
    try {
        fs.renameSync(val.currentFile, finalPath);
    } catch (_) {
        try {
            fs.copyFileSync(val.currentFile, finalPath);
            fs.unlinkSync(val.currentFile);
        } catch (e) {
            live(chat, `❌ *Error al guardar:* \`${e.message}\``, kb.done());
            val.currentFile = null;
            return;
        }
    }
    usedNames.add(safe.toLowerCase());
    val.currentFile = null;
    let count = 0;
    try { count = fs.readFileSync(finalPath, "utf-8").split("\n").filter(l => l.trim()).length; } catch (_) {}
    live(chat,
        `✅ *Lista guardada correctamente*\n` +
        `📄 Archivo: *${safe}.txt*\n` +
        `📊 Total: ${count.toLocaleString()} números\n` +
        `📂 Ubicación: \`${LISTS_DIR}/\``,
        kb.done()
    );
    try {
        bot.sendDocument(chat, finalPath, { caption: `📄 *${safe}* — ${count.toLocaleString()} números DIGI`, parse_mode: "Markdown" }).catch(() => {});
    } catch (_) {}
}

function startVal(chat, mode) {
    if (!connected) { live(chat, "❌ *WhatsApp no vinculado*\nPulsa 📱 *Conectar* primero.", kb.main()); return; }
    if (val.on) { live(chat, "⚠️ *Validación en curso*", kb.running()); return; }
    val.on = true; val.chat = chat; val.mode = mode;
    runValidation().catch(e => { val.on = false; live(chat, `💥 \`${e.message}\``, kb.done()); });
}

// ── ESTADO ──
function sendStatus(chat) {
    if (!val.on) { live(chat, "ℹ️ *No hay validaciones en progreso*", kb.main()); return; }
    const el  = val.start ? Date.now() - val.start : 0;
    const spd = el > 0 ? (val.scanned / (el / 1000)).toFixed(2) : "0";
    const rate = pct(val.valid, val.scanned);
    const modeLabel = val.mode === "dedicados" ? "⭐ Leads dedicado" : "👥 Leads";
    live(chat,
        `📊 *Estado de validación*\n` +
        `${modeLabel} · DIGI 🟢\n` +
        `✅ Válidos: ${val.valid.toLocaleString()}\n` +
        `🔍 Escaneados: ${val.scanned.toLocaleString()}\n` +
        (val.skip ? `⏭️ Sin nombre: ${val.skip.toLocaleString()}\n` : "") +
        (val.err ? `❌ Errores: ${val.err.toLocaleString()}\n` : "") +
        `📈 Acierto: ${rate}%\n` +
        `⚡ Velocidad: ${spd}/s\n` +
        `🛡️ Ciclo ${val.cycleNum}: ${val.cycleScanned}/${MAX_PER_CYCLE}\n` +
        `⏱️ Tiempo: ${fmtTime(el)}`,
        kb.running()
    );
}

// ── MIS LISTAS ──
function sendMyLists(chat) {
    try {
        const files = fs.readdirSync(LISTS_DIR).filter(f => f.endsWith(".txt") && !f.startsWith("_temp_"));
        if (!files.length) { live(chat, "📂 *No hay listas guardadas*", kb.main()); return; }
        let txt = "📂 *Listas guardadas*\n";
        for (const f of files) {
            let count = 0;
            try { count = fs.readFileSync(path.join(LISTS_DIR, f), "utf-8").split("\n").filter(l => l.trim()).length; } catch (_) {}
            txt += `📄 *${f.replace(".txt", "")}* — ${count.toLocaleString()} números\n`;
        }
        const buttons = files.map(f => [{ text: `📥 ${f.replace(".txt", "")}`, callback_data: `dl_${f.replace(".txt", "").slice(0, 40)}` }]);
        buttons.push([{ text: "🏠 Menú", callback_data: "main" }]);
        live(chat, txt, { reply_markup: { inline_keyboard: buttons } });
    } catch (e) { live(chat, "❌ *Error al listar archivos*", kb.main()); }
}

// ── CALLBACKS ──
bot.on("callback_query", async q => {
    const chat = q.message.chat.id, d = q.data;
    bot.answerCallbackQuery(q.id).catch(() => {});
    if (q.from?.username !== ALLOWED_USERNAME) { live(chat, "🚫 Acceso denegado a leads bot"); return; }

    if (d === "main") {
        live(chat, `🤖 *DIGI Validator v14*\n📱 ${connected ? "🟢 Cuenta vinculada" : "🔴 Sin cuenta"}\n🛡️ ${MAX_PER_CYCLE} escaneos/ciclo + 1h descanso`, kb.main());
        return;
    }

    if (d === "cancel_qr") {
        const m = qrMsgId; destroy();
        if (m) editCaption(chat, m, "❌ *Conexión cancelada*", kb.main().reply_markup);
        else live(chat, "❌ *Conexión cancelada*", kb.main());
        return;
    }

    if (d === "new_session") {
        if (val.on) { live(chat, "⚠️ *Detén la validación primero*", kb.running()); return; }
        destroy();
        try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
        reconnN = 0;
        live(chat, "🔄 *Generando nueva sesión...*");
        connectWA(chat).catch(e => { connecting = false; live(chat, `❌ \`${e.message}\``, kb.main()); });
        return;
    }

    if (d === "validate") {
        if (!connected) { live(chat, "❌ *WhatsApp no vinculado*\nPulsa 📱 *Conectar* primero.", kb.main()); return; }
        if (val.on) { live(chat, "⚠️ *Validación en curso*", kb.running()); return; }
        live(chat, "🎯 *Selecciona el modo de validación:*\n👥 *Leads* — Todos los números válidos\n⭐ *Leads dedicado* — Solo números con nombre", kb.mode());
        return;
    }

    if (d === "go_leads") { startVal(chat, "leads"); return; }
    if (d === "go_dedicados") { startVal(chat, "dedicados"); return; }
    if (d === "status") { sendStatus(chat); return; }

    if (d === "stop") {
        if (!val.on) { live(chat, "ℹ️ *No hay validaciones en progreso*", kb.main()); return; }
        val.stop = true;
        live(chat, "⛔ *Deteniendo validación...*");
        return;
    }

    if (d === "my_lists") { sendMyLists(chat); return; }

    if (d.startsWith("dl_")) {
        const name = d.slice(3);
        const filePath = path.join(LISTS_DIR, `${name}.txt`);
        if (!fs.existsSync(filePath)) { live(chat, "❌ *Lista no encontrada*"); return; }
        try {
            const count = fs.readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim()).length;
            await bot.sendDocument(chat, filePath, { caption: `📄 *${name}* — ${count.toLocaleString()} números DIGI`, parse_mode: "Markdown" });
        } catch (e) { live(chat, `❌ \`${e.message}\``); }
        return;
    }

    if (d === "disconnect") {
        if (!connected && !sock && !connecting) { live(chat, "ℹ️ *No hay cuenta vinculada*", kb.main()); return; }
        if (val.on) { live(chat, "⚠️ *Detén la validación primero*", kb.running()); return; }
        try { if (sock) await sock.logout(); } catch (_) {}
        destroy();
        try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
        live(chat, "🔴 *Cuenta desvinculada correctamente*", kb.main());
        return;
    }
});

// ── COMANDOS ──
bot.onText(/\/start/, m => {
    if (!isAllowed(m)) { live(m.chat.id, "🚫 Acceso denegado a leads bot"); return; }
    live(m.chat.id,
        `🤖 *DIGI Validator v14*\n` +
        `📱 ${connected ? "🟢 Cuenta vinculada" : "🔴 Sin cuenta"}\n` +
        `📡 Prefijos: 614, 624, 641, 642, 643\n` +
        `🛡️ Anti-ban · ${MAX_PER_CYCLE} escaneos/ciclo + 1h descanso\n` +
        `🔄 Modo continuo hasta detener`,
        kb.main()
    );
});

bot.onText(/\/conectar/, async m => {
    if (!isAllowed(m)) { live(m.chat.id, "🚫 Acceso denegado a leads bot"); return; }
    const c = m.chat.id;
    if (val.on) { live(c, "⚠️ *Detén la validación primero*", kb.running()); return; }
    destroy();
    try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
    reconnN = 0;
    live(c, "🔄 *Generando nueva sesión...*");
    connectWA(c).catch(e => { connecting = false; live(c, `❌ \`${e.message}\``, kb.main()); });
});

bot.onText(/\/validar/, m => {
    if (!isAllowed(m)) { live(m.chat.id, "🚫 Acceso denegado a leads bot"); return; }
    const c = m.chat.id;
    if (!connected) { live(c, "❌ *WhatsApp no vinculado*\nPulsa 📱 *Conectar* primero.", kb.main()); return; }
    if (val.on) { live(c, "⚠️ *Validación en curso*", kb.running()); return; }
    live(c, "🎯 *Selecciona el modo de validación:*\n👥 *Leads* — Todos los números válidos\n⭐ *Leads dedicado* — Solo números con nombre", kb.mode());
});

bot.onText(/\/estado/,      m => { if (!isAllowed(m)) { live(m.chat.id, "🚫 Acceso denegado a leads bot"); return; } sendStatus(m.chat.id); });
bot.onText(/\/parar/,       m => { if (!isAllowed(m)) { live(m.chat.id, "🚫 Acceso denegado a leads bot"); return; } if (!val.on) { live(m.chat.id, "ℹ️ *No hay validaciones en progreso*", kb.main()); return; } val.stop = true; live(m.chat.id, "⛔ *Deteniendo validación...*"); });
bot.onText(/\/listas/,      m => { if (!isAllowed(m)) { live(m.chat.id, "🚫 Acceso denegado a leads bot"); return; } sendMyLists(m.chat.id); });
bot.onText(/\/desconectar/, async m => {
    if (!isAllowed(m)) { live(m.chat.id, "🚫 Acceso denegado a leads bot"); return; }
    const c = m.chat.id;
    if (!connected && !sock && !connecting) { live(c, "ℹ️ *No hay cuenta vinculada*", kb.main()); return; }
    if (val.on) { live(c, "⚠️ *Detén la validación primero*", kb.running()); return; }
    try { if (sock) await sock.logout(); } catch (_) {} destroy();
    try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
    live(c, "🔴 *Cuenta desvinculada correctamente*", kb.main());
});

// ── TEXTO: nombre de lista ──
bot.on("message", m => {
    const c = m.chat.id;
    if (m.text?.startsWith("/")) return;
    if (!isAllowed(m)) { live(c, "🚫 Acceso denegado a leads bot"); return; }
    if (waitName.has(c)) {
        const nombre = (m.text || "").trim();
        if (!nombre) { live(c, "❌ *Escribe un nombre válido:*"); return; }
        finalizarLista(c, nombre);
        return;
    }
});

// ── SHUTDOWN ──
function shutdown(sig) {
    console.log(`[${sig}] Cerrando...`);
    if (val.on) val.stop = true;
    destroy();
    try { bot.stopPolling(); } catch (_) {}
    process.exit(0);
}
process.on("SIGINT",             () => shutdown("SIGINT"));
process.on("SIGTERM",            () => shutdown("SIGTERM"));
process.on("uncaughtException",  e  => console.error("[FATAL]", e.message));
process.on("unhandledRejection", r  => console.error("[FATAL]", r));

// ── MAIN ──
async function main() {
    console.log("═══ DIGI Validator v14 — 1500/ciclo + 1h descanso + KeepAlive ═══");
    const has = fs.existsSync(AUTH) && (() => { try { return fs.readdirSync(AUTH).length > 0; } catch (_) { return false; } })();
    if (has) { console.log("Reconectando..."); connectWA(null).catch(() => { connecting = false; }); }
    else console.log("Sin sesión. Esperando /conectar...");
    console.log("✅ Sistema iniciado");
}
main().catch(e => console.error("[MAIN]", e));
