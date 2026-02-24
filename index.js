// =====================================================
// TR10 XP PRO (Chat + Voice) with Daily/Weekly/Total + Levels
// Commands:
// /xp source:(v|t|all) range:(day|week|total)
// /rank
// /top source:(v|t|all)
// Admin:
// /تحديد-روم-تبريكات  /تعيين-تهنئة  /تصفير-السيرفر
// =====================================================

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
} = require("discord.js");

// ==========================
// 🌐 KeepAlive Web (Render)
// ==========================
const app = express();
app.get("/", (req, res) => res.status(200).send("Bot alive ✅"));
app.get("/health", (req, res) => res.json({ ok: true, time: Date.now() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🌐 Web server running on", PORT));

// ==========================
// 🔐 ENV
// ==========================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.log("❌ لازم تحط TOKEN و CLIENT_ID في Environment Variables");
  process.exit(1);
}

// ==========================
// 💾 DB
// ==========================
const DB_FILE = "tr10_db.json";
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ guilds: {} }, null, 2));
}
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { guilds: {} }; }
}
let db = loadDB();
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ==========================
// 🕒 Date Keys (Asia/Riyadh)
// ==========================
const TZ = "Asia/Riyadh";

function getDailyKey(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date); // YYYY-MM-DD
}

function getWeekKey(date = new Date()) {
  // timezone parts -> build UTC midnight for ISO week calc
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = Number(parts.find(p => p.type === "year")?.value);
  const m = Number(parts.find(p => p.type === "month")?.value);
  const d = Number(parts.find(p => p.type === "day")?.value);

  const utc = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (utc.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  utc.setUTCDate(utc.getUTCDate() - dayNum + 3); // Thu

  const firstThu = new Date(Date.UTC(utc.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDayNum + 3);

  const week = 1 + Math.round((utc - firstThu) / (7 * 24 * 60 * 60 * 1000));
  const year = utc.getUTCFullYear();
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// ==========================
// ⚙️ XP + Levels Settings
// ==========================
const CHAT_XP_MIN = 8;
const CHAT_XP_MAX = 16;
const CHAT_COOLDOWN_SEC = 35;

const VOICE_XP_PER_MIN = 6;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// مستوى متوسط (C)
function xpToNext(level) {
  return 120 + (level - 1) * 35;
}

// ==========================
// 🧩 Guild/User helpers
// ==========================
function ensureGuild(guildId) {
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = {
      settings: {
        congratsChannelId: null,
        congratsMessage: "🎉 مبروك {user}! وصلت **المستوى {level}** في **{server}** 🔥",
      },
      users: {},
    };
  }
  return db.guilds[guildId];
}

function ensureUser(guildId, userId) {
  const g = ensureGuild(guildId);
  if (!g.users[userId]) {
    const dk = getDailyKey();
    const wk = getWeekKey();
    g.users[userId] = {
      level: 1,
      xpInLevel: 0,

      chat: { total: 0, day: 0, week: 0 },
      voice: { total: 0, day: 0, week: 0 },

      lastMsgAt: 0,

      lastDailyKey: dk,
      lastWeeklyKey: wk,
    };
  }
  return g.users[userId];
}

function resetIfNeeded(u) {
  const dk = getDailyKey();
  const wk = getWeekKey();

  if (u.lastDailyKey !== dk) {
    u.chat.day = 0;
    u.voice.day = 0;
    u.lastDailyKey = dk;
  }
  if (u.lastWeeklyKey !== wk) {
    u.chat.week = 0;
    u.voice.week = 0;
    u.lastWeeklyKey = wk;
  }
}

async function sendCongrats(guild, member, level) {
  const g = ensureGuild(guild.id);
  const s = g.settings;
  if (!s.congratsChannelId) return;

  const ch = guild.channels.cache.get(s.congratsChannelId);
  if (!ch || !ch.isTextBased()) return;

  const msg = (s.congratsMessage || "")
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{level}", String(level))
    .replaceAll("{server}", guild.name);

  ch.send({ content: msg }).catch(() => {});
}

async function addXP(guild, member, amount, source /* "chat" | "voice" */) {
  const g = ensureGuild(guild.id);
  const u = ensureUser(guild.id, member.id);

  resetIfNeeded(u);

  // add to buckets
  if (source === "chat") {
    u.chat.total += amount;
    u.chat.day += amount;
    u.chat.week += amount;
  } else {
    u.voice.total += amount;
    u.voice.day += amount;
    u.voice.week += amount;
  }

  // levels based on total gained (chat+voice)
  u.xpInLevel += amount;

  let leveled = false;
  while (u.xpInLevel >= xpToNext(u.level)) {
    u.xpInLevel -= xpToNext(u.level);
    u.level += 1;
    leveled = true;
  }

  saveDB();

  if (leveled) await sendCongrats(guild, member, u.level);
}

// ==========================
// 🤖 Discord Client
// ==========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ==========================
// 💬 Chat XP
// ==========================
client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const u = ensureUser(msg.guild.id, msg.author.id);
  resetIfNeeded(u);

  const now = Date.now();
  if (now - (u.lastMsgAt || 0) < CHAT_COOLDOWN_SEC * 1000) return;
  u.lastMsgAt = now;

  const member = msg.member;
  if (!member) return;

  const gained = rand(CHAT_XP_MIN, CHAT_XP_MAX);
  await addXP(msg.guild, member, gained, "chat");
});

// ==========================
// 🎧 Voice XP (any voice, muted ok)
// ==========================
const voiceSetByGuild = new Map(); // guildId -> Set(userId)
function getVoiceSet(gid) {
  if (!voiceSetByGuild.has(gid)) voiceSetByGuild.set(gid, new Set());
  return voiceSetByGuild.get(gid);
}

client.on("voiceStateUpdate", (oldS, newS) => {
  if (newS.member?.user?.bot) return;

  const gid = newS.guild.id;
  const set = getVoiceSet(gid);

  const nowInVoice = !!newS.channelId;
  const beforeInVoice = !!oldS.channelId;

  if (!beforeInVoice && nowInVoice) set.add(newS.id);
  if (beforeInVoice && !nowInVoice) set.delete(newS.id);
});

// every minute
setInterval(async () => {
  for (const [gid, set] of voiceSetByGuild.entries()) {
    const guild = client.guilds.cache.get(gid);
    if (!guild) continue;

    for (const userId of set) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member || member.user.bot) continue;

      // still in voice?
      if (!member.voice?.channelId) continue;

      await addXP(guild, member, VOICE_XP_PER_MIN, "voice");
    }
  }
}, 60 * 1000);

// ==========================
// 🧩 Slash Commands (Global)
// ==========================
const commands = [
  new SlashCommandBuilder()
    .setName("xp")
    .setDescription("عرض اكس بي (صوتي/دردشة/الكل) + (يومي/أسبوعي/كلي)")
    .addStringOption(o =>
      o.setName("src")
        .setDescription("المصدر")
        .setRequired(true)
        .addChoices(
          { name: "v (صوتي)", value: "v" },
          { name: "t (دردشة)", value: "t" },
          { name: "all (الكل)", value: "all" }
        )
    )
    .addStringOption(o =>
      o.setName("range")
        .setDescription("المدة")
        .setRequired(true)
        .addChoices(
          { name: "day (يومي)", value: "day" },
          { name: "week (أسبوعي)", value: "week" },
          { name: "total (كلي)", value: "total" }
        )
    ),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("يعرض لفلك والتقدم + تفصيل الدردشة والصوت"),

  new SlashCommandBuilder()
    .setName("top")
    .setDescription("توب 10 (حسب المصدر)")
    .addStringOption(o =>
      o.setName("src")
        .setDescription("المصدر")
        .setRequired(true)
        .addChoices(
          { name: "v (صوتي)", value: "v" },
          { name: "t (دردشة)", value: "t" },
          { name: "all (الكل)", value: "all" }
        )
    ),

  // Admin
  new SlashCommandBuilder()
    .setName("تحديد-روم-تبريكات")
    .setDescription("تحديد روم التبريكات للفل")
    .addChannelOption(o =>
      o.setName("الروم").setDescription("اختار الروم").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("تعيين-تهنئة")
    .setDescription("تغيير جملة التبريكات (استخدم {user} {level} {server})")
    .addStringOption(o =>
      o.setName("النص").setDescription("نص التهنئة").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("تصفير-السيرفر")
    .setDescription("⚠️ تصفير كامل بيانات XP لهذا السيرفر")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ Global slash commands registered (قد تتأخر بالظهور شوي).");
}

// ==========================
// 🎛 Interactions
// ==========================
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    await i.deferReply({ ephemeral: false });

    if (!i.guild) return i.editReply("هذا الأمر لازم داخل سيرفر.");

    const gid = i.guild.id;
    const g = ensureGuild(gid);
    const u = ensureUser(gid, i.user.id);
    resetIfNeeded(u);
    saveDB();

    // /xp
    if (i.commandName === "xp") {
      const src = i.options.getString("src", true);       // v|t|all
      const range = i.options.getString("range", true);   // day|week|total

      const pick = (bucket, r) => bucket[r];

      let value = 0;
      if (src === "v") value = pick(u.voice, range);
      else if (src === "t") value = pick(u.chat, range);
      else value = pick(u.voice, range) + pick(u.chat, range);

      return i.editReply(`📌 ${i.user} — **XP ${src} ${range}** = **${value}**`);
    }

    // /rank
    if (i.commandName === "rank") {
      const totalAll = u.chat.total + u.voice.total;
      const dayAll = u.chat.day + u.voice.day;
      const weekAll = u.chat.week + u.voice.week;

      return i.editReply(
        `🏅 ${i.user}\n` +
        `**المستوى:** ${u.level}\n` +
        `**داخل المستوى:** ${u.xpInLevel}/${xpToNext(u.level)}\n\n` +
        `💬 **الدردشة:** كلي ${u.chat.total} | يومي ${u.chat.day} | أسبوعي ${u.chat.week}\n` +
        `🎧 **الصوتي:** كلي ${u.voice.total} | يومي ${u.voice.day} | أسبوعي ${u.voice.week}\n\n` +
        `⭐ **الكل:** كلي ${totalAll} | يومي ${dayAll} | أسبوعي ${weekAll}`
      );
    }

    // /top
    if (i.commandName === "top") {
      const src = i.options.getString("src", true);

      const users = Object.entries(g.users || {})
        .map(([userId, data]) => {
          const chatTotal = data.chat?.total || 0;
          const voiceTotal = data.voice?.total || 0;
          const score = (src === "v") ? voiceTotal : (src === "t") ? chatTotal : (chatTotal + voiceTotal);

          return {
            userId,
            score,
            level: data.level || 1
          };
        })
        .sort((a, b) => (b.level - a.level) || (b.score - a.score))
        .slice(0, 10);

      if (!users.length) return i.editReply("مافي بيانات للحين.");

      const lines = users.map((x, idx) =>
        `**${idx + 1})** <@${x.userId}> — Lv **${x.level}** | ⭐ **${x.score}**`
      );

      return i.editReply(`🏆 **Top 10 (${src})**\n${lines.join("\n")}`);
    }

    // Admin: congrats channel
    if (i.commandName === "تحديد-روم-تبريكات") {
      const ch = i.options.getChannel("الروم", true);
      g.settings.congratsChannelId = ch.id;
      saveDB();
      return i.editReply(`✅ تم تحديد روم التبريكات: ${ch}`);
    }

    // Admin: congrats message
    if (i.commandName === "تعيين-تهنئة") {
      const text = i.options.getString("النص", true);
      g.settings.congratsMessage = text;
      saveDB();
      return i.editReply(
        "✅ تم حفظ جملة التبريكات.\n" +
        "القوالب:\n" +
        "{user} = منشن العضو\n" +
        "{level} = المستوى\n" +
        "{server} = اسم السيرفر"
      );
    }

    // Admin: reset guild
    if (i.commandName === "تصفير-السيرفر") {
      const keepSettings = g.settings;
      db.guilds[gid] = { settings: keepSettings, users: {} };
      saveDB();
      return i.editReply("🧹 تم تصفير كل بيانات XP لهذا السيرفر.");
    }

    return i.editReply("❓ أمر غير معروف.");
  } catch (e) {
    try {
      if (i.deferred || i.replied) return i.editReply(`⚠️ خطأ: ${e?.message || e}`);
      return i.reply({ content: `⚠️ خطأ: ${e?.message || e}`, ephemeral: true });
    } catch {}
  }
});

// ==========================
// ✅ Ready
// ==========================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands().catch(err => console.log("❌ register error:", err?.message || err));
});

client.login(TOKEN);
