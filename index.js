// ==========================================================
// TR10 TITANIUM CORE v1
// Global Auto Sync + Auto Wipe Old Commands
// Stable • Clean • No XP • No Validation Errors
// ==========================================================

require("dotenv").config();
const express = require("express");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

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

// ================= ENV =================
const TOKEN = process.env.TOKEN || "";
const CLIENT_ID = process.env.CLIENT_ID || "";
const OWNER_ID = process.env.OWNER_ID || "";

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.log("❌ Missing ENV (TOKEN / CLIENT_ID / OWNER_ID)");
  process.exit(1);
}

// ================= KEEP ALIVE =================
const app = express();
app.get("/", (_, res) => res.send("TR10 TITANIUM RUNNING"));
app.get("/health", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000);

// ================= CLIENT =================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ================= DB =================
let db;

async function initDB() {
  db = await open({
    filename: "./titanium.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
  CREATE TABLE IF NOT EXISTS settings(
    guild_id TEXT PRIMARY KEY,
    log_channel TEXT,
    panel_channel TEXT,
    panel_message TEXT,
    locked INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions(
    guild_id TEXT,
    user_id TEXT,
    checkin INTEGER,
    PRIMARY KEY(guild_id,user_id)
  );

  CREATE TABLE IF NOT EXISTS stats(
    guild_id TEXT,
    user_id TEXT,
    total_time INTEGER DEFAULT 0,
    total_entries INTEGER DEFAULT 0,
    PRIMARY KEY(guild_id,user_id)
  );

  CREATE TABLE IF NOT EXISTS logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    user_id TEXT,
    action TEXT,
    duration INTEGER,
    at INTEGER
  );
  `);
}

// ================= HELPERS =================
function now() {
  return Date.now();
}

function msToHM(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} ساعة ${m} دقيقة`;
}

// ================= PANEL =================
function buttons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("checkin")
      .setLabel("تسجيل دخول")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("checkout")
      .setLabel("تسجيل خروج")
      .setStyle(ButtonStyle.Danger)
  );
}

async function buildPanel(guildId) {
  const rows = await db.all(
    "SELECT user_id FROM sessions WHERE guild_id=?",
    [guildId]
  );

  const list =
    rows.length > 0
      ? rows.map(r => `<@${r.user_id}>`).join("\n")
      : "لا يوجد أحد حالياً";

  return new EmbedBuilder()
    .setColor(0x111827)
    .setTitle("🛡️ نظام الحضور الرسمي")
    .setDescription(
      "اضغط لتسجيل الدخول أو الخروج\n\n" +
      "━━━━━━━━━━━━━━━━━━\n" +
      "👥 المسجلين حالياً:\n\n" +
      list +
      "\n━━━━━━━━━━━━━━━━━━"
    )
    .setFooter({ text: "TR10 TITANIUM" });
}

async function updatePanel(guild) {
  const s = await db.get("SELECT * FROM settings WHERE guild_id=?", [guild.id]);
  if (!s?.panel_channel || !s?.panel_message) return;

  const ch = await guild.channels.fetch(s.panel_channel).catch(() => null);
  if (!ch) return;

  const msg = await ch.messages.fetch(s.panel_message).catch(() => null);
  if (!msg) return;

  const embed = await buildPanel(guild.id);
  await msg.edit({ embeds: [embed], components: [buttons()] });
}

// ================= COMMANDS =================
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("إنشاء لوحة الحضور")
      .addChannelOption(o =>
        o.setName("channel")
         .setDescription("الروم")
         .addChannelTypes(ChannelType.GuildText)
         .setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("setlog")
      .setDescription("تحديد روم اللوق")
      .addChannelOption(o =>
        o.setName("channel")
         .setDescription("الروم")
         .addChannelTypes(ChannelType.GuildText)
         .setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("top")
      .setDescription("عرض التوب")
      .addStringOption(o =>
        o.setName("type")
         .setDescription("نوع الترتيب")
         .setRequired(true)
         .addChoices(
           { name: "الوقت", value: "time" },
           { name: "الدخول", value: "entries" }
         )),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("عرض حالتك الحالية"),

    new SlashCommandBuilder()
      .setName("lock")
      .setDescription("قفل النظام")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("unlock")
      .setDescription("فتح النظام")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("wipecommands")
      .setDescription("OWNER: حذف جميع الأوامر")
  ].map(c => c.toJSON());
}

// ================= AUTO GLOBAL WIPE + REGISTER =================
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  console.log("🧹 Wiping old commands...");
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });

  console.log("🚀 Registering new commands...");
  await rest.put(Routes.applicationCommands(CLIENT_ID), {
    body: buildCommands(),
  });

  console.log("✅ Commands ready globally");
}

// ================= READY =================
client.once("ready", async () => {
  console.log(`🔥 Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ================= INTERACTIONS =================
client.on("interactionCreate", async interaction => {

  if (!interaction.inGuild()) return;

  const guildId = interaction.guildId;

  try {

    if (interaction.isChatInputCommand()) {

      if (interaction.commandName === "wipecommands") {
        if (interaction.user.id !== OWNER_ID)
          return interaction.reply({ content: "للأونر فقط", ephemeral: true });

        const rest = new REST({ version: "10" }).setToken(TOKEN);
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });

        return interaction.reply("تم حذف جميع الأوامر");
      }

      if (interaction.commandName === "panel") {
        const ch = interaction.options.getChannel("channel");
        const embed = await buildPanel(guildId);
        const msg = await ch.send({ embeds: [embed], components: [buttons()] });

        await db.run(
          "INSERT OR REPLACE INTO settings(guild_id,panel_channel,panel_message) VALUES(?,?,?)",
          [guildId, ch.id, msg.id]
        );

        return interaction.reply({ content: "تم إنشاء البانل", ephemeral: true });
      }

      if (interaction.commandName === "status") {
        const open = await db.get(
          "SELECT * FROM sessions WHERE guild_id=? AND user_id=?",
          [guildId, interaction.user.id]
        );
        if (!open)
          return interaction.reply({ content: "أنت خارج حالياً", ephemeral: true });

        return interaction.reply({ content: "أنت مسجل دخول", ephemeral: true });
      }

    }

    if (interaction.isButton()) {

      await interaction.deferReply({ ephemeral: true });

      const open = await db.get(
        "SELECT * FROM sessions WHERE guild_id=? AND user_id=?",
        [guildId, interaction.user.id]
      );

      if (interaction.customId === "checkin") {

        if (open)
          return interaction.editReply("أنت مسجل مسبقاً");

        await db.run(
          "INSERT INTO sessions VALUES(?,?,?)",
          [guildId, interaction.user.id, now()]
        );

        await updatePanel(interaction.guild);
        return interaction.editReply("تم تسجيل دخولك");
      }

      if (interaction.customId === "checkout") {

        if (!open)
          return interaction.editReply("أنت غير مسجل");

        const duration = now() - open.checkin;

        await db.run(
          "DELETE FROM sessions WHERE guild_id=? AND user_id=?",
          [guildId, interaction.user.id]
        );

        await db.run(`
          INSERT INTO stats(guild_id,user_id,total_time,total_entries)
          VALUES(?,?,?,1)
          ON CONFLICT(guild_id,user_id)
          DO UPDATE SET
          total_time=total_time+?,
          total_entries=total_entries+1
        `, [guildId, interaction.user.id, duration, duration]);

        await updatePanel(interaction.guild);
        return interaction.editReply("تم تسجيل خروجك");
      }

    }

  } catch (err) {
    console.error(err);
    if (!interaction.replied)
      interaction.reply({ content: "حدث خطأ", ephemeral: true }).catch(()=>{});
  }

});

// ================= START =================
(async () => {
  await initDB();
  client.login(TOKEN);
})();
