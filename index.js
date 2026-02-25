// ==================================================
// 🔥 TR10 NUCLEAR ULTIMATE
// PART 1 — CORE + DATABASE + LEVEL SYSTEM
// ==================================================

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

const express = require("express");
const cron = require("node-cron");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

// ================== ENV ==================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID; // حط ايديك في المتغيرات
const TZ = "Asia/Riyadh";
const PORT = process.env.PORT || 3000;

// ================== WEB KEEP ALIVE ==================
const app = express();
app.get("/", (req, res) => res.send("🔥 TR10 NUCLEAR ONLINE 🔥"));
app.listen(PORT);

// ================== CLIENT ==================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

// ================== DATABASE ==================
let db;

async function initDB() {
  db = await open({
    filename: "./nuclear.sqlite",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      guild_id TEXT,
      user_id TEXT,
      text_total INTEGER DEFAULT 0,
      voice_total INTEGER DEFAULT 0,
      text_day INTEGER DEFAULT 0,
      voice_day INTEGER DEFAULT 0,
      text_week INTEGER DEFAULT 0,
      voice_week INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0,
      msg_bucket INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT PRIMARY KEY,
      congrats_channel TEXT,
      congrats_message TEXT
    );

    CREATE TABLE IF NOT EXISTS level_roles (
      guild_id TEXT,
      level INTEGER,
      role_id TEXT,
      PRIMARY KEY (guild_id, level)
    );
  `);
}

async function ensureUser(gid, uid) {
  await db.run(
    `INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)`,
    [gid, uid]
  );
  return db.get(`SELECT * FROM users WHERE guild_id=? AND user_id=?`, [gid, uid]);
}

// ================== LEVEL SYSTEM ==================
function requiredXP(level) {
  return 200 + (level * 80) + Math.floor(level * level * 10);
}

async function checkLevel(guild, member) {
  const row = await ensureUser(guild.id, member.id);
  let total = row.text_total + row.voice_total;
  let newLevel = row.level;

  while (total >= requiredXP(newLevel)) newLevel++;

  if (newLevel > row.level) {
    await db.run(
      `UPDATE users SET level=? WHERE guild_id=? AND user_id=?`,
      [newLevel, guild.id, member.id]
    );

    const roles = await db.all(
      `SELECT level, role_id FROM level_roles WHERE guild_id=?`,
      [guild.id]
    );

    for (const r of roles) {
      if (newLevel >= r.level) {
        const role = guild.roles.cache.get(r.role_id);
        if (role && !member.roles.cache.has(role.id)) {
          await member.roles.add(role).catch(() => {});
        }
      }
    }

    const settings = await db.get(
      `SELECT * FROM settings WHERE guild_id=?`,
      [guild.id]
    );

    if (settings?.congrats_channel) {
      const ch = guild.channels.cache.get(settings.congrats_channel);
      if (ch) {
        const msg =
          (settings.congrats_message || "🎉 مبروك {user} وصلت لفل {level}")
            .replaceAll("{user}", `<@${member.id}>`)
            .replaceAll("{level}", newLevel);
        ch.send(msg).catch(() => {});
      }
    }
  }
}

// ==================================================
// 🔥 XP SYSTEM
// ==================================================

// كل 5 رسائل = 3 XP كتابي
client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const row = await ensureUser(msg.guild.id, msg.author.id);
  const bucket = row.msg_bucket + 1;

  await db.run(
    `UPDATE users SET msg_bucket=? WHERE guild_id=? AND user_id=?`,
    [bucket, msg.guild.id, msg.author.id]
  );

  if (bucket >= 5) {
    await db.run(
      `UPDATE users
       SET msg_bucket=0,
           text_total=text_total+3,
           text_day=text_day+3,
           text_week=text_week+3
       WHERE guild_id=? AND user_id=?`,
      [msg.guild.id, msg.author.id]
    );

    const member = await msg.guild.members.fetch(msg.author.id);
    await checkLevel(msg.guild, member);
  }
});

// كل 5 دقائق = 10 XP صوتي (حتى لو المايك مقفل)
async function voiceTick() {
  for (const guild of client.guilds.cache.values()) {
    guild.channels.cache.forEach(async (ch) => {
      if (!ch.isVoiceBased()) return;

      for (const [id, member] of ch.members) {
        if (member.user.bot) continue;

        await ensureUser(guild.id, id);

        await db.run(
          `UPDATE users
           SET voice_total=voice_total+10,
               voice_day=voice_day+10,
               voice_week=voice_week+10
           WHERE guild_id=? AND user_id=?`,
          [guild.id, id]
        );

        await checkLevel(guild, member);
      }
    });
  }
}

setInterval(voiceTick, 5 * 60 * 1000);

// ==================================================
// 🔥 RESET SYSTEM (سعودي)
// ==================================================

cron.schedule("0 1 * * *", async () => {
  await db.run(`UPDATE users SET text_day=0, voice_day=0`);
}, { timezone: TZ });

cron.schedule("0 23 * * 6", async () => {
  await db.run(`UPDATE users SET text_week=0, voice_week=0`);
}, { timezone: TZ });

// ==================================================
(async () => {
  if (!TOKEN || !CLIENT_ID) {
    console.log("❌ حط TOKEN و CLIENT_ID في Environment Variables");
    process.exit(1);
  }

  await initDB();
  await client.login(TOKEN);
})();// ==================================================
// 🔥 COMMANDS BUILDER
// ==================================================

function buildCommands() {
  return [

    new SlashCommandBuilder()
      .setName("help")
      .setDescription("عرض جميع أوامر البوت"),

    new SlashCommandBuilder()
      .setName("rank")
      .setDescription("عرض لفلك"),

    new SlashCommandBuilder()
      .setName("top")
      .setDescription("التوب")
      .addStringOption(o =>
        o.setName("type")
          .setDescription("نوع التوب")
          .setRequired(true)
          .addChoices(
            { name: "الكل", value: "all" },
            { name: "كتابي", value: "text" },
            { name: "صوتي", value: "voice" }
          )
      ),

    new SlashCommandBuilder()
      .setName("set-congrats")
      .setDescription("تحديد روم التبريكات")
      .addChannelOption(o =>
        o.setName("channel").setDescription("الروم").setRequired(true)
      )
      .addStringOption(o =>
        o.setName("message")
          .setDescription("رسالة التبريك (استخدم {user} و {level})")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("set-level-role")
      .setDescription("ربط رتبة بلفل معين")
      .addIntegerOption(o =>
        o.setName("level").setDescription("رقم اللفل").setRequired(true)
      )
      .addRoleOption(o =>
        o.setName("role").setDescription("اختر الرتبة").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("lock")
      .setDescription("قفل الروم الحالي"),

    new SlashCommandBuilder()
      .setName("unlock")
      .setDescription("فتح الروم الحالي"),

    new SlashCommandBuilder()
      .setName("owner-reset-user")
      .setDescription("تصفير عضو كامل (أونر فقط)")
      .addUserOption(o =>
        o.setName("user").setDescription("اختر العضو").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("owner-reset-guild")
      .setDescription("تصفير السيرفر كامل (أونر فقط)"),

    new SlashCommandBuilder()
      .setName("owner-sync")
      .setDescription("حذف الأوامر القديمة وتحديثها (أونر فقط)")

  ].map(c => c.toJSON());
}

// ==================================================
// 🔥 REGISTER COMMANDS
// ==================================================

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: buildCommands() }
  );

  console.log("🔥 Global commands registered");
}

// ==================================================
// 🔥 INTERACTIONS
// ==================================================

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  const gid = i.guild.id;

  // ================= HELP =================
  if (i.commandName === "help") {
    return i.reply(`
🔥 TR10 NUCLEAR 🔥

/rank — عرض لفلك
/top — عرض التوب
/lock — قفل الروم
/unlock — فتح الروم
/set-congrats — روم تبريك
/set-level-role — ربط رتبة بلفل

👑 أوامر الأونر:
owner-reset-user
owner-reset-guild
owner-sync
`);
  }

  // ================= RANK =================
  if (i.commandName === "rank") {
    const row = await ensureUser(gid, i.user.id);
    return i.reply(`
👤 <@${i.user.id}>
📊 لفل: ${row.level}
💬 كتابي: ${row.text_total}
🎤 صوتي: ${row.voice_total}
`);
  }

  // ================= TOP =================
  if (i.commandName === "top") {
    const type = i.options.getString("type");

    let order = "text_total + voice_total";
    if (type === "text") order = "text_total";
    if (type === "voice") order = "voice_total";

    const rows = await db.all(
      `SELECT * FROM users WHERE guild_id=? ORDER BY ${order} DESC LIMIT 10`,
      [gid]
    );

    let msg = "🏆 التوب:\n";
    rows.forEach((r, index) => {
      msg += `${index + 1}- <@${r.user_id}> | لفل ${r.level}\n`;
    });

    return i.reply(msg);
  }

  // ================= LOCK =================
  if (i.commandName === "lock") {
    if (!i.member.permissions.has(PermissionsBitField.Flags.ManageChannels))
      return i.reply({ content: "❌ ماعندك صلاحية", ephemeral: true });

    await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, {
      SendMessages: false,
    });

    return i.reply("🔒 تم القفل");
  }

  // ================= UNLOCK =================
  if (i.commandName === "unlock") {
    if (!i.member.permissions.has(PermissionsBitField.Flags.ManageChannels))
      return i.reply({ content: "❌ ماعندك صلاحية", ephemeral: true });

    await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, {
      SendMessages: true,
    });

    return i.reply("🔓 تم الفتح");
  }

  // ================= SET CONGRATS =================
  if (i.commandName === "set-congrats") {
    if (!i.member.permissions.has(PermissionsBitField.Flags.Administrator))
      return i.reply({ content: "❌ تحتاج ادمن", ephemeral: true });

    const channel = i.options.getChannel("channel");
    const message = i.options.getString("message");

    await db.run(
      `INSERT OR REPLACE INTO settings (guild_id, congrats_channel, congrats_message)
       VALUES (?, ?, ?)`,
      [gid, channel.id, message]
    );

    return i.reply("✅ تم تحديد روم التبريك");
  }

  // ================= SET LEVEL ROLE =================
  if (i.commandName === "set-level-role") {
    if (!i.member.permissions.has(PermissionsBitField.Flags.Administrator))
      return i.reply({ content: "❌ تحتاج ادمن", ephemeral: true });

    const level = i.options.getInteger("level");
    const role = i.options.getRole("role");

    await db.run(
      `INSERT OR REPLACE INTO level_roles (guild_id, level, role_id)
       VALUES (?, ?, ?)`,
      [gid, level, role.id]
    );

    return i.reply("🎖 تم ربط الرتبة");
  }

  // ================= OWNER CHECK =================
  if (
    ["owner-reset-user", "owner-reset-guild", "owner-sync"]
      .includes(i.commandName)
      && i.user.id !== OWNER_ID
  ) {
    return i.reply({ content: "❌ هذا أمر أونر فقط", ephemeral: true });
  }

  if (i.commandName === "owner-reset-user") {
    const user = i.options.getUser("user");
    await db.run(
      `DELETE FROM users WHERE guild_id=? AND user_id=?`,
      [gid, user.id]
    );
    return i.reply("🧹 تم تصفير العضو");
  }

  if (i.commandName === "owner-reset-guild") {
    await db.run(`DELETE FROM users WHERE guild_id=?`, [gid]);
    return i.reply("💥 تم تصفير السيرفر كامل");
  }

  if (i.commandName === "owner-sync") {
    await registerCommands();
    return i.reply("♻ تم حذف الأوامر القديمة وتحديثها");
  }

});

// ==================================================
client.once("ready", async () => {
  console.log(`🔥 Logged in as ${client.user.tag}`);
  await registerCommands();
});// ==================================================
// 🔥 LEVEL UP SYSTEM + AUTO ROLE + CONGRATS
// ==================================================

const xpCooldown = new Set();
const voiceTracker = new Map();

// ============ XP FROM TEXT ============
client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const key = `${msg.guild.id}-${msg.author.id}`;
  if (xpCooldown.has(key)) return;

  xpCooldown.add(key);
  setTimeout(() => xpCooldown.delete(key), 15000);

  const row = await ensureUser(msg.guild.id, msg.author.id);

  let xpGain = 5 + Math.floor(Math.random() * 6);
  row.text_xp += xpGain;
  row.text_total += xpGain;

  let needed = row.level * 100;

  if (row.text_xp >= needed) {
    row.level++;
    row.text_xp = 0;

    await levelUp(msg.guild, msg.member, row.level);
  }

  await db.run(
    `UPDATE users SET level=?, text_xp=?, text_total=? 
     WHERE guild_id=? AND user_id=?`,
    [row.level, row.text_xp, row.text_total, msg.guild.id, msg.author.id]
  );
});

// ============ XP FROM VOICE ============
client.on("voiceStateUpdate", async (oldState, newState) => {
  if (!newState.guild) return;

  const userId = newState.id;
  const guildId = newState.guild.id;

  if (!oldState.channelId && newState.channelId) {
    voiceTracker.set(userId, Date.now());
  }

  if (oldState.channelId && !newState.channelId) {
    const joinTime = voiceTracker.get(userId);
    if (!joinTime) return;

    const minutes = Math.floor((Date.now() - joinTime) / 60000);
    voiceTracker.delete(userId);

    if (minutes < 1) return;

    const row = await ensureUser(guildId, userId);

    let xpGain = minutes * 3;
    row.voice_total += xpGain;

    await db.run(
      `UPDATE users SET voice_total=? 
       WHERE guild_id=? AND user_id=?`,
      [row.voice_total, guildId, userId]
    );
  }
});

// ============ LEVEL UP FUNCTION ============
async function levelUp(guild, member, level) {

  // 🎖 اعطاء رتبة
  const roleRow = await db.get(
    `SELECT role_id FROM level_roles 
     WHERE guild_id=? AND level=?`,
    [guild.id, level]
  );

  if (roleRow) {
    const role = guild.roles.cache.get(roleRow.role_id);
    if (role) await member.roles.add(role).catch(() => {});
  }

  // 🎉 رسالة تبريك
  const settings = await db.get(
    `SELECT congrats_channel, congrats_message 
     FROM settings WHERE guild_id=?`,
    [guild.id]
  );

  if (settings && settings.congrats_channel) {
    const channel = guild.channels.cache.get(settings.congrats_channel);
    if (channel) {
      let msg = settings.congrats_message
        .replace("{user}", `<@${member.id}>`)
        .replace("{level}", level);

      channel.send(msg).catch(() => {});
    }
  }
    }
