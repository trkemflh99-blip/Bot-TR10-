// ==========================================================
// TR10 Attendance Bot V9.2 ELITE (NO VALIDATION ERRORS)
// discord.js v14 + sqlite + Express
// Features:
// - /panel (admin) creates/upgrades panel & auto-updates names inside
// - /setlog (admin) set log channel (private logs)
// - /top (anyone) top by time (hours/min) OR entries
// - /setrole (admin) set auto role reward by hours (cumulative forever)
// - /roles (admin) list role rewards
// - /removerole (admin) remove role reward
// - /sync (owner) global/guild commands
// - /resetguild (owner) clear guild commands
// - /blockguild /unblockguild /blockedguilds (owner) guild block system
// - Fast replies + deferReply to prevent "did not respond"
// ==========================================================

require("dotenv").config();
const express = require("express");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require("discord.js");

const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

// ================= WEB (keep alive) =================
const app = express();
app.get("/", (req, res) => res.status(200).send("TR10 Attendance V9.2 ELITE Running ✅"));
app.get("/health", (req, res) => res.status(200).send("OK ✅"));
app.all("*", (req, res) => res.status(200).send("OK ✅"));
app.listen(process.env.PORT || 3000, () => console.log("🌐 Web server online"));

// ================= ENV =================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const TZ = process.env.TZ || "Asia/Riyadh";

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.log("❌ Missing ENV: TOKEN / CLIENT_ID / OWNER_ID");
  process.exit(1);
}

// ================= SAFETY LOGS =================
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));

// ================= CLIENT =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ================= TIME HELPERS =================
function fmtDate(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
function fmtTime(d) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}
function nowParts() {
  const d = new Date();
  return { ms: Date.now(), date: fmtDate(d), time: fmtTime(d) };
}
function msToHM(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} ساعة ${m} دقيقة`;
}
function msToHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}h ${m}m ${ss}s`;
}

// ================= DB =================
let db;

async function initDB() {
  db = await open({
    filename: "./attendance_elite.db",
    driver: sqlite3.Database,
  });

  await db.exec(`PRAGMA journal_mode = WAL;`);
  await db.exec(`PRAGMA busy_timeout = 5000;`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT PRIMARY KEY,
      log_channel_id TEXT,
      panel_channel_id TEXT,
      panel_message_id TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_no INTEGER NOT NULL,
      checkin_ms INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS stats (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      total_time_ms INTEGER NOT NULL DEFAULT 0,
      total_entries INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,          -- IN / OUT
      at_ms INTEGER NOT NULL,
      at_date TEXT NOT NULL,
      at_time TEXT NOT NULL,
      session_no INTEGER NOT NULL,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS role_rewards (
      guild_id TEXT NOT NULL,
      hours INTEGER NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, hours, role_id)
    );

    CREATE TABLE IF NOT EXISTS blocked_guilds (
      guild_id TEXT PRIMARY KEY,
      blocked_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_logs_date
      ON logs(guild_id, at_date);

    CREATE INDEX IF NOT EXISTS idx_sessions_open
      ON sessions(guild_id);
  `);

  console.log("✅ DB ready");
}

async function ensureSettings(gid) {
  const row = await db.get("SELECT * FROM settings WHERE guild_id=?", [gid]);
  if (row) return row;

  await db.run(
    "INSERT INTO settings (guild_id, log_channel_id, panel_channel_id, panel_message_id) VALUES (?, NULL, NULL, NULL)",
    [gid]
  );
  return db.get("SELECT * FROM settings WHERE guild_id=?", [gid]);
}

async function isGuildBlocked(gid) {
  const row = await db.get("SELECT guild_id FROM blocked_guilds WHERE guild_id=?", [gid]);
  return !!row;
}

async function sendLogEmbed(guild, embed) {
  try {
    const s = await ensureSettings(guild.id);
    if (!s.log_channel_id) return;

    const ch = await guild.channels.fetch(s.log_channel_id).catch(() => null);
    if (!ch || !ch.isTextBased()) return;

    await ch.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.error("sendLogEmbed:", e);
  }
}

// ================= PANEL =================
function panelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("att_in").setLabel("تسجيل دخول").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("att_out").setLabel("تسجيل خروج").setEmoji("❌").setStyle(ButtonStyle.Danger)
  );
}

async function buildPanelEmbed(gid) {
  const rows = await db.all("SELECT user_id, session_no, checkin_ms FROM sessions WHERE guild_id=? ORDER BY checkin_ms ASC", [gid]);

  const count = rows.length;
  const list = count
    ? rows
        .slice(0, 30)
        .map((r, i) => {
          const elapsed = Date.now() - r.checkin_ms;
          return `**${i + 1}.** <@${r.user_id}>  —  ⏱️ ${msToHM(elapsed)}  —  🔁 ${r.session_no}`;
        })
        .join("\n")
    : "لا يوجد أحد مسجل دخول حالياً.";

  const { date, time } = nowParts();

  return new EmbedBuilder()
    .setColor(0x111827)
    .setTitle("🛡️ نظام تسجيل حضور المودريشن")
    .setDescription(
      [
        "• هذا البانيل مخصص لتسجيل حضور وانصراف المود.",
        "• يرجى الالتزام باستخدام الأزرار لضمان احتساب الوقت بشكل صحيح.",
        "• أي تواجد بدون تسجيل دخول لا يتم احتسابه.",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━",
        `👥 **الأعضاء المسجلين دخول حالياً** (${count})`,
        "",
        list,
        "━━━━━━━━━━━━━━━━━━━━━━",
      ].join("\n")
    )
    .setFooter({ text: `آخر تحديث: ${date} • ${time} | TR10 Attendance ELITE` });
}

async function updatePanel(guild) {
  const s = await ensureSettings(guild.id);
  if (!s.panel_channel_id || !s.panel_message_id) return;

  const ch = await guild.channels.fetch(s.panel_channel_id).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const msg = await ch.messages.fetch(s.panel_message_id).catch(() => null);
  if (!msg) return;

  const emb = await buildPanelEmbed(guild.id);
  await msg.edit({ embeds: [emb], components: [panelButtons()] }).catch(() => {});
}

// ================= COMMANDS =================
function buildCommandsJSON() {
  return [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("إنشاء/تحديث لوحة الحضور الرسمية (تظهر فيها أسماء المسجلين)")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("الروم اللي ينرسل فيه البانل")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("setlog")
      .setDescription("تحديد روم اللوق الخاص (يرسل دخول/خروج + المدة + عدد مرات الدخول)")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("روم اللوق")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("top")
      .setDescription("عرض التوب (بالساعات/الدقائق) أو مرات الدخول")
      .addStringOption((o) =>
        o
          .setName("type")
          .setDescription("نوع الترتيب")
          .setRequired(true)
          .addChoices(
            { name: "⏱️ الوقت (ساعات/دقائق)", value: "time" },
            { name: "🔁 مرات الدخول", value: "entries" }
          )
      ),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("يعرض حالتك الحالية: داخل/خارج + مدة الجلسة الحالية"),

    new SlashCommandBuilder()
      .setName("setrole")
      .setDescription("تحديد رتبة تلقائية عند الوصول لساعات معينة (مجموع دائم)")
      .addIntegerOption((o) =>
        o
          .setName("hours")
          .setDescription("عدد الساعات المطلوبة (مثال: 30)")
          .setRequired(true)
          .setMinValue(1)
      )
      .addRoleOption((o) =>
        o
          .setName("role")
          .setDescription("الرتبة اللي تنعطى تلقائياً")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("roles")
      .setDescription("عرض جميع رتب المكافآت المحددة (حسب الساعات)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("removerole")
      .setDescription("حذف مكافأة رتبة (ساعات + رتبة)")
      .addIntegerOption((o) =>
        o
          .setName("hours")
          .setDescription("عدد الساعات للمكافأة")
          .setRequired(true)
          .setMinValue(1)
      )
      .addRoleOption((o) =>
        o
          .setName("role")
          .setDescription("الرتبة المراد حذفها من المكافآت")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // ===== OWNER COMMANDS =====
    new SlashCommandBuilder()
      .setName("sync")
      .setDescription("OWNER: مزامنة الأوامر (global/guild)")
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("نوع المزامنة")
          .setRequired(true)
          .addChoices(
            { name: "guild (سريع للسيرفر الحالي)", value: "guild" },
            { name: "global (عام لكل السيرفرات)", value: "global" }
          )
      ),

    new SlashCommandBuilder()
      .setName("resetguild")
      .setDescription("OWNER: حذف أوامر السيرفر الحالي (Guild Commands)"),

    new SlashCommandBuilder()
      .setName("blockguild")
      .setDescription("OWNER: حظر سيرفر (البوت يتوقف فيه)")
      .addStringOption((o) =>
        o
          .setName("guild_id")
          .setDescription("ايدي السيرفر (اختياري - الافتراضي الحالي)")
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("unblockguild")
      .setDescription("OWNER: فك حظر سيرفر")
      .addStringOption((o) =>
        o
          .setName("guild_id")
          .setDescription("ايدي السيرفر (اختياري - الافتراضي الحالي)")
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("blockedguilds")
      .setDescription("OWNER: عرض السيرفرات المحظورة"),
  ].map((c) => c.toJSON());
}

async function registerGlobalCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: buildCommandsJSON() });
  console.log("✅ Global commands registered");
}

async function registerGuildCommands(guildId) {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: buildCommandsJSON() });
  console.log("✅ Guild commands registered:", guildId);
}

async function clearGuildCommands(guildId) {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: [] });
  console.log("✅ Guild commands cleared:", guildId);
}

// ================= READY =================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  // ملاحظة: ما نسوي تسجيل عالمي تلقائي هنا لتفادي أي مشاكل/تكرار
  // إذا تبي تسويها عام لكل السيرفرات استخدم /sync global
});

// ================= CORE HELPERS =================
async function getOpenSession(gid, uid) {
  return db.get("SELECT * FROM sessions WHERE guild_id=? AND user_id=?", [gid, uid]);
}

async function getNextSessionNo(gid, uid) {
  const row = await db.get("SELECT total_entries FROM stats WHERE guild_id=? AND user_id=?", [gid, uid]);
  return (row?.total_entries || 0) + 1;
}

async function upsertStats(gid, uid, addDurationMs) {
  await db.run(
    `
    INSERT INTO stats (guild_id, user_id, total_time_ms, total_entries)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(guild_id, user_id)
    DO UPDATE SET
      total_time_ms = total_time_ms + excluded.total_time_ms,
      total_entries = total_entries + 1
    `,
    [gid, uid, addDurationMs]
  );
}

async function tryGiveRewards(guild, uid) {
  const stat = await db.get("SELECT total_time_ms FROM stats WHERE guild_id=? AND user_id=?", [guild.id, uid]);
  if (!stat) return;

  const rewards = await db.all("SELECT hours, role_id FROM role_rewards WHERE guild_id=? ORDER BY hours ASC", [guild.id]);
  if (!rewards.length) return;

  const member = await guild.members.fetch(uid).catch(() => null);
  if (!member) return;

  for (const r of rewards) {
    const need = r.hours * 3600000;
    if (stat.total_time_ms >= need && !member.roles.cache.has(r.role_id)) {
      await member.roles.add(r.role_id).catch(() => {});
    }
  }
}

// ================= INTERACTIONS =================
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.inGuild()) {
      if (interaction.isRepliable()) {
        return interaction.reply({ content: "❌ هذا البوت يعمل داخل السيرفر فقط.", ephemeral: true });
      }
      return;
    }

    const gid = interaction.guildId;

    // Blocked guild protection (except owner)
    if (interaction.user.id !== OWNER_ID) {
      const blocked = await isGuildBlocked(gid).catch(() => false);
      if (blocked) {
        if (interaction.isRepliable()) {
          return interaction.reply({ content: "⛔ البوت متوقف في هذا السيرفر (محظور من الأونر).", ephemeral: true });
        }
        return;
      }
    }

    // ================= BUTTONS =================
    if (interaction.isButton()) {
      // سريع + يمنع did not respond
      await interaction.deferReply({ ephemeral: true }).catch(() => null);

      const uid = interaction.user.id;
      const { ms, date, time } = nowParts();

      if (interaction.customId === "att_in") {
        const open = await getOpenSession(gid, uid);
        if (open) return interaction.editReply("⚠️ أنت مسجل دخول بالفعل. لازم تسجل خروج أول.");

        const sessionNo = await getNextSessionNo(gid, uid);

        await db.run(
          "INSERT INTO sessions (guild_id, user_id, session_no, checkin_ms) VALUES (?,?,?,?)",
          [gid, uid, sessionNo, ms]
        );

        await db.run(
          "INSERT INTO logs (guild_id, user_id, action, at_ms, at_date, at_time, session_no, duration_ms) VALUES (?,?,?,?,?,?,?,NULL)",
          [gid, uid, "IN", ms, date, time, sessionNo]
        );

        // Log embed (private)
        const emb = new EmbedBuilder()
          .setColor(0x22c55e)
          .setTitle("✅ تسجيل دخول")
          .setDescription(`👤 <@${uid}>\n🕒 ${time}\n🗓️ ${date}\n🔁 رقم الدخول: **${sessionNo}**`)
          .setFooter({ text: "TR10 Attendance ELITE" });

        await sendLogEmbed(interaction.guild, emb);
        await updatePanel(interaction.guild);

        return interaction.editReply(`✅ تم تسجيل دخولك — 🔁 (${sessionNo})`);
      }

      if (interaction.customId === "att_out") {
        const open = await getOpenSession(gid, uid);
        if (!open) return interaction.editReply("⚠️ ما عندك جلسة مفتوحة. سجل دخول أول.");

        const duration = ms - open.checkin_ms;

        await db.run("DELETE FROM sessions WHERE guild_id=? AND user_id=?", [gid, uid]);
        await upsertStats(gid, uid, duration);

        await db.run(
          "INSERT INTO logs (guild_id, user_id, action, at_ms, at_date, at_time, session_no, duration_ms) VALUES (?,?,?,?,?,?,?,?)",
          [gid, uid, "OUT", ms, date, time, open.session_no, duration]
        );

        const stat = await db.get("SELECT total_time_ms, total_entries FROM stats WHERE guild_id=? AND user_id=?", [gid, uid]);

        // Give roles if eligible
        await tryGiveRewards(interaction.guild, uid);

        // Log embed
        const emb = new EmbedBuilder()
          .setColor(0xef4444)
          .setTitle("❌ تسجيل خروج")
          .setDescription(
            `👤 <@${uid}>\n🕒 ${time}\n🗓️ ${date}\n⏱️ مدة الجلسة: **${msToHM(duration)}**\n🔁 رقم الدخول: **${open.session_no}**\n\n` +
            `📌 المجموع: **${msToHM(stat?.total_time_ms || 0)}**\n📍 مرات الدخول: **${stat?.total_entries || 0}**`
          )
          .setFooter({ text: "TR10 Attendance ELITE" });

        await sendLogEmbed(interaction.guild, emb);
        await updatePanel(interaction.guild);

        return interaction.editReply(`✅ تم تسجيل خروجك — ⏱️ ${msToHM(duration)} (🔁 ${open.session_no})`);
      }

      return interaction.editReply("زر غير معروف.");
    }

    // ================= SLASH =================
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      // panel: سريع وبدون defer
      if (cmd === "panel") {
        const ch = interaction.options.getChannel("channel", true);
        await ensureSettings(gid);

        const emb = await buildPanelEmbed(gid);
        const msg = await ch.send({ embeds: [emb], components: [panelButtons()] });

        // حفظ بيانات البانل
        await db.run(
          "UPDATE settings SET panel_channel_id=?, panel_message_id=? WHERE guild_id=?",
          [ch.id, msg.id, gid]
        );

        return interaction.reply({ content: `✅ تم إنشاء البانل في <#${ch.id}>`, ephemeral: true });
      }

      // باقي الأوامر
      await interaction.deferReply({ ephemeral: true }).catch(() => null);

      // OWNER: sync/reset/block
      if (cmd === "sync") {
        if (interaction.user.id !== OWNER_ID) return interaction.editReply("❌ هذا الأمر للأونر فقط.");
        const scope = interaction.options.getString("scope", true);
        if (scope === "guild") {
          await registerGuildCommands(gid);
          return interaction.editReply("✅ تمّت مزامنة أوامر السيرفر الحالي (Guild) بسرعة.");
        }
        await registerGlobalCommands();
        return interaction.editReply("✅ تم رفع الأوامر عامّة (Global) لكل السيرفرات.");
      }

      if (cmd === "resetguild") {
        if (interaction.user.id !== OWNER_ID) return interaction.editReply("❌ هذا الأمر للأونر فقط.");
        await clearGuildCommands(gid);
        return interaction.editReply("✅ تم حذف أوامر السيرفر الحالي (Guild Commands).");
      }

      if (cmd === "blockguild") {
        if (interaction.user.id !== OWNER_ID) return interaction.editReply("❌ هذا الأمر للأونر فقط.");
        const target = interaction.options.getString("guild_id") || gid;
        await db.run(
          `INSERT INTO blocked_guilds (guild_id, blocked_at_ms)
           VALUES (?, ?)
           ON CONFLICT(guild_id) DO UPDATE SET blocked_at_ms=excluded.blocked_at_ms`,
          [target, Date.now()]
        );
        return interaction.editReply(`⛔ تم حظر السيرفر: \`${target}\``);
      }

      if (cmd === "unblockguild") {
        if (interaction.user.id !== OWNER_ID) return interaction.editReply("❌ هذا الأمر للأونر فقط.");
        const target = interaction.options.getString("guild_id") || gid;
        await db.run("DELETE FROM blocked_guilds WHERE guild_id=?", [target]);
        return interaction.editReply(`✅ تم فك الحظر عن السيرفر: \`${target}\``);
      }

      if (cmd === "blockedguilds") {
        if (interaction.user.id !== OWNER_ID) return interaction.editReply("❌ هذا الأمر للأونر فقط.");
        const rows = await db.all("SELECT guild_id, blocked_at_ms FROM blocked_guilds ORDER BY blocked_at_ms DESC");
        if (!rows.length) return interaction.editReply("✅ ما فيه سيرفرات محظورة.");
        const lines = rows.slice(0, 25).map((r, i) => `**${i + 1})** \`${r.guild_id}\``).join("\n");
        const emb = new EmbedBuilder().setColor(0x111827).setTitle("⛔ السيرفرات المحظورة").setDescription(lines);
        return interaction.editReply({ embeds: [emb] });
      }

      if (cmd === "setlog") {
        const ch = interaction.options.getChannel("channel", true);
        await ensureSettings(gid);
        await db.run("UPDATE settings SET log_channel_id=? WHERE guild_id=?", [ch.id, gid]);
        return interaction.editReply(`✅ تم تعيين روم اللوق: <#${ch.id}>`);
      }

      if (cmd === "status") {
        const open = await getOpenSession(gid, interaction.user.id);
        if (!open) return interaction.editReply("📌 حالتك: **خارج** (ما عندك جلسة مفتوحة).");
        const elapsed = Date.now() - open.checkin_ms;
        return interaction.editReply(`📌 حالتك: **داخل**\n🔁 رقم الدخول: **${open.session_no}**\n⏱️ المدة الحالية: **${msToHM(elapsed)}**`);
      }

      if (cmd === "top") {
        const type = interaction.options.getString("type", true);
        let rows = [];

        if (type === "time") {
          rows = await db.all(
            `SELECT user_id, total_time_ms, total_entries
             FROM stats
             WHERE guild_id=?
             ORDER BY total_time_ms DESC, total_entries DESC
             LIMIT 15`,
            [gid]
          );

          if (!rows.length) return interaction.editReply("لا يوجد بيانات حتى الآن.");

          const text = rows
            .map((r, i) => `**${i + 1})** <@${r.user_id}> — ⏱️ **${msToHM(r.total_time_ms || 0)}** — 🔁 **${r.total_entries || 0}**`)
            .join("\n");

          const emb = new EmbedBuilder()
            .setColor(0x111827)
            .setTitle("🏆 التوب — الوقت (ساعات/دقائق)")
            .setDescription(text);

          return interaction.editReply({ embeds: [emb] });
        }

        rows = await db.all(
          `SELECT user_id, total_time_ms, total_entries
           FROM stats
           WHERE guild_id=?
           ORDER BY total_entries DESC, total_time_ms DESC
           LIMIT 15`,
          [gid]
        );

        if (!rows.length) return interaction.editReply("لا يوجد بيانات حتى الآن.");

        const text = rows
          .map((r, i) => `**${i + 1})** <@${r.user_id}> — 🔁 **${r.total_entries || 0}** — ⏱️ **${msToHM(r.total_time_ms || 0)}**`)
          .join("\n");

        const emb = new EmbedBuilder()
          .setColor(0x111827)
          .setTitle("🏆 التوب — مرات الدخول")
          .setDescription(text);

        return interaction.editReply({ embeds: [emb] });
      }

      if (cmd === "setrole") {
        const hours = interaction.options.getInteger("hours", true);
        const role = interaction.options.getRole("role", true);

        await db.run(
          "INSERT OR IGNORE INTO role_rewards (guild_id, hours, role_id) VALUES (?,?,?)",
          [gid, hours, role.id]
        );

        return interaction.editReply(`✅ تم تعيين مكافأة: عند **${hours} ساعة** يحصل العضو على رتبة <@&${role.id}>`);
      }

      if (cmd === "roles") {
        const rows = await db.all(
          "SELECT hours, role_id FROM role_rewards WHERE guild_id=? ORDER BY hours ASC",
          [gid]
        );

        if (!rows.length) return interaction.editReply("📌 ما تم تحديد أي رتب مكافآت بعد.");

        const text = rows
          .map((r, i) => `**${i + 1})** عند **${r.hours} ساعة** → <@&${r.role_id}>`)
          .join("\n");

        const emb = new EmbedBuilder()
          .setColor(0x111827)
          .setTitle("🎖️ رتب المكافآت (حسب الساعات)")
          .setDescription(text);

        return interaction.editReply({ embeds: [emb] });
      }

      if (cmd === "removerole") {
        const hours = interaction.options.getInteger("hours", true);
        const role = interaction.options.getRole("role", true);

        await db.run("DELETE FROM role_rewards WHERE guild_id=? AND hours=? AND role_id=?", [gid, hours, role.id]);
        return interaction.editReply(`✅ تم حذف مكافأة: **${hours} ساعة** → <@&${role.id}>`);
      }

      return interaction.editReply("❓ أمر غير معروف.");
    }
  } catch (err) {
    console.error("INTERACTION ERROR:", err);
    try {
      if (interaction?.deferred) return interaction.editReply("حدث خطأ غير متوقع.");
      if (interaction?.replied) return interaction.followUp({ content: "حدث خطأ غير متوقع.", ephemeral: true });
      if (interaction?.isRepliable()) return interaction.reply({ content: "حدث خطأ غير متوقع.", ephemeral: true });
    } catch {}
  }
});

// ================= START =================
(async () => {
  await initDB();
  console.log("🔌 Logging in...");
  await client.login(TOKEN);
  console.log("✅ Login success");
})();
