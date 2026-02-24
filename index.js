// ==========================
// ✅ TR10 PRO XP (Chat + Voice) + Admin Tools
// - Chat XP (cooldown)
// - Voice XP (any voice channel, even if muted/deaf)
// - Congratz channel (set from Discord)
// - Level roles (assign role at specific level)
// - Lock/Unlock text channel
// - /rank /top /addxp /setlevel /resetxp
// - Global slash commands (works in multiple servers)
// - Express web for Render uptime
// ==========================

const fs = require("fs");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");

// ================= WEB (Render / Uptime) =================
const app = express();
app.get("/", (req, res) => res.status(200).send("Bot alive ✅"));
app.get("/health", (req, res) => res.json({ ok: true, time: Date.now() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🌐 Web server running on " + PORT));

// ================= ENV =================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.log("❌ ضع TOKEN و CLIENT_ID في Environment Variables (Render/Replit Secrets)");
  process.exit(1);
}

// ================= FILES =================
const LEVELS_FILE = "levels.json";
const SETTINGS_FILE = "settings.json";

if (!fs.existsSync(LEVELS_FILE)) fs.writeFileSync(LEVELS_FILE, "{}");
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, "{}");

function loadJSON(path) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); }
  catch { return {}; }
}
function saveJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

let db = loadJSON(LEVELS_FILE);          // { "guildId:userId": {xp, level, lastMsgAt, voiceMins} }
let settings = loadJSON(SETTINGS_FILE);  // { "guildId": { congratsChannelId, rolesByLevel } }

function keyOf(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getUser(guildId, userId) {
  const k = keyOf(guildId, userId);
  if (!db[k]) db[k] = { xp: 0, level: 1, lastMsgAt: 0, voiceMins: 0 };
  return db[k];
}

function getGuildSettings(guildId) {
  if (!settings[guildId]) settings[guildId] = { congratsChannelId: null, rolesByLevel: {} };
  if (!settings[guildId].rolesByLevel) settings[guildId].rolesByLevel = {};
  return settings[guildId];
}

function saveAll() {
  saveJSON(LEVELS_FILE, db);
  saveJSON(SETTINGS_FILE, settings);
}

// ================= LEVEL FORMULA =================
function xpToNext(level) {
  // بسيطة وواضحة
  return 120 + (level - 1) * 35;
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

// ================= CHAT XP =================
const CHAT_MIN = 8;
const CHAT_MAX = 16;
const CHAT_COOLDOWN_SEC = 35;

async function handleLevelUp(guild, userId, newLevel, fallbackChannel) {
  const gs = getGuildSettings(guild.id);

  // روم التبريكات (إذا محدد)
  const ch =
    gs.congratsChannelId
      ? guild.channels.cache.get(gs.congratsChannelId)
      : fallbackChannel;

  // رتب اللفلات
  const roleId = gs.rolesByLevel?.[String(newLevel)];
  if (roleId) {
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) await member.roles.add(roleId).catch(() => {});
    } catch {}
  }

  // رسالة تبريك
  try {
    if (ch && ch.isTextBased()) {
      await ch.send(`🎉 <@${userId}> وصل لفل **${newLevel}**! 🔥`);
    }
  } catch {}
}

client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const u = getUser(msg.guild.id, msg.author.id);
  const now = Date.now();
  if (now - (u.lastMsgAt || 0) < CHAT_COOLDOWN_SEC * 1000) return;
  u.lastMsgAt = now;

  u.xp += rand(CHAT_MIN, CHAT_MAX);

  // level up
  let leveled = false;
  while (u.xp >= xpToNext(u.level)) {
    u.xp -= xpToNext(u.level);
    u.level += 1;
    leveled = true;
    await handleLevelUp(msg.guild, msg.author.id, u.level, msg.channel);
  }

  if (leveled) saveAll();
  else saveJSON(LEVELS_FILE, db);
});

// ================= VOICE XP =================
// يعطي XP لأي شخص موجود بالصوتي بأي روم حتى لو muted/deaf
const VOICE_XP_PER_MIN = 6;

const voiceSetByGuild = new Map(); // guildId -> Set(userId)
function getVoiceSet(gid) {
  if (!voiceSetByGuild.has(gid)) voiceSetByGuild.set(gid, new Set());
  return voiceSetByGuild.get(gid);
}

client.on("voiceStateUpdate", (oldS, newS) => {
  const gid = newS.guild.id;
  const set = getVoiceSet(gid);

  const userId = newS.id;
  if (newS.member?.user?.bot) return;

  const nowInVoice = !!newS.channelId;
  const beforeInVoice = !!oldS.channelId;

  if (!beforeInVoice && nowInVoice) set.add(userId);
  if (beforeInVoice && !nowInVoice) set.delete(userId);
});

setInterval(async () => {
  for (const [gid, set] of voiceSetByGuild.entries()) {
    const guild = client.guilds.cache.get(gid);
    if (!guild) continue;

    for (const userId of set) {
      const u = getUser(gid, userId);

      u.voiceMins = (u.voiceMins || 0) + 1;
      u.xp += VOICE_XP_PER_MIN;

      let leveled = false;
      while (u.xp >= xpToNext(u.level)) {
        u.xp -= xpToNext(u.level);
        u.level += 1;
        leveled = true;
        // تهنئة الصوتي: نخليها في روم التبريكات لو محدد
        await handleLevelUp(guild, userId, u.level, null);
      }

      if (leveled) saveAll();
    }
  }

  saveJSON(LEVELS_FILE, db);
}, 60 * 1000);

// ================= SLASH COMMANDS (AR) =================
const commands = [
  new SlashCommandBuilder().setName("لفلي").setDescription("يعرض لفلك و XP"),
  new SlashCommandBuilder().setName("توب").setDescription("توب 10 لفلات بالسيرفر"),

  new SlashCommandBuilder()
    .setName("اضافة_xp")
    .setDescription("إضافة XP لعضو")
    .addUserOption(o => o.setName("عضو").setDescription("اختر العضو").setRequired(true))
    .addIntegerOption(o => o.setName("كمية").setDescription("كم XP").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("تحديد_لفل")
    .setDescription("تحديد لفل عضو")
    .addUserOption(o => o.setName("عضو").setDescription("اختر العضو").setRequired(true))
    .addIntegerOption(o => o.setName("لفل").setDescription("رقم اللفل").setRequired(true).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("تصفير_xp")
    .setDescription("تصفير XP كامل السيرفر (خطر)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("تحديد_روم_التبريكات")
    .setDescription("تحديد روم تهاني اللفلات")
    .addChannelOption(o => o.setName("الروم").setDescription("اختر الروم").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("الغاء_روم_التبريكات")
    .setDescription("إلغاء روم التبريكات")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("ربط_رتبة_لفل")
    .setDescription("ربط رتبة عند لفل معين")
    .addIntegerOption(o => o.setName("لفل").setDescription("اللفل").setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName("ايدي_الرتبة").setDescription("ID الرتبة").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  new SlashCommandBuilder()
    .setName("عرض_رتب_اللفلات")
    .setDescription("يعرض رتب اللفلات المربوطة")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  new SlashCommandBuilder()
    .setName("قفل_روم")
    .setDescription("قفل روم كتابي (منع الكتابة للجميع)")
    .addChannelOption(o => o.setName("الروم").setDescription("اختياري").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("فتح_روم")
    .setDescription("فتح روم كتابي (السماح بالكتابة للجميع)")
    .addChannelOption(o => o.setName("الروم").setDescription("اختياري").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
].map(c => c.toJSON());

async function registerCommandsGlobal() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ Global slash commands registered");
}

// ================= INTERACTIONS =================
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    await i.deferReply({ ephemeral: false });

    const gid = i.guild?.id;
    if (!gid) return i.editReply("❌ هذا الأمر لازم داخل سيرفر.");

    // ===== /لفلي =====
    if (i.commandName === "لفلي") {
      const u = getUser(gid, i.user.id);
      return i.editReply(
        `🏅 **لفلك:** ${u.level}\n✨ **XP:** ${u.xp}/${xpToNext(u.level)}\n🎧 **دقائق صوتي:** ${u.voiceMins || 0}`
      );
    }

    // ===== /توب =====
    if (i.commandName === "توب") {
      const list = Object.entries(db)
        .filter(([k]) => k.startsWith(gid + ":"))
        .map(([k, v]) => ({
          userId: k.split(":")[1],
          level: v.level,
          xp: v.xp,
          voiceMins: v.voiceMins || 0,
        }))
        .sort((a, b) => (b.level - a.level) || (b.xp - a.xp))
        .slice(0, 10);

      if (!list.length) return i.editReply("مافي بيانات للحين.");

      const lines = list.map((x, idx) =>
        `**${idx + 1})** <@${x.userId}> — **لفل ${x.level}** | XP ${x.xp} | 🎧 ${x.voiceMins}د`
      );
      return i.editReply(`🏆 **توب 10**\n${lines.join("\n")}`);
    }

    // ===== /اضافة_xp =====
    if (i.commandName === "اضافة_xp") {
      const user = i.options.getUser("عضو", true);
      const amount = i.options.getInteger("كمية", true);

      const u = getUser(gid, user.id);
      u.xp += amount;

      while (u.xp >= xpToNext(u.level)) {
        u.xp -= xpToNext(u.level);
        u.level += 1;
        await handleLevelUp(i.guild, user.id, u.level, i.channel);
      }

      saveJSON(LEVELS_FILE, db);
      return i.editReply(`✅ تمت إضافة **${amount} XP** لـ ${user}\nالآن لفله: **${u.level}**`);
    }

    // ===== /تحديد_لفل =====
    if (i.commandName === "تحديد_لفل") {
      const user = i.options.getUser("عضو", true);
      const lvl = i.options.getInteger("لفل", true);

      const u = getUser(gid, user.id);
      u.level = lvl;
      u.xp = 0;

      saveJSON(LEVELS_FILE, db);
      return i.editReply(`🔥 تم تحديد لفل ${user} إلى **${lvl}**`);
    }

    // ===== /تصفير_xp =====
    if (i.commandName === "تصفير_xp") {
      for (const k of Object.keys(db)) {
        if (k.startsWith(gid + ":")) delete db[k];
      }
      saveJSON(LEVELS_FILE, db);
      return i.editReply("🧨 تم تصفير XP كامل السيرفر ✅");
    }

    // ===== روم التبريكات =====
    if (i.commandName === "تحديد_روم_التبريكات") {
      const ch = i.options.getChannel("الروم", true);
      if (!ch || !ch.isTextBased()) return i.editReply("❌ اختر روم كتابي.");

      const gs = getGuildSettings(gid);
      gs.congratsChannelId = ch.id;
      saveJSON(SETTINGS_FILE, settings);

      return i.editReply(`✅ تم تحديد روم التبريكات: ${ch}`);
    }

    if (i.commandName === "الغاء_روم_التبريكات") {
      const gs = getGuildSettings(gid);
      gs.congratsChannelId = null;
      saveJSON(SETTINGS_FILE, settings);
      return i.editReply("✅ تم إلغاء روم التبريكات.");
    }

    // ===== ربط رتبة لفل =====
    if (i.commandName === "ربط_رتبة_لفل") {
      const lvl = i.options.getInteger("لفل", true);
      const roleId = i.options.getString("ايدي_الرتبة", true).trim();

      const role = i.guild.roles.cache.get(roleId);
      if (!role) return i.editReply("❌ ايدي الرتبة غلط أو الرتبة غير موجودة.");

      const gs = getGuildSettings(gid);
      gs.rolesByLevel[String(lvl)] = roleId;
      saveJSON(SETTINGS_FILE, settings);

      return i.editReply(`✅ تم ربط رتبة **${role.name}** عند لفل **${lvl}**`);
    }

    if (i.commandName === "عرض_رتب_اللفلات") {
      const gs = getGuildSettings(gid);
      const map = gs.rolesByLevel || {};
      const keys = Object.keys(map).sort((a, b) => Number(a) - Number(b));

      if (!keys.length) return i.editReply("ما فيه رتب مربوطة بالمستويات.");

      const lines = keys.map(lvl => {
        const rid = map[lvl];
        const role = i.guild.roles.cache.get(rid);
        return `**لفل ${lvl}:** ${role ? `<@&${rid}>` : `رتبة غير موجودة (${rid})`}`;
      });

      return i.editReply(`📌 **رتب المستويات**\n${lines.join("\n")}`);
    }

    // ===== قفل/فتح روم =====
    async function lockUnlock(mode) {
      const ch = i.options.getChannel("الروم", false) || i.channel;
      if (!ch || ch.type !== ChannelType.GuildText) {
        return i.editReply("❌ اختر روم كتابي (Text).");
      }

      const everyone = i.guild.roles.everyone;

      if (mode === "lock") {
        await ch.permissionOverwrites.edit(everyone, { SendMessages: false }).catch(() => {});
        return i.editReply(`🔒 تم قفل ${ch}`);
      } else {
        await ch.permissionOverwrites.edit(everyone, { SendMessages: null }).catch(() => {});
        return i.editReply(`🔓 تم فتح ${ch}`);
      }
    }

    if (i.commandName === "قفل_روم") return lockUnlock("lock");
    if (i.commandName === "فتح_روم") return lockUnlock("unlock");

    return i.editReply("❓ أمر غير معروف.");
  } catch (e) {
    try {
      if (i.deferred || i.replied) return i.editReply(`⚠️ خطأ: ${e?.message || e}`);
      return i.reply({ content: `⚠️ خطأ: ${e?.message || e}`, ephemeral: true });
    } catch {}
  }
});

// ================= READY =================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommandsGlobal().catch(err =>
    console.log("❌ register error:", err?.message || err)
  );
});

client.login(TOKEN);