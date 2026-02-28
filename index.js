// TR10 Attendance Pro FINAL (FIXED VALIDATION ERROR + STABLE START)

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

/* ================= WEB KEEP ALIVE ================= */
const app = express();
app.get("/", (req, res) => res.send("TR10 Attendance Running ✅"));
app.get("/health", (req, res) => res.send("OK"));
app.all("*", (req, res) => res.send("OK"));
app.listen(process.env.PORT || 3000, () => console.log("🌐 Web server running"));

/* ================= ENV ================= */
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const TZ = process.env.TZ || "Asia/Riyadh";

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.log("❌ Missing ENV (TOKEN / CLIENT_ID / OWNER_ID)");
  process.exit(1);
}

/* ====== Crash Protection ====== */
process.on("unhandledRejection", (err) => console.error("❌ UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("❌ UNCAUGHT EXCEPTION:", err));

/* ================= CLIENT ================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

/* ================= DATABASE ================= */
let db;

async function initDb() {
  db = await open({
    filename: "./attendance.db",
    driver: sqlite3.Database,
  });

  await db.exec(`PRAGMA journal_mode = WAL;`);
  await db.exec(`PRAGMA busy_timeout = 5000;`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      guild_id TEXT,
      user_id TEXT,
      session_no INTEGER,
      checkin INTEGER,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS logs (
      guild_id TEXT,
      user_id TEXT,
      duration INTEGER,
      date TEXT
    );

    CREATE TABLE IF NOT EXISTS stats (
      guild_id TEXT,
      user_id TEXT,
      total_time INTEGER DEFAULT 0,
      total_entries INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT PRIMARY KEY,
      log_channel TEXT,
      auto_role TEXT,
      role_hours INTEGER DEFAULT 0
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

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/* ================= COMMANDS (FIXED: all options have descriptions) ================= */
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("إرسال لوحة الحضور"),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("عرض حالتك (داخل/خارج) ومدة الجلسة"),

    new SlashCommandBuilder()
      .setName("stats")
      .setDescription("لوحة الإحصائيات الخاصة بك"),

    new SlashCommandBuilder()
      .setName("top")
      .setDescription("عرض التوب حسب الوقت")
      .addStringOption((o) =>
        o
          .setName("range")
          .setDescription("اختر المدى")
          .setRequired(true)
          .addChoices(
            { name: "اليوم", value: "day" },
            { name: "الكل", value: "all" }
          )
      ),

    new SlashCommandBuilder()
      .setName("setlog")
      .setDescription("تحديد روم اللوق (Admin)")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("اختر روم اللوق")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("setautorole")
      .setDescription("تحديد رتبة تلقائية حسب عدد ساعات (Admin)")
      .addRoleOption((o) =>
        o
          .setName("role")
          .setDescription("اختر الرتبة")
          .setRequired(true)
      )
      .addIntegerOption((o) =>
        o
          .setName("hours")
          .setDescription("عدد الساعات المطلوبة للحصول على الرتبة")
          .setRequired(true)
          .setMinValue(1)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map((c) => c.toJSON());
}

async function registerGlobalCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: buildCommands() });
  console.log("✅ Global commands registered");
}

/* ================= PANEL ================= */
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

/* ================= LOG HELPER ================= */
async function sendLog(guild, guildId, embed) {
  try {
    const setting = await db.get("SELECT log_channel FROM settings WHERE guild_id=?", [guildId]);
    if (!setting?.log_channel) return;

    const ch = await guild.channels.fetch(setting.log_channel).catch(() => null);
    if (!ch || !ch.isTextBased()) return;

    await ch.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.log("LOG ERROR:", e);
  }
}

/* ================= INTERACTIONS ================= */
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.inGuild()) return;

    // (أمان) إذا البوت بدأ ولسه DB ما جاهز
    if (!db) return;

    if (interaction.isChatInputCommand()) {
      // عشان ما يطلع did not respond لو صار بطء
      await interaction.deferReply({ ephemeral: true }).catch(() => null);

      if (interaction.commandName === "panel") {
        // panel نبيه يطلع للكل مو ephemeral
        return interaction.editReply("✅ تم إرسال اللوحة.").then(async () => {
          await interaction.channel.send({ embeds: [panelEmbed()], components: [panelRow()] }).catch(() => {});
        });
      }

      if (interaction.commandName === "status") {
        const open = await db.get(
          "SELECT * FROM sessions WHERE guild_id=? AND user_id=?",
          [interaction.guildId, interaction.user.id]
        );

        if (!open) return interaction.editReply("📌 أنت خارج");

        return interaction.editReply(
          `📌 أنت داخل\n⏱️ ${msToHMS(Date.now() - open.checkin)}\n🔁 رقم الدخول: ${open.session_no}`
        );
      }

      if (interaction.commandName === "stats") {
        const stat = await db.get(
          "SELECT * FROM stats WHERE guild_id=? AND user_id=?",
          [interaction.guildId, interaction.user.id]
        );

        const totalTime = stat?.total_time || 0;
        const totalEntries = stat?.total_entries || 0;

        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("📊 لوحة الإحصائيات")
              .setDescription(
                `👤 <@${interaction.user.id}>\n\n⏱️ إجمالي الوقت: ${msToHMS(totalTime)}\n🔁 عدد مرات الدخول: ${totalEntries}`
              )
              .setColor(0x2b2d31),
          ],
        });
      }

      if (interaction.commandName === "top") {
        const range = interaction.options.getString("range", true);
        let rows;

        if (range === "day") {
          rows = await db.all(
            "SELECT user_id, SUM(duration) as total FROM logs WHERE guild_id=? AND date=? GROUP BY user_id ORDER BY total DESC LIMIT 10",
            [interaction.guildId, today()]
          );
        } else {
          rows = await db.all(
            "SELECT user_id, total_time as total FROM stats WHERE guild_id=? ORDER BY total DESC LIMIT 10",
            [interaction.guildId]
          );
        }

        if (!rows.length) return interaction.editReply("لا يوجد بيانات");

        const text = rows
          .map((r, i) => `${i + 1}) <@${r.user_id}> - ${msToHMS(r.total || 0)}`)
          .join("\n");

        return interaction.editReply({
          embeds: [new EmbedBuilder().setTitle("🏆 التوب").setDescription(text).setColor(0x2b2d31)],
        });
      }

      if (interaction.commandName === "setlog") {
        const ch = interaction.options.getChannel("channel", true);

        await db.run(
          "INSERT INTO settings (guild_id, log_channel) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET log_channel=excluded.log_channel",
          [interaction.guildId, ch.id]
        );

        return interaction.editReply(`✅ تم تحديد روم اللوق: <#${ch.id}>`);
      }

      if (interaction.commandName === "setautorole") {
        const role = interaction.options.getRole("role", true);
        const hours = interaction.options.getInteger("hours", true);

        await db.run(
          "INSERT INTO settings (guild_id, auto_role, role_hours) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET auto_role=excluded.auto_role, role_hours=excluded.role_hours",
          [interaction.guildId, role.id, hours]
        );

        return interaction.editReply(`✅ سيتم إعطاء الرتبة <@&${role.id}> بعد **${hours}** ساعة`);
      }

      return interaction.editReply("❓ أمر غير معروف.");
    }

    if (interaction.isButton()) {
      // رد سريع لتفادي timeout
      await interaction.deferReply({ ephemeral: true }).catch(() => null);

      const open = await db.get(
        "SELECT * FROM sessions WHERE guild_id=? AND user_id=?",
        [interaction.guildId, interaction.user.id]
      );

      if (interaction.customId === "in") {
        if (open) return interaction.editReply("⚠️ أنت داخل بالفعل");

        const row = await db.get(
          "SELECT total_entries FROM stats WHERE guild_id=? AND user_id=?",
          [interaction.guildId, interaction.user.id]
        );

        const sessionNo = (row?.total_entries || 0) + 1;

        await db.run("INSERT INTO sessions VALUES (?,?,?,?)", [
          interaction.guildId,
          interaction.user.id,
          sessionNo,
          Date.now(),
        ]);

        // LOG
        const emb = new EmbedBuilder()
          .setTitle("✅ تسجيل دخول")
          .setDescription(`👤 <@${interaction.user.id}>\n🔁 رقم الدخول: ${sessionNo}\n🗓️ ${today()}`)
          .setColor(0x00cc66);
        await sendLog(interaction.guild, interaction.guildId, emb);

        return interaction.editReply(`✅ تم تسجيل الدخول 🔁 (${sessionNo})`);
      }

      if (interaction.customId === "out") {
        if (!open) return interaction.editReply("⚠️ أنت غير مسجل دخول");

        const duration = Date.now() - open.checkin;

        await db.run("DELETE FROM sessions WHERE guild_id=? AND user_id=?", [
          interaction.guildId,
          interaction.user.id,
        ]);

        await db.run("INSERT INTO logs VALUES (?,?,?,?)", [
          interaction.guildId,
          interaction.user.id,
          duration,
          today(),
        ]);

        await db.run(
          `
          INSERT INTO stats (guild_id, user_id, total_time, total_entries)
          VALUES (?,?,?,1)
          ON CONFLICT(guild_id,user_id)
          DO UPDATE SET
            total_time = total_time + excluded.total_time,
            total_entries = total_entries + 1
        `,
          [interaction.guildId, interaction.user.id, duration]
        );

        // AUTO ROLE CHECK
        const setting = await db.get("SELECT auto_role, role_hours FROM settings WHERE guild_id=?", [
          interaction.guildId,
        ]);

        if (setting?.auto_role && setting?.role_hours) {
          const stat = await db.get("SELECT total_time FROM stats WHERE guild_id=? AND user_id=?", [
            interaction.guildId,
            interaction.user.id,
          ]);

          if ((stat?.total_time || 0) >= setting.role_hours * 3600000) {
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (member) await member.roles.add(setting.auto_role).catch(() => {});
          }
        }

        // LOG
        const emb = new EmbedBuilder()
          .setTitle("💤 تسجيل خروج")
          .setDescription(
            `👤 <@${interaction.user.id}>\n⏱️ المدة: ${msToHMS(duration)}\n🔁 رقم الدخول: ${open.session_no}\n🗓️ ${today()}`
          )
          .setColor(0xff3344);
        await sendLog(interaction.guild, interaction.guildId, emb);

        return interaction.editReply(`💤 تم تسجيل الخروج\n⏱️ ${msToHMS(duration)}`);
      }

      return interaction.editReply("زر غير معروف.");
    }
  } catch (err) {
    console.log(err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("حدث خطأ").catch(() => {});
      } else {
        await interaction.reply({ content: "حدث خطأ", ephemeral: true }).catch(() => {});
      }
    } catch {}
  }
});

/* ================= START (STABLE ORDER) ================= */
(async () => {
  await initDb(); // ✅ لازم قبل أي شيء
  await client.login(TOKEN); // ✅ يسجل دخول
})();

client.once("ready", async () => {
  console.log(`✅ Logged as ${client.user.tag}`);
  await registerGlobalCommands().catch((e) => console.log("❌ Command Register Error:", e));
});
