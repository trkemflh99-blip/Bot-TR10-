/**
 * TR10 ULTIMATE CORE
 * Stable Base - No Syntax Errors
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder
} = require("discord.js");

const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const cron = require("node-cron");

// ================= ENV =================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID || "910264482444480562";
const TZ = "Asia/Riyadh";

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ Missing TOKEN or CLIENT_ID");
  process.exit(1);
}

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

// ================= DATABASE =================
let db;

async function initDB() {
  db = await open({
    filename: "./tr10.sqlite",
    driver: sqlite3.Database
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
      level INTEGER DEFAULT 1,
      msg_bucket INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT PRIMARY KEY,
      congrats_channel TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS level_roles (
      guild_id TEXT,
      level INTEGER,
      role_id TEXT,
      PRIMARY KEY (guild_id, level)
    );

    CREATE TABLE IF NOT EXISTS autoreplies (
      guild_id TEXT,
      trigger TEXT,
      reply TEXT,
      PRIMARY KEY (guild_id, trigger)
    );
  `);

  console.log("✅ Database Ready");
}

async function ensureUser(gid, uid) {
  let row = await db.get(
    `SELECT * FROM users WHERE guild_id=? AND user_id=?`,
    [gid, uid]
  );

  if (!row) {
    await db.run(
      `INSERT INTO users (guild_id, user_id) VALUES (?, ?)`,
      [gid, uid]
    );

    row = await db.get(
      `SELECT * FROM users WHERE guild_id=? AND user_id=?`,
      [gid, uid]
    );
  }

  return row;
}

async function ensureSettings(gid) {
  let row = await db.get(
    `SELECT * FROM settings WHERE guild_id=?`,
    [gid]
  );

  if (!row) {
    await db.run(
      `INSERT INTO settings (guild_id) VALUES (?)`,
      [gid]
    );

    row = await db.get(
      `SELECT * FROM settings WHERE guild_id=?`,
      [gid]
    );
  }

  return row;
}// ================= LEVEL SYSTEM =================

function requiredXP(level) {
  return 150 + (level * 75);
}

async function checkLevelUp(guild, userId) {
  const row = await ensureUser(guild.id, userId);
  const total = row.text_total + row.voice_total;

  let newLevel = row.level;
  while (total >= requiredXP(newLevel)) {
    newLevel++;
  }

  if (newLevel > row.level) {
    await db.run(
      `UPDATE users SET level=? WHERE guild_id=? AND user_id=?`,
      [newLevel, guild.id, userId]
    );

    // Give level roles
    const roles = await db.all(
      `SELECT level, role_id FROM level_roles WHERE guild_id=?`,
      [guild.id]
    );

    for (const r of roles) {
      if (newLevel >= r.level) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && !member.roles.cache.has(r.role_id)) {
          await member.roles.add(r.role_id).catch(() => {});
        }
      }
    }

    // Congrats channel
    const settings = await ensureSettings(guild.id);
    if (settings.congrats_channel) {
      const ch = guild.channels.cache.get(settings.congrats_channel);
      if (ch) {
        ch.send(`🎉 <@${userId}> وصل لفل **${newLevel}** 🔥`).catch(() => {});
      }
    }
  }
}

// ================= TEXT XP =================

client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;

    const gid = msg.guild.id;
    const uid = msg.author.id;

    const row = await ensureUser(gid, uid);

    const bucket = row.msg_bucket + 1;

    await db.run(
      `UPDATE users SET msg_bucket=? WHERE guild_id=? AND user_id=?`,
      [bucket, gid, uid]
    );

    if (bucket >= 5) {
      await db.run(
        `UPDATE users
         SET msg_bucket=0,
             text_total=text_total+3,
             text_day=text_day+3,
             text_week=text_week+3
         WHERE guild_id=? AND user_id=?`,
        [gid, uid]
      );

      await checkLevelUp(msg.guild, uid);
    }

  } catch (e) {
    console.log("message error:", e?.message);
  }
});

// ================= VOICE XP =================

const voiceMap = new Map();

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const member = newState.member;
    if (!member || member.user.bot) return;

    const gid = member.guild.id;
    const uid = member.id;
    const key = `${gid}_${uid}`;

    if (!oldState.channelId && newState.channelId) {
      if (voiceMap.has(key)) return;

      const interval = setInterval(async () => {
        const guild = client.guilds.cache.get(gid);
        const m = guild?.members.cache.get(uid);
        if (!m?.voice?.channelId) {
          clearInterval(interval);
          voiceMap.delete(key);
          return;
        }

        await ensureUser(gid, uid);

        await db.run(
          `UPDATE users
           SET voice_total=voice_total+10,
               voice_day=voice_day+10,
               voice_week=voice_week+10
           WHERE guild_id=? AND user_id=?`,
          [gid, uid]
        );

        await checkLevelUp(guild, uid);

      }, 5 * 60 * 1000); // كل 5 دقائق

      voiceMap.set(key, interval);
    }

    if (oldState.channelId && !newState.channelId) {
      const interval = voiceMap.get(key);
      if (interval) clearInterval(interval);
      voiceMap.delete(key);
    }

  } catch (e) {
    console.log("voice error:", e?.message);
  }
});

// ================= RESETS =================

// يومي الساعة 1 صباحاً
cron.schedule("0 1 * * *", async () => {
  await db.run(`UPDATE users SET text_day=0, voice_day=0`);
  console.log("🕐 Daily reset done");
}, { timezone: TZ });

// أسبوعي السبت الساعة 11 مساء
cron.schedule("0 23 * * 6", async () => {
  await db.run(`UPDATE users SET text_week=0, voice_week=0`);
  console.log("🗓 Weekly reset done");
}, { timezone: TZ });// ================= REGISTER SLASH COMMANDS =================

async function registerCommands() {
  const commands = [

    // ===== عامة =====
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("عرض جميع الأوامر"),

    new SlashCommandBuilder()
      .setName("rank")
      .setDescription("عرض مستواك")
      .addUserOption(o =>
        o.setName("user")
         .setDescription("شخص آخر")
         .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("top")
      .setDescription("أفضل 10 أعضاء"),

    // ===== إدارية =====
    new SlashCommandBuilder()
      .setName("set-congrats")
      .setDescription("تحديد روم التبريك")
      .addChannelOption(o =>
        o.setName("channel")
         .setDescription("الروم")
         .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("set-level-role")
      .setDescription("إضافة رتبة لفل")
      .addIntegerOption(o =>
        o.setName("level")
         .setDescription("رقم اللفل")
         .setRequired(true)
      )
      .addRoleOption(o =>
        o.setName("role")
         .setDescription("الرتبة")
         .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("lock")
      .setDescription("قفل الروم"),

    new SlashCommandBuilder()
      .setName("unlock")
      .setDescription("فتح الروم"),

    // ===== OWNER =====
    new SlashCommandBuilder()
      .setName("owner-sync")
      .setDescription("إعادة مزامنة الأوامر"),

    new SlashCommandBuilder()
      .setName("owner-reset-guild")
      .setDescription("تصفير السيرفر بالكامل"),

    new SlashCommandBuilder()
      .setName("owner-reset-user")
      .setDescription("تصفير عضو")
      .addUserOption(o =>
        o.setName("user")
         .setDescription("العضو")
         .setRequired(true)
      ),

  ].map(c => c.toJSON());

  await client.application.commands.set(commands);
  console.log("🔥 Global Commands Synced");
}// ================= INTERACTIONS =================

client.on("interactionCreate", async (i) => {
  try {
    if (!i.isChatInputCommand()) return;

    await i.deferReply();

    const gid = i.guildId;
    const isOwner = i.user.id === OWNER_ID;

    // ===== HELP =====
    if (i.commandName === "help") {
      return i.editReply(
`🔥 **TR10 NUCLEAR**

👑 عامة:
• /rank
• /top

🛠 إدارية:
• /set-congrats
• /set-level-role
• /lock
• /unlock

⚡ Owner:
• /owner-sync
• /owner-reset-guild
• /owner-reset-user`
      );
    }

    // ===== RANK =====
    if (i.commandName === "rank") {
      const user = i.options.getUser("user") || i.user;
      const row = await ensureUser(gid, user.id);

      const total = row.text_total + row.voice_total;
      const next = requiredXP(row.level);

      return i.editReply(
`👑 **TR10 RANK**

👤 ${user}

📖 الكتابي: ${row.text_total} XP
🎤 الصوتي: ${row.voice_total} XP
🏆 الإجمالي: ${total} XP
🎖 اللفل: ${row.level}
⏭ القادم عند: ${next} XP`
      );
    }

    // ===== TOP =====
    if (i.commandName === "top") {
      const rows = await db.all(
        `SELECT user_id, (text_total + voice_total) as total
         FROM users
         WHERE guild_id=?
         ORDER BY total DESC
         LIMIT 10`,
        [gid]
      );

      if (!rows.length) return i.editReply("لا يوجد بيانات.");

      let text = "🏆 **أفضل 10 أعضاء**\n\n";
      rows.forEach((r, idx) => {
        text += `#${idx+1} <@${r.user_id}> — ${r.total} XP\n`;
      });

      return i.editReply(text);
    }

    // ===== LOCK =====
    if (i.commandName === "lock") {
      await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, {
        SendMessages: false
      });
      return i.editReply("🔒 تم القفل");
    }

    // ===== UNLOCK =====
    if (i.commandName === "unlock") {
      await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, {
        SendMessages: true
      });
      return i.editReply("🔓 تم الفتح");
    }

    // ===== SET CONGRATS =====
    if (i.commandName === "set-congrats") {
      const ch = i.options.getChannel("channel");
      await db.run(
        `UPDATE settings SET congrats_channel=? WHERE guild_id=?`,
        [ch.id, gid]
      );
      return i.editReply("✅ تم تحديد روم التبريك");
    }

    // ===== SET LEVEL ROLE =====
    if (i.commandName === "set-level-role") {
      const level = i.options.getInteger("level");
      const role = i.options.getRole("role");

      await db.run(
        `INSERT OR REPLACE INTO level_roles (guild_id, level, role_id)
         VALUES (?, ?, ?)`,
        [gid, level, role.id]
      );

      return i.editReply("🎖 تم ربط الرتبة باللفل");
    }

    // ===== OWNER SYNC =====
    if (i.commandName === "owner-sync") {
      if (!isOwner) return i.editReply("❌ للأونر فقط");

      await registerCommands();
      return i.editReply("♻️ تم تحديث الأوامر");
    }

    // ===== OWNER RESET GUILD =====
    if (i.commandName === "owner-reset-guild") {
      if (!isOwner) return i.editReply("❌ للأونر فقط");

      await db.run(`DELETE FROM users WHERE guild_id=?`, [gid]);
      return i.editReply("💀 تم تصفير السيرفر");
    }

    // ===== OWNER RESET USER =====
    if (i.commandName === "owner-reset-user") {
      if (!isOwner) return i.editReply("❌ للأونر فقط");

      const user = i.options.getUser("user");

      await db.run(
        `DELETE FROM users WHERE guild_id=? AND user_id=?`,
        [gid, user.id]
      );

      return i.editReply("🧨 تم تصفير العضو");
    }

  } catch (e) {
    console.log("interaction error:", e?.message);
    if (i.deferred) i.editReply("❌ صار خطأ").catch(() => {});
  }
});
