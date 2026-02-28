/**
 * TR10 Attendance Bot V8 (NO ValidationError) ✅
 * discord.js v14 + sqlite + Express
 * Commands:
 *  /panel
 *  /status
 *  /stats
 *  /autorole add hours role
 *  /autorole list
 */

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

/* ================= WEB ================= */
const app = express();
app.get("/", (req, res) => res.status(200).send("Bot Running ✅"));
app.get("/health", (req, res) => res.status(200).send("OK ✅"));
app.all("*", (req, res) => res.status(200).send("OK ✅"));
app.listen(process.env.PORT || 3000, () => console.log("🌐 Web server ready"));

/* ================= ENV ================= */
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const TZ = process.env.TZ || "Asia/Riyadh";

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.log("❌ Missing ENV: TOKEN / CLIENT_ID / OWNER_ID");
  process.exit(1);
}

/* ====== حماية أخطاء ====== */
process.on("unhandledRejection", (e) => console.error("❌ UNHANDLED:", e));
process.on("uncaughtException", (e) => console.error("❌ UNCAUGHT:", e));

/* ================= CLIENT ================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

/* ================= DB ================= */
let db;

async function initDb() {
  db = await open({
    filename: "./data.db",
    driver: sqlite3.Database,
  });

  await db.exec(`PRAGMA journal_mode=WAL;`);
  await db.exec(`PRAGMA busy_timeout=5000;`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      guild_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      session_no INTEGER NOT NULL,
      checkin INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS stats (
      guild_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      total_time INTEGER NOT NULL DEFAULT 0,
      total_entries INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS autoroles (
      guild_id TEXT NOT NULL,
      hours INTEGER NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, hours)
    );
  `);

  console.log("✅ DB ready");
}

/* ================= HELPERS ================= */
function msToHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}h ${m}m ${ss}s`;
}

function totalHoursFromMs(ms) {
  return Math.floor((ms || 0) / 3600000);
}

function fmtDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/* ================= COMMANDS (FIXED DESCRIPTIONS ✅) ================= */
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("إرسال لوحة الحضور"),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("عرض حالتك الحالية (داخل/خارج)"),

    new SlashCommandBuilder()
      .setName("stats")
      .setDescription("لوحة إحصائياتك + عدد الداخلين الآن + ترتيبك"),

    new SlashCommandBuilder()
      .setName("autorole")
      .setDescription("نظام الرتب التلقائية حسب عدد الساعات")
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("إضافة رتبة تلقائية عند عدد ساعات معين")
          .addIntegerOption((o) =>
            o
              .setName("hours")
              .setDescription("عدد الساعات المطلوبة للحصول على الرتبة")
              .setRequired(true)
              .setMinValue(1)
          )
          .addRoleOption((o) =>
            o
              .setName("role")
              .setDescription("الرتبة التي يحصل عليها العضو عند الوصول للساعات")
              .setRequired(true)
          )
      )
      .addSubcommand((s) =>
        s
          .setName("list")
          .setDescription("عرض قائمة الرتب التلقائية في السيرفر")
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map((c) => c.toJSON());
}

async function registerGlobalCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: buildCommands() });
  console.log("✅ Global commands pushed");
}

/* ================= PANEL UI ================= */
function panelEmbed() {
  return new EmbedBuilder()
    .setTitle("نظام تسجيل الحضور")
    .setDescription("اضغط الأزرار للتسجيل")
    .setColor(0x2b2d31);
}

function panelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("in").setLabel("تسجيل دخول").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("out").setLabel("تسجيل خروج").setStyle(ButtonStyle.Danger)
  );
}

/* ================= CORE ================= */
async function getOpenSession(gid, uid) {
  return db.get("SELECT * FROM sessions WHERE guild_id=? AND user_id=?", [gid, uid]);
}

async function getStats(gid, uid) {
  return db.get("SELECT * FROM stats WHERE guild_id=? AND user_id=?", [gid, uid]);
}

async function ensureStatsRow(gid, uid) {
  await db.run(
    `INSERT INTO stats (guild_id, user_id, total_time, total_entries)
     VALUES (?, ?, 0, 0)
     ON CONFLICT(guild_id, user_id) DO NOTHING`,
    [gid, uid]
  );
}

async function applyAutoRoles(interaction, totalTimeMs) {
  const gid = interaction.guildId;
  const uid = interaction.user.id;

  const h = totalHoursFromMs(totalTimeMs);
  const rows = await db.all(
    "SELECT hours, role_id FROM autoroles WHERE guild_id=? AND hours <= ? ORDER BY hours ASC",
    [gid, h]
  );
  if (!rows.length) return;

  const member = await interaction.guild.members.fetch(uid).catch(() => null);
  if (!member) return;

  for (const r of rows) {
    if (!member.roles.cache.has(r.role_id)) {
      await member.roles.add(r.role_id).catch(() => {});
    }
  }
}

/* ================= INTERACTIONS ================= */
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.inGuild()) return;

    const gid = interaction.guildId;
    const uid = interaction.user.id;

    /* ---- SLASH ---- */
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      // panel رد فوري
      if (cmd === "panel") {
        return interaction.reply({ embeds: [panelEmbed()], components: [panelRow()] });
      }

      // باقي الأوامر: نأمنها
      await interaction.deferReply({ ephemeral: true }).catch(() => null);

      if (cmd === "status") {
        const open = await getOpenSession(gid, uid);
        if (!open) return interaction.editReply("📌 أنت خارج");

        return interaction.editReply(
          `📌 أنت داخل\n⏱️ ${msToHMS(Date.now() - open.checkin)}\n🔁 رقم الدخول: ${open.session_no}`
        );
      }

      if (cmd === "stats") {
        await ensureStatsRow(gid, uid);

        const my = await getStats(gid, uid);
        const totalTime = my?.total_time || 0;
        const totalH = totalHoursFromMs(totalTime);

        const onlineNow = await db.all("SELECT user_id FROM sessions WHERE guild_id=?", [gid]);

        const ranking = await db.all(
          "SELECT user_id, total_time FROM stats WHERE guild_id=? ORDER BY total_time DESC",
          [gid]
        );
        const pos = ranking.findIndex((r) => r.user_id === uid) + 1;

        const auto = await db.all(
          "SELECT hours, role_id FROM autoroles WHERE guild_id=? ORDER BY hours ASC",
          [gid]
        );

        let nextRoleTxt = "لا يوجد";
        for (const r of auto) {
          if (totalH < r.hours) {
            nextRoleTxt = `<@&${r.role_id}> بعد **${r.hours - totalH}** ساعة`;
            break;
          }
        }

        const emb = new EmbedBuilder()
          .setTitle("📊 لوحة إحصائياتك")
          .setColor(0x2b2d31)
          .addFields(
            { name: "⏱️ ساعاتك (مدى الحياة)", value: `**${totalH}** ساعة`, inline: true },
            { name: "🔁 عدد الجلسات", value: `**${my?.total_entries || 0}**`, inline: true },
            { name: "🟢 الداخلين الآن", value: `**${onlineNow.length}**`, inline: true },
            { name: "🏆 ترتيبك بالسيرفر", value: pos ? `**#${pos}**` : "غير مصنف", inline: true },
            { name: "🎯 أقرب رتبة قادمة", value: nextRoleTxt, inline: false }
          )
          .setFooter({ text: `📅 ${fmtDate()} • TR10 V8` });

        return interaction.editReply({ embeds: [emb] });
      }

      if (cmd === "autorole") {
        const sub = interaction.options.getSubcommand();

        if (sub === "add") {
          const hrs = interaction.options.getInteger("hours", true);
          const role = interaction.options.getRole("role", true);

          await db.run(
            "INSERT OR REPLACE INTO autoroles (guild_id, hours, role_id) VALUES (?,?,?)",
            [gid, hrs, role.id]
          );

          return interaction.editReply(`✅ تم إضافة رتبة ${role} عند **${hrs}** ساعة`);
        }

        if (sub === "list") {
          const rows = await db.all(
            "SELECT hours, role_id FROM autoroles WHERE guild_id=? ORDER BY hours ASC",
            [gid]
          );

          if (!rows.length) return interaction.editReply("📌 لا يوجد رتب تلقائية مضافة.");

          const text = rows.map((r, i) => `**${i + 1})** ${r.hours} ساعة → <@&${r.role_id}>`).join("\n");

          const emb = new EmbedBuilder()
            .setTitle("📌 قائمة الرتب التلقائية")
            .setDescription(text)
            .setColor(0x2b2d31);

          return interaction.editReply({ embeds: [emb] });
        }
      }

      return interaction.editReply("❓ أمر غير معروف.");
    }

    /* ---- BUTTONS ---- */
    if (interaction.isButton()) {
      const gid = interaction.guildId;
      const uid = interaction.user.id;

      // رد سريع لتفادي did not respond
      await interaction.deferReply({ ephemeral: true }).catch(() => null);

      const open = await getOpenSession(gid, uid);

      if (interaction.customId === "in") {
        if (open) return interaction.editReply("⚠️ أنت داخل بالفعل.");

        await ensureStatsRow(gid, uid);
        const st = await getStats(gid, uid);
        const sessionNo = (st?.total_entries || 0) + 1;

        await db.run(
          "INSERT OR REPLACE INTO sessions (guild_id, user_id, session_no, checkin) VALUES (?,?,?,?)",
          [gid, uid, sessionNo, Date.now()]
        );

        return interaction.editReply(`✅ تم تسجيل الدخول 🔁 (**${sessionNo}**)`);
      }

      if (interaction.customId === "out") {
        if (!open) return interaction.editReply("⚠️ أنت غير مسجل دخول.");

        const duration = Date.now() - open.checkin;

        await db.run("DELETE FROM sessions WHERE guild_id=? AND user_id=?", [gid, uid]);

        await db.run(
          `INSERT INTO stats (guild_id, user_id, total_time, total_entries)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(guild_id, user_id)
           DO UPDATE SET
             total_time = total_time + excluded.total_time,
             total_entries = total_entries + 1`,
          [gid, uid, duration]
        );

        const after = await getStats(gid, uid);
        await applyAutoRoles(interaction, after?.total_time || 0);

        return interaction.editReply(`💤 تم تسجيل الخروج\n⏱️ مدة الجلسة: **${msToHMS(duration)}**`);
      }

      return interaction.editReply("زر غير معروف.");
    }
  } catch (err) {
    console.error("❌ INTERACTION ERROR:", err);
    try {
      if (interaction?.deferred) return interaction.editReply("حدث خطأ بسيط.");
      if (interaction?.isRepliable() && !interaction.replied) return interaction.reply({ content: "حدث خطأ بسيط.", ephemeral: true });
    } catch {}
  }
});

/* ================= START ================= */
(async () => {
  await initDb();

  client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await registerGlobalCommands().catch((e) => console.error("Commands push error:", e));
  });

  console.log("🔌 Logging in...");
  await client.login(TOKEN);
})();
