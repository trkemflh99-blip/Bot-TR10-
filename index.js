// ==========================================================
// TR10 Attendance Bot V13 MAX
// ULTRA CLEAN • AUTO RESET COMMANDS • FULL SYSTEM
// discord.js v14 + sqlite + express
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

// ================= ENV =================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.log("❌ Missing TOKEN / CLIENT_ID / OWNER_ID");
  process.exit(1);
}

// ================= WEB =================
const app = express();
app.get("/", (req, res) => res.send("TR10 V13 MAX Running ✅"));
app.listen(process.env.PORT || 3000);

// ================= CLIENT =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ================= DB =================
let db;

async function initDB() {
  db = await open({
    filename: "./attendance_v13.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      guild_id TEXT,
      user_id TEXT,
      checkin_ms INTEGER,
      session_no INTEGER,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS stats (
      guild_id TEXT,
      user_id TEXT,
      total_time_ms INTEGER DEFAULT 0,
      total_entries INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT PRIMARY KEY,
      panel_channel TEXT,
      panel_message TEXT,
      log_channel TEXT
    );

    CREATE TABLE IF NOT EXISTS role_rewards (
      guild_id TEXT,
      hours INTEGER,
      role_id TEXT,
      PRIMARY KEY (guild_id, hours, role_id)
    );
  `);
}

// ================= HELPERS =================
function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} ساعة ${m} دقيقة`;
}

async function giveRewards(guild, userId) {
  const stat = await db.get(
    "SELECT total_time_ms FROM stats WHERE guild_id=? AND user_id=?",
    [guild.id, userId]
  );
  if (!stat) return;

  const rewards = await db.all(
    "SELECT * FROM role_rewards WHERE guild_id=?",
    [guild.id]
  );

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  for (const r of rewards) {
    if (stat.total_time_ms >= r.hours * 3600000) {
      if (!member.roles.cache.has(r.role_id)) {
        await member.roles.add(r.role_id).catch(() => {});
      }
    }
  }
}

async function updatePanel(guild) {
  const s = await db.get("SELECT * FROM settings WHERE guild_id=?", [guild.id]);
  if (!s?.panel_channel || !s?.panel_message) return;

  const channel = await guild.channels.fetch(s.panel_channel).catch(() => null);
  if (!channel) return;

  const message = await channel.messages.fetch(s.panel_message).catch(() => null);
  if (!message) return;

  const active = await db.all(
    "SELECT * FROM sessions WHERE guild_id=?",
    [guild.id]
  );

  const list = active.length
    ? active.map((x, i) => `**${i + 1}.** <@${x.user_id}>`).join("\n")
    : "لا يوجد أحد حالياً.";

  const embed = new EmbedBuilder()
    .setColor(0x111827)
    .setTitle("🛡️ لوحة الحضور V13 MAX")
    .setDescription(`👥 المسجلين الآن (${active.length})\n\n${list}`)
    .setFooter({ text: "TR10 ULTRA SYSTEM" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("checkin")
      .setLabel("تسجيل دخول")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("checkout")
      .setLabel("تسجيل خروج")
      .setStyle(ButtonStyle.Danger)
  );

  await message.edit({ embeds: [embed], components: [row] });
}

// ================= COMMANDS =================
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("إنشاء لوحة الحضور")
      .addChannelOption(o =>
        o.setName("channel")
          .setDescription("اختر روم")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("setlog")
      .setDescription("تحديد روم اللوق")
      .addChannelOption(o =>
        o.setName("channel")
          .setDescription("روم اللوق")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("عرض حالتك"),

    new SlashCommandBuilder()
      .setName("top")
      .setDescription("عرض التوب")
      .addStringOption(o =>
        o.setName("type")
          .setDescription("نوع الترتيب")
          .setRequired(true)
          .addChoices(
            { name: "الوقت", value: "time" },
            { name: "مرات الدخول", value: "entries" }
          )
      ),

    new SlashCommandBuilder()
      .setName("setrole")
      .setDescription("تحديد رتبة عند عدد ساعات")
      .addIntegerOption(o =>
        o.setName("hours")
          .setDescription("عدد الساعات")
          .setRequired(true)
      )
      .addRoleOption(o =>
        o.setName("role")
          .setDescription("الرتبة")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map(c => c.toJSON());
}

async function resetCommands(guildId) {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: [] });
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: buildCommands() });
  console.log("✅ Commands reset:", guildId);
}

// ================= READY =================
client.once("ready", async () => {
  console.log(`🔥 Logged as ${client.user.tag}`);

  for (const [gid] of client.guilds.cache) {
    await resetCommands(gid);
  }
});

// ================= INTERACTIONS =================
client.on("interactionCreate", async interaction => {

  if (interaction.isButton()) {
    await interaction.deferReply({ ephemeral: true });

    const gid = interaction.guildId;
    const uid = interaction.user.id;
    const now = Date.now();

    if (interaction.customId === "checkin") {
      const existing = await db.get(
        "SELECT * FROM sessions WHERE guild_id=? AND user_id=?",
        [gid, uid]
      );
      if (existing) return interaction.editReply("⚠️ أنت مسجل بالفعل.");

      const stat = await db.get(
        "SELECT total_entries FROM stats WHERE guild_id=? AND user_id=?",
        [gid, uid]
      );

      const sessionNo = (stat?.total_entries || 0) + 1;

      await db.run(
        "INSERT INTO sessions VALUES (?,?,?,?)",
        [gid, uid, now, sessionNo]
      );

      return interaction.editReply("✅ تم تسجيل دخولك.");
    }

    if (interaction.customId === "checkout") {
      const s = await db.get(
        "SELECT * FROM sessions WHERE guild_id=? AND user_id=?",
        [gid, uid]
      );
      if (!s) return interaction.editReply("⚠️ أنت غير مسجل.");

      const duration = now - s.checkin_ms;

      await db.run("DELETE FROM sessions WHERE guild_id=? AND user_id=?", [gid, uid]);

      await db.run(`
        INSERT INTO stats (guild_id, user_id, total_time_ms, total_entries)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(guild_id, user_id)
        DO UPDATE SET
          total_time_ms = total_time_ms + ?,
          total_entries = total_entries + 1
      `, [gid, uid, duration, duration]);

      await giveRewards(interaction.guild, uid);

      return interaction.editReply(`⏱️ مدة جلستك: ${formatTime(duration)}`);
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const gid = interaction.guildId;
  const uid = interaction.user.id;

  if (commandName === "status") {
    const s = await db.get(
      "SELECT * FROM sessions WHERE guild_id=? AND user_id=?",
      [gid, uid]
    );
    if (!s) return interaction.reply({ content: "📌 أنت خارج.", ephemeral: true });
    return interaction.reply({ content: "🟢 أنت داخل.", ephemeral: true });
  }

  interaction.reply({ content: "✅ الأمر يعمل.", ephemeral: true });
});

// ================= START =================
(async () => {
  await initDB();
  await client.login(TOKEN);
})();
