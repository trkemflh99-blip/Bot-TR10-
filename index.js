/**
 * Bot ~ TR10 (Single-file version)
 * - Discord.js v14
 * - SQLite (sqlite3 + sqlite)
 * - Text XP + Voice XP
 * - Daily reset 1:00 AM (Saudi) / Weekly reset Saturday 11:00 PM (Saudi)
 * - /top (كتابي/صوتي/الكل) + /rank
 * - /قفل /فتح (للروم الحالي)
 * - Congrats channel + message template
 * - Level roles
 * - Owner commands (secret)
 * - /help + !help
 * - Auto replies
 * - KeepAlive Web (Express)
 */

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

// ===================== ENV =====================
const TOKEN = process.env.TOKEN;         // Bot Token
const CLIENT_ID = process.env.CLIENT_ID; // Application ID
const GUILD_ID = process.env.GUILD_ID;   // (اختياري) سيرفرك لتسجيل أوامر بسرعة
const OWNER_ID = process.env.OWNER_ID || "910264482444480562"; // ايديك

const PORT = process.env.PORT || 3000;
const TZ = "Asia/Riyadh";

// ===================== KEEP ALIVE WEB =====================
const app = express();
app.get("/", (req, res) => res.send("Bot is Alive 👑"));
app.listen(PORT, () => console.log("Web server running on", PORT));

// ===================== DISCORD CLIENT =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.User],
});

// ===================== DATABASE =====================
let db;

async function initDB() {
  db = await open({
    filename: "./data.sqlite",
    driver: sqlite3.Database,
  });

  await db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      guild_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,

      text_total   INTEGER NOT NULL DEFAULT 0,
      voice_total  INTEGER NOT NULL DEFAULT 0,

      text_day     INTEGER NOT NULL DEFAULT 0,
      voice_day    INTEGER NOT NULL DEFAULT 0,

      text_week    INTEGER NOT NULL DEFAULT 0,
      voice_week   INTEGER NOT NULL DEFAULT 0,

      level        INTEGER NOT NULL DEFAULT 0,

      msg_bucket   INTEGER NOT NULL DEFAULT 0,

      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT PRIMARY KEY,
      congrats_channel TEXT,
      congrats_message TEXT,
      prefix TEXT DEFAULT '!',
      allow_autoreply INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS level_roles (
      guild_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, level)
    );

    CREATE TABLE IF NOT EXISTS autoreplies (
      guild_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      response TEXT NOT NULL,
      PRIMARY KEY (guild_id, trigger)
    );
  `);
}

async function ensureUser(guildId, userId) {
  await db.run(
    `INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)`,
    [guildId, userId]
  );
  return db.get(`SELECT * FROM users WHERE guild_id=? AND user_id=?`, [
    guildId,
    userId,
  ]);
}

async function ensureSettings(guildId) {
  await db.run(`INSERT OR IGNORE INTO settings (guild_id) VALUES (?)`, [guildId]);
  return db.get(`SELECT * FROM settings WHERE guild_id=?`, [guildId]);
}

// ===================== LEVEL SYSTEM =====================
// Level based on TOTAL XP = text_total + voice_total
// Required XP grows gradually (ProBot-ish feel).
function requiredForNextLevel(level) {
  // level 0 -> 1 needs about 200 total
  // grows by +75 each level, plus small curve
  return 200 + (level * 75) + Math.floor(level * level * 8);
}

function calcTotalXPRow(row) {
  return (row?.text_total || 0) + (row?.voice_total || 0);
}

async function checkLevelUp(guild, member, rowBefore) {
  const beforeLevel = rowBefore.level || 0;
  let row = await db.get(`SELECT * FROM users WHERE guild_id=? AND user_id=?`, [
    guild.id, member.id,
  ]);

  let level = row.level || 0;
  let total = calcTotalXPRow(row);

  let leveledUp = false;

  while (total >= requiredForNextLevel(level)) {
    level++;
    leveledUp = true;
  }

  if (leveledUp) {
    await db.run(`UPDATE users SET level=? WHERE guild_id=? AND user_id=?`, [
      level, guild.id, member.id,
    ]);

    // give level roles (if set)
    const roles = await db.all(
      `SELECT level, role_id FROM level_roles WHERE guild_id=?`,
      [guild.id]
    );

    const toGive = roles.filter(r => (r.level || 0) <= level);
    for (const r of toGive) {
      const role = guild.roles.cache.get(r.role_id);
      if (role) {
        // add role if not present
        if (!member.roles.cache.has(role.id)) {
          await member.roles.add(role.id).catch(() => {});
        }
      }
    }

    // congrats message
    const settings = await ensureSettings(guild.id);
    if (settings.congrats_channel) {
      const ch = guild.channels.cache.get(settings.congrats_channel);
      if (ch) {
        const msgTemplate =
          settings.congrats_message ||
          "🎉 مبروك {user}! وصلت لفل **{level}** 👑";

        const out = msgTemplate
          .replaceAll("{user}", `<@${member.id}>`)
          .replaceAll("{level}", String(level));

        ch.send({ content: out }).catch(() => {});
      }
    }
  }

  return { beforeLevel, afterLevel: level };
}

// ===================== XP ADDERS =====================
async function addTextXP(guildId, userId, amount) {
  const row = await ensureUser(guildId, userId);
  await db.run(
    `UPDATE users
     SET text_total = text_total + ?,
         text_day   = text_day   + ?,
         text_week  = text_week  + ?
     WHERE guild_id=? AND user_id=?`,
    [amount, amount, amount, guildId, userId]
  );
  return row;
}

async function addVoiceXP(guildId, userId, amount) {
  const row = await ensureUser(guildId, userId);
  await db.run(
    `UPDATE users
     SET voice_total = voice_total + ?,
         voice_day   = voice_day   + ?,
         voice_week  = voice_week  + ?
     WHERE guild_id=? AND user_id=?`,
    [amount, amount, amount, guildId, userId]
  );
  return row;
}

// ===================== VOICE TRACKER =====================
// Every 5 minutes: +10 voice xp to everyone in any voice channel (mute/deaf doesn't matter)
async function voiceTick() {
  for (const guild of client.guilds.cache.values()) {
    // iterate members in voice channels
    guild.channels.cache.forEach(async (ch) => {
      if (!ch.isVoiceBased()) return;
      // for each member in channel
      for (const [memberId, member] of ch.members) {
        if (member.user.bot) continue;

        const before = await ensureUser(guild.id, memberId);
        await addVoiceXP(guild.id, memberId, 10);

        // level up check
        await checkLevelUp(guild, member, before);
      }
    });
  }
}

// ===================== DAILY / WEEKLY RESET =====================
async function dailyReset() {
  for (const g of client.guilds.cache.values()) {
    await db.run(
      `UPDATE users SET text_day=0, voice_day=0 WHERE guild_id=?`,
      [g.id]
    );
  }
  console.log("[RESET] Daily reset done.");
}

async function weeklyReset() {
  for (const g of client.guilds.cache.values()) {
    await db.run(
      `UPDATE users SET text_week=0, voice_week=0 WHERE guild_id=?`,
      [g.id]
    );
  }
  console.log("[RESET] Weekly reset done.");
}

// ===================== COMMANDS (SLASH) =====================
function buildCommands() {
  const commands = [];

  // /help
  commands.push(
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("شرح جميع الأوامر")
  );

  // /rank
  commands.push(
    new SlashCommandBuilder()
      .setName("rank")
      .setDescription("يعرض رتبتك و XP واللفل")
      .addUserOption(o =>
        o.setName("user").setDescription("اختياري: عضو آخر").setRequired(false)
      )
  );

  // /top
  commands.push(
    new SlashCommandBuilder()
      .setName("top")
      .setDescription("التوب - (كتابي / صوتي / الكل)")
      .addStringOption(o =>
        o.setName("type")
          .setDescription("اختر نوع التوب")
          .setRequired(true)
          .addChoices(
            { name: "كتابي", value: "text" },
            { name: "صوتي", value: "voice" },
            { name: "الكل", value: "all" },
          )
      )
  );

  // /قفل
  commands.push(
    new SlashCommandBuilder()
      .setName("قفل")
      .setDescription("يقفل الروم الحالي (للمود/الادمن)")
  );

  // /فتح
  commands.push(
    new SlashCommandBuilder()
      .setName("فتح")
      .setDescription("يفتح الروم الحالي (للمود/الادمن)")
  );

  // /autoreply-add
  commands.push(
    new SlashCommandBuilder()
      .setName("autoreply-add")
      .setDescription("إضافة رد تلقائي (trigger => response)")
      .addStringOption(o => o.setName("trigger").setDescription("الكلمة/الجملة").setRequired(true))
      .addStringOption(o => o.setName("response").setDescription("الرد").setRequired(true))
  );

  // /autoreply-remove
  commands.push(
    new SlashCommandBuilder()
      .setName("autoreply-remove")
      .setDescription("حذف رد تلقائي")
      .addStringOption(o => o.setName("trigger").setDescription("الكلمة/الجملة").setRequired(true))
  );

  // ================= OWNER (secret) =================
  commands.push(
    new SlashCommandBuilder()
      .setName("owner-setcongrats")
      .setDescription(" (أونر) تحديد روم التبريكات")
      .addChannelOption(o => o.setName("channel").setDescription("الروم").setRequired(true))
  );

  commands.push(
    new SlashCommandBuilder()
      .setName("owner-setcongratsmsg")
      .setDescription(" (أونر) تحديد رسالة التبريكات {user} {level}")
      .addStringOption(o => o.setName("message").setDescription("الرسالة").setRequired(true))
  );

  commands.push(
    new SlashCommandBuilder()
      .setName("owner-setlevelrole")
      .setDescription("(أونر) ربط رتبة بلفل معيّن")
      .addIntegerOption(o => o.setName("level").setDescription("اللفل").setRequired(true))
      .addRoleOption(o => o.setName("role").setDescription("الرتبة").setRequired(true))
  );

  commands.push(
    new SlashCommandBuilder()
      .setName("owner-addxp")
      .setDescription("(أونر) إضافة XP لعضو")
      .addUserOption(o => o.setName("user").setDescription("العضو").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("الكمية").setRequired(true))
      .addStringOption(o =>
        o.setName("type")
          .setDescription("نوع الإضافة")
          .setRequired(true)
          .addChoices(
            { name: "كتابي", value: "text" },
            { name: "صوتي", value: "voice" },
            { name: "الكل", value: "all" }
          )
      )
  );

  commands.push(
    new SlashCommandBuilder()
      .setName("owner-reset")
      .setDescription("(أونر) تصفير عضو (يومي/أسبوعي/كلي)")
      .addUserOption(o => o.setName("user").setDescription("العضو").setRequired(true))
      .addStringOption(o =>
        o.setName("scope")
          .setDescription("نطاق التصفير")
          .setRequired(true)
          .addChoices(
            { name: "اليومي", value: "day" },
            { name: "الأسبوعي", value: "week" },
            { name: "الكلي", value: "all" }
          )
      )
  );

  commands.push(
    new SlashCommandBuilder()
      .setName("owner-sync")
      .setDescription("(أونر) حذف أوامر البوت القديمة وتسجيل أوامر جديدة (لهذا السيرفر)")
  );

  return commands.map(c => c.toJSON());
}

async function registerCommands() {
  if (!CLIENT_ID || !TOKEN) {
    console.log("Missing CLIENT_ID or TOKEN env.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const commands = buildCommands();

  try {
    if (GUILD_ID) {
      // Fast update (recommended)
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log("✅ Registered GUILD commands:", GUILD_ID);
    } else {
      // Global (takes time to appear)
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Registered GLOBAL commands.");
    }
  } catch (e) {
    console.error("Command register error:", e);
  }
}

// ===================== HELP TEXT =====================
function helpText(prefix = "!") {
  return [
    "👑 **Bot ~ TR10 | Help**",
    "",
    "## ✅ XP / لفلات",
    `- \`${prefix}xp\` : يعرض **الكل** (كتابي+صوتي)`,
    `- \`${prefix}t day|week|all\` : XP **كتابي**`,
    `- \`${prefix}v day|week|all\` : XP **صوتي**`,
    `- \`/rank\` : رانك احترافي`,
    `- \`/top\` : التوب (كتابي/صوتي/الكل)`,
    "",
    "## ⏱️ التصفير التلقائي",
    "- يومي: **1:00 AM** (السعودية)",
    "- أسبوعي: **كل سبت 11:00 PM** (السعودية)",
    "",
    "## 🔒 إدارة الرومات",
    "- /قفل : يقفل الروم الحالي",
    "- /فتح : يفتح الروم الحالي",
    "",
    "## 🎉 التبريكات والرتب (أونر فقط)",
    "- /owner-setcongrats (تحديد روم التبريكات)",
    "- /owner-setcongratsmsg (رسالة التبريك: {user} {level})",
    "- /owner-setlevelrole (رتبة عند لفل معين)",
    "",
    "## 🤖 ردود تلقائية",
    "- /autoreply-add (إضافة رد تلقائي)",
    "- /autoreply-remove (حذف رد تلقائي)",
    "",
    "## 🛡️ أوامر الأونر السرية",
    "- /owner-addxp (إضافة XP)",
    "- /owner-reset (تصفير عضو)",
    "- /owner-sync (يحذف أوامر البوت القديمة ويسجل الجديدة للسيرفر)",
  ].join("\n");
}

// ===================== PREFIX COMMANDS =====================
async function handlePrefixCommand(message, settings) {
  const prefix = settings?.prefix || "!";
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const cmd = (args.shift() || "").toLowerCase();

  const guildId = message.guild.id;
  const userId = message.author.id;

  // !help
  if (cmd === "help") {
    return message.reply({ content: helpText(prefix) }).catch(() => {});
  }

  // !xp (all)
  if (cmd === "xp") {
    const row = await ensureUser(guildId, userId);
    const total = calcTotalXPRow(row);
    const embed = new EmbedBuilder()
      .setTitle("📌 XP | الكل")
      .setDescription(
        [
          `👤 <@${userId}>`,
          `**Text XP:** ${row.text_total}`,
          `**Voice XP:** ${row.voice_total}`,
          `**Total:** ${total}`,
          `**Level:** ${row.level}`,
          `**Next Level:** ${requiredForNextLevel(row.level)}`,
        ].join("\n")
      );
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  // !t day|week|all
  if (cmd === "t" || cmd === "text") {
    const scope = (args[0] || "all").toLowerCase();
    const row = await ensureUser(guildId, userId);

    let val = row.text_total;
    let title = "كتابي | الكلي";
    if (scope === "day") { val = row.text_day; title = "كتابي | اليومي"; }
    if (scope === "week") { val = row.text_week; title = "كتابي | الأسبوعي"; }

    const embed = new EmbedBuilder()
      .setTitle(`📝 XP | ${title}`)
      .setDescription(`👤 <@${userId}>\n**XP:** ${val}\n**Level:** ${row.level}`);
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  // !v day|week|all
  if (cmd === "v" || cmd === "voice") {
    const scope = (args[0] || "all").toLowerCase();
    const row = await ensureUser(guildId, userId);

    let val = row.voice_total;
    let title = "صوتي | الكلي";
    if (scope === "day") { val = row.voice_day; title = "صوتي | اليومي"; }
    if (scope === "week") { val = row.voice_week; title = "صوتي | الأسبوعي"; }

    const embed = new EmbedBuilder()
      .setTitle(`🎙️ XP | ${title}`)
      .setDescription(`👤 <@${userId}>\n**XP:** ${val}\n**Level:** ${row.level}`);
    return message.reply({ embeds: [embed] }).catch(() => {});
  }
}

// ===================== SLASH HANDLERS =====================
function isOwner(userId) {
  return String(userId) === String(OWNER_ID);
}

async function handleSlash(interaction) {
  if (!interaction.guild) return;

  const guild = interaction.guild;
  const guildId = guild.id;

  const settings = await ensureSettings(guildId);

  if (interaction.commandName === "help") {
    return interaction.reply({ content: helpText(settings.prefix || "!"), ephemeral: true });
  }

  if (interaction.commandName === "rank") {
    const target = interaction.options.getUser("user") || interaction.user;
    const row = await ensureUser(guildId, target.id);

    const total = calcTotalXPRow(row);
    const next = requiredForNextLevel(row.level);
    const need = Math.max(0, next - total);

    const embed = new EmbedBuilder()
      .setTitle("👑 Rank")
      .setDescription(
        [
          `👤 ${target}`,
          `**Level:** ${row.level}`,
          `**Total XP:** ${total}`,
          "",
          `📝 **Text:** ${row.text_total} (Day: ${row.text_day} | Week: ${row.text_week})`,
          `🎙️ **Voice:** ${row.voice_total} (Day: ${row.voice_day} | Week: ${row.voice_week})`,
          "",
          `➡️ **Next Level XP:** ${next}`,
          `⏳ **Remaining:** ${need}`,
        ].join("\n")
      );

    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === "top") {
    const type = interaction.options.getString("type");
    let rows;

    if (type === "text") {
      rows = await db.all(
        `SELECT user_id, text_total as v, level FROM users WHERE guild_id=? ORDER BY text_total DESC LIMIT 10`,
        [guildId]
      );
    } else if (type === "voice") {
      rows = await db.all(
        `SELECT user_id, voice_total as v, level FROM users WHERE guild_id=? ORDER BY voice_total DESC LIMIT 10`,
        [guildId]
      );
    } else {
      rows = await db.all(
        `SELECT user_id, (text_total + voice_total) as v, level FROM users WHERE guild_id=? ORDER BY (text_total + voice_total) DESC LIMIT 10`,
        [guildId]
      );
    }

    const title =
      type === "text" ? "🏆 توب 10 | كتابي" : type === "voice" ? "🏆 توب 10 | صوتي" : "🏆 توب 10 | الكل";

    const lines = rows.map((r, i) => {
      const mention = `<@${r.user_id}>`;
      return `**${i + 1}-** ${mention}\n> **XP:** ${r.v} | **Level:** ${r.level}\n`;
    });

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(lines.join("\n") || "ما فيه بيانات لسه.");

    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === "قفل") {
    const ch = interaction.channel;
    if (!ch) return;

    // permissions
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    const ok =
      member &&
      (member.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
        member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        isOwner(interaction.user.id));

    if (!ok) return interaction.reply({ content: "❌ ما عندك صلاحية.", ephemeral: true });

    await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {});
    return interaction.reply({ content: `🔒 تم قفل الروم: ${ch}` });
  }

  if (interaction.commandName === "فتح") {
    const ch = interaction.channel;
    if (!ch) return;

    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    const ok =
      member &&
      (member.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
        member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        isOwner(interaction.user.id));

    if (!ok) return interaction.reply({ content: "❌ ما عندك صلاحية.", ephemeral: true });

    await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true }).catch(() => {});
    return interaction.reply({ content: `🔓 تم فتح الروم: ${ch}` });
  }

  // autoreplies
  if (interaction.commandName === "autoreply-add") {
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    const ok =
      member &&
      (member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
        member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        isOwner(interaction.user.id));

    if (!ok) return interaction.reply({ content: "❌ ما عندك صلاحية.", ephemeral: true });

    const trigger = interaction.options.getString("trigger");
    const response = interaction.options.getString("response");

    await db.run(
      `INSERT OR REPLACE INTO autoreplies (guild_id, trigger, response) VALUES (?, ?, ?)`,
      [guildId, trigger.toLowerCase(), response]
    );

    return interaction.reply({ content: "✅ تم إضافة الرد التلقائي.", ephemeral: true });
  }

  if (interaction.commandName === "autoreply-remove") {
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    const ok =
      member &&
      (member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
        member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        isOwner(interaction.user.id));

    if (!ok) return interaction.reply({ content: "❌ ما عندك صلاحية.", ephemeral: true });

    const trigger = interaction.options.getString("trigger").toLowerCase();
    await db.run(`DELETE FROM autoreplies WHERE guild_id=? AND trigger=?`, [guildId, trigger]);

    return interaction.reply({ content: "✅ تم حذف الرد التلقائي.", ephemeral: true });
  }

  // ================= OWNER =================
  if (interaction.commandName.startsWith("owner-")) {
    if (!isOwner(interaction.user.id)) {
      return interaction.reply({ content: "❌ هذا الأمر للأونر فقط.", ephemeral: true });
    }

    if (interaction.commandName === "owner-setcongrats") {
      const ch = interaction.options.getChannel("channel");
      await db.run(`UPDATE settings SET congrats_channel=? WHERE guild_id=?`, [ch.id, guildId]);
      return interaction.reply({ content: `✅ تم تحديد روم التبريكات: ${ch}`, ephemeral: true });
    }

    if (interaction.commandName === "owner-setcongratsmsg") {
      const msg = interaction.options.getString("message");
      await db.run(`UPDATE settings SET congrats_message=? WHERE guild_id=?`, [msg, guildId]);
      return interaction.reply({ content: "✅ تم حفظ رسالة التبريكات.", ephemeral: true });
    }

    if (interaction.commandName === "owner-setlevelrole") {
      const lvl = interaction.options.getInteger("level");
      const role = interaction.options.getRole("role");
      await db.run(
        `INSERT OR REPLACE INTO level_roles (guild_id, level, role_id) VALUES (?, ?, ?)`,
        [guildId, lvl, role.id]
      );
      return interaction.reply({ content: `✅ تم ربط رتبة ${role} بلفل ${lvl}.`, ephemeral: true });
    }

    if (interaction.commandName === "owner-addxp") {
      const user = interaction.options.getUser("user");
      const amount = interaction.options.getInteger("amount");
      const type = interaction.options.getString("type");

      await ensureUser(guildId, user.id);

      if (type === "text") {
        await db.run(
          `UPDATE users SET text_total=text_total+?, text_day=text_day+?, text_week=text_week+? WHERE guild_id=? AND user_id=?`,
          [amount, amount, amount, guildId, user.id]
        );
      } else if (type === "voice") {
        await db.run(
          `UPDATE users SET voice_total=voice_total+?, voice_day=voice_day+?, voice_week=voice_week+? WHERE guild_id=? AND user_id=?`,
          [amount, amount, amount, guildId, user.id]
        );
      } else {
        // all split
        const half = Math.floor(amount / 2);
        const rest = amount - half;
        await db.run(
          `UPDATE users
           SET text_total=text_total+?, text_day=text_day+?, text_week=text_week+?,
               voice_total=voice_total+?, voice_day=voice_day+?, voice_week=voice_week+?
           WHERE guild_id=? AND user_id=?`,
          [half, half, half, rest, rest, rest, guildId, user.id]
        );
      }

      // try level up
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member) {
        const before = await ensureUser(guildId, user.id);
        await checkLevelUp(guild, member, before);
      }

      return interaction.reply({ content: "✅ تم إضافة XP.", ephemeral: true });
    }

    if (interaction.commandName === "owner-reset") {
      const user = interaction.options.getUser("user");
      const scope = interaction.options.getString("scope");
      await ensureUser(guildId, user.id);

      if (scope === "day") {
        await db.run(`UPDATE users SET text_day=0, voice_day=0 WHERE guild_id=? AND user_id=?`, [guildId, user.id]);
      } else if (scope === "week") {
        await db.run(`UPDATE users SET text_week=0, voice_week=0 WHERE guild_id=? AND user_id=?`, [guildId, user.id]);
      } else {
        await db.run(
          `UPDATE users
           SET text_total=0, voice_total=0, text_day=0, voice_day=0, text_week=0, voice_week=0, level=0, msg_bucket=0
           WHERE guild_id=? AND user_id=?`,
          [guildId, user.id]
        );
      }

      return interaction.reply({ content: "✅ تم التصفير.", ephemeral: true });
    }

    if (interaction.commandName === "owner-sync") {
      // overwrite guild commands (deletes old commands of THIS BOT in this guild)
      const rest = new REST({ version: "10" }).setToken(TOKEN);
      const commands = buildCommands();
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands });
      return interaction.reply({ content: "✅ تم حذف أوامر البوت القديمة وتسجيل الجديدة للسيرفر.", ephemeral: true });
    }
  }
}

// ===================== MESSAGE XP + AUTOREPLY =====================
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const settings = await ensureSettings(message.guild.id);

    // Auto replies
    if (settings.allow_autoreply) {
      const content = message.content.trim().toLowerCase();
      const ar = await db.get(
        `SELECT response FROM autoreplies WHERE guild_id=? AND trigger=?`,
        [message.guild.id, content]
      );
      if (ar?.response) {
        message.reply({ content: ar.response }).catch(() => {});
      }
    }

    // Prefix commands
    await handlePrefixCommand(message, settings);

    // TEXT XP rule:
    // every 5 messages => +3 text xp
    const row = await ensureUser(message.guild.id, message.author.id);

    const newBucket = (row.msg_bucket || 0) + 1;
    await db.run(`UPDATE users SET msg_bucket=? WHERE guild_id=? AND user_id=?`, [
      newBucket,
      message.guild.id,
      message.author.id,
    ]);

    if (newBucket >= 5) {
      // reset bucket and add XP
      await db.run(`UPDATE users SET msg_bucket=0 WHERE guild_id=? AND user_id=?`, [
        message.guild.id,
        message.author.id,
      ]);

      const before = await ensureUser(message.guild.id, message.author.id);
      await addTextXP(message.guild.id, message.author.id, 3);

      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member) await checkLevelUp(message.guild, member, before);
    }
  } catch (e) {
    // silent to avoid crash
    console.error("messageCreate error:", e);
  }
});

// ===================== INTERACTIONS =====================
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlash(interaction);
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (interaction.isRepliable()) {
      interaction.reply({ content: "⚠️ صار خطأ داخلي.", ephemeral: true }).catch(() => {});
    }
  }
});

// ===================== READY =====================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // register commands
  await registerCommands();

  // schedule resets (Saudi time)
  // daily 1:00 AM
  cron.schedule("0 1 * * *", () => dailyReset().catch(console.error), { timezone: TZ });

  // weekly Saturday 11:00 PM (Sat = 6)
  cron.schedule("0 23 * * 6", () => weeklyReset().catch(console.error), { timezone: TZ });

  // voice tick every 5 minutes
  setInterval(() => voiceTick().catch(console.error), 5 * 60 * 1000);
});

// ===================== BOOT =====================
(async () => {
  if (!TOKEN || !CLIENT_ID) {
    console.log("❌ لازم تحط TOKEN و CLIENT_ID في Environment Variables");
    process.exit(1);
  }

  await initDB();
  await client.login(TOKEN);
})();
