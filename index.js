// =====================================================
// TR10 PRO (Global Slash) - XP (Chat+Voice) + Tickets + Lock/Unlock + Congrats + Reset
// discord.js v14
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
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
} = require("discord.js");

// ============ WEB (for uptime monitor) ============
const app = express();
app.get("/", (req, res) => res.status(200).send("Bot alive ✅"));
app.get("/health", (req, res) => res.json({ ok: true, time: Date.now() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🌐 Web server running on", PORT));

// ============ ENV ============
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.log("❌ ضع TOKEN / CLIENT_ID في Secrets");
  process.exit(1);
}

// ============ FILES ============
const LEVELS_FILE = "levels.json";
const CONFIG_FILE = "config.json";

if (!fs.existsSync(LEVELS_FILE)) fs.writeFileSync(LEVELS_FILE, "{}");
if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, "{}");

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return {}; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let levelsDB = readJSON(LEVELS_FILE);
let configDB = readJSON(CONFIG_FILE);

// ============ HELPERS ============
const keyOf = (guildId, userId) => `${guildId}:${userId}`;

function getGuildConfig(guildId) {
  if (!configDB[guildId]) {
    configDB[guildId] = {
      congratsChannelId: null,          // روم التبريكات
      xpEnabled: true,                  // تشغيل XP
      xpChatEnabled: true,
      xpVoiceEnabled: true,
      xpChannelLock: {},                // channelId -> true/false (قفل XP داخل روم)
      levelRoles: {},                   // level -> roleId
      ticket: {
        categoryId: null,
        supportRoleId: null,
        panelChannelId: null,
        transcriptChannelId: null
      },
    };
    writeJSON(CONFIG_FILE, configDB);
  }
  return configDB[guildId];
}

function getUser(guildId, userId) {
  const k = keyOf(guildId, userId);
  if (!levelsDB[k]) {
    levelsDB[k] = { xp: 0, level: 1, lastMsgAt: 0, voiceMins: 0 };
    writeJSON(LEVELS_FILE, levelsDB);
  }
  return levelsDB[k];
}

function xpToNext(level) {
  // بسيطة وواضحة
  return 120 + (level - 1) * 35;
}

function addXP(guild, member, amount, whereChannelForCongrats = null) {
  const cfg = getGuildConfig(guild.id);
  const u = getUser(guild.id, member.id);

  u.xp += amount;

  let leveledUp = false;
  while (u.xp >= xpToNext(u.level)) {
    u.xp -= xpToNext(u.level);
    u.level += 1;
    leveledUp = true;

    // ربط رتبة على لفلات
    const roleId = cfg.levelRoles?.[String(u.level)];
    if (roleId) {
      const role = guild.roles.cache.get(roleId);
      if (role) member.roles.add(role).catch(() => {});
    }
  }

  writeJSON(LEVELS_FILE, levelsDB);

  if (leveledUp) {
    const chId = cfg.congratsChannelId || (whereChannelForCongrats ? whereChannelForCongrats.id : null);
    const ch = chId ? guild.channels.cache.get(chId) : null;
    if (ch && ch.isTextBased()) {
      ch.send(`🎉 ${member} وصلت **لفل ${u.level}**!`).catch(() => {});
    }
  }
}

function topUsers(guildId, limit = 10) {
  const list = Object.entries(levelsDB)
    .filter(([k]) => k.startsWith(guildId + ":"))
    .map(([k, v]) => ({
      userId: k.split(":")[1],
      level: v.level || 1,
      xp: v.xp || 0,
      voiceMins: v.voiceMins || 0,
    }))
    .sort((a, b) => (b.level - a.level) || (b.xp - a.xp))
    .slice(0, limit);
  return list;
}

function isXPBlockedInChannel(guildId, channelId) {
  const cfg = getGuildConfig(guildId);
  return !!cfg.xpChannelLock?.[channelId];
}

// ============ CLIENT ============
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

// ============ CHAT XP ============
const CHAT_COOLDOWN_SEC = 35;
const CHAT_MIN = 8;
const CHAT_MAX = 16;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

client.on("messageCreate", (msg) => {
  if (!msg.guild || msg.author.bot) return;

  const cfg = getGuildConfig(msg.guild.id);
  if (!cfg.xpEnabled || !cfg.xpChatEnabled) return;
  if (isXPBlockedInChannel(msg.guild.id, msg.channel.id)) return;

  const u = getUser(msg.guild.id, msg.author.id);
  const now = Date.now();
  if (now - (u.lastMsgAt || 0) < CHAT_COOLDOWN_SEC * 1000) return;
  u.lastMsgAt = now;
  writeJSON(LEVELS_FILE, levelsDB);

  const member = msg.member;
  if (!member) return;

  addXP(msg.guild, member, rand(CHAT_MIN, CHAT_MAX), msg.channel);
});

// ============ VOICE XP (any voice channel, even if muted) ============
const VOICE_XP_PER_MIN = 6;

const voiceSetByGuild = new Map(); // guildId -> Set(userId)
function getVoiceSet(gid) {
  if (!voiceSetByGuild.has(gid)) voiceSetByGuild.set(gid, new Set());
  return voiceSetByGuild.get(gid);
}

client.on("voiceStateUpdate", (oldS, newS) => {
  const gid = newS.guild.id;
  const set = getVoiceSet(gid);

  if (newS.member?.user?.bot) return;

  const userId = newS.id;
  const nowInVoice = !!newS.channelId;
  const beforeInVoice = !!oldS.channelId;

  if (!beforeInVoice && nowInVoice) set.add(userId);
  if (beforeInVoice && !nowInVoice) set.delete(userId);
});

// كل دقيقة XP للصوتي (حتى لو مايك مقفل)
setInterval(async () => {
  for (const [gid, set] of voiceSetByGuild.entries()) {
    const guild = client.guilds.cache.get(gid);
    if (!guild) continue;

    const cfg = getGuildConfig(gid);
    if (!cfg.xpEnabled || !cfg.xpVoiceEnabled) continue;

    for (const userId of set) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member || member.user.bot) continue;

      const u = getUser(gid, userId);
      u.voiceMins = (u.voiceMins || 0) + 1;
      writeJSON(LEVELS_FILE, levelsDB);

      addXP(guild, member, VOICE_XP_PER_MIN, null);
    }
  }
}, 60 * 1000);

// ============ TICKETS ============
function ticketPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("🎫 نظام التذاكر")
    .setDescription("اضغط الزر لفتح تذكرة دعم.\n\n✅ تذكير: اكتب مشكلتك داخل التذكرة.")
    .setFooter({ text: "TR10 Tickets" });
}

function ticketButtonsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_create")
      .setLabel("فتح تذكرة")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("إغلاق التذكرة")
      .setStyle(ButtonStyle.Danger)
  );
}

async function createTicket(interaction) {
  const guild = interaction.guild;
  const cfg = getGuildConfig(guild.id);

  if (!cfg.ticket.categoryId) {
    return interaction.editReply("❌ لازم تسوي: /ضبط-تيكت وتحدد الكاتيقوري + رتبة الدعم.");
  }

  const category = guild.channels.cache.get(cfg.ticket.categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    return interaction.editReply("❌ الكاتيقوري غير صحيح.");
  }

  // اسم قناة فريد
  const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-_]/g, "");
  const channelName = `ticket-${safeName}-${interaction.user.id.slice(-4)}`;

  // امنع تكرار تذكرة لنفس الشخص (ببساطة: لو عنده قناة فيها ايدي آخر 4)
  const exists = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && c.parentId === category.id && c.name.includes(interaction.user.id.slice(-4))
  );
  if (exists) {
    return interaction.editReply(`⚠️ عندك تذكرة مفتوحة: ${exists}`);
  }

  const supportRoleId = cfg.ticket.supportRoleId;

  const ch = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      ...(supportRoleId ? [{ id: supportRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }] : []),
    ],
  });

  await ch.send({
    content: `🆘 ${interaction.user} أهلاً! اكتب مشكلتك هنا.\n${supportRoleId ? `<@&${supportRoleId}>` : ""}`,
    components: [ticketButtonsRow()],
  }).catch(() => {});

  return interaction.editReply(`✅ تم فتح تذكرة: ${ch}`);
}

async function closeTicket(interaction) {
  const ch = interaction.channel;
  if (!ch || ch.type !== ChannelType.GuildText) return;

  // يتأكد أنها تذكرة
  if (!ch.name.startsWith("ticket-")) {
    return interaction.editReply("❌ هذا مو روم تذكرة.");
  }

  await interaction.editReply("✅ تم إغلاق التذكرة بعد 3 ثواني…");
  setTimeout(() => ch.delete().catch(() => {}), 3000);
}

// ============ SLASH COMMANDS (Arabic) ============
const commands = [
  // XP
  new SlashCommandBuilder().setName("لفلي").setDescription("يعرض لفلك و XP"),
  new SlashCommandBuilder().setName("توب").setDescription("أعلى 10 لفلات"),
  new SlashCommandBuilder()
    .setName("اعطاء-اكسبي").setDescription("إضافة XP لعضو")
    .addUserOption(o => o.setName("عضو").setDescription("العضو").setRequired(true))
    .addIntegerOption(o => o.setName("كمية").setDescription("الكمية").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("تصفير-اكسبي").setDescription("تصفير XP عضو")
    .addUserOption(o => o.setName("عضو").setDescription("العضو").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("تفعيل-اكسبي").setDescription("تشغيل/إطفاء نظام XP كامل")
    .addBooleanOption(o => o.setName("تشغيل").setDescription("true تشغيل / false إطفاء").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("قفل-اكسبي-الروم").setDescription("إيقاف XP داخل روم محدد")
    .addChannelOption(o => o.setName("روم").setDescription("الروم").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("فتح-اكسبي-الروم").setDescription("تشغيل XP داخل روم محدد")
    .addChannelOption(o => o.setName("روم").setDescription("الروم").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("ربط-رتبة").setDescription("يعطي رتبة عند وصول لفل معين")
    .addIntegerOption(o => o.setName("لفل").setDescription("المستوى").setRequired(true).setMinValue(1))
    .addRoleOption(o => o.setName("رتبة").setDescription("الرتبة").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("عرض-الرتب").setDescription("يعرض الرتب المربوطة بالمستويات")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Congrats
  new SlashCommandBuilder()
    .setName("تحديد-التبريكات").setDescription("تحديد روم التبريكات للفل")
    .addChannelOption(o => o.setName("روم").setDescription("روم التبريكات").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Lock/Unlock chat channel (permissions)
  new SlashCommandBuilder()
    .setName("قفل-الروم").setDescription("يقفل روم (يمنع @everyone من الكتابة)")
    .addChannelOption(o => o.setName("روم").setDescription("الروم").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("فتح-الروم").setDescription("يفتح روم (يسمح @everyone بالكتابة)")
    .addChannelOption(o => o.setName("روم").setDescription("الروم").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // Tickets
  new SlashCommandBuilder()
    .setName("ضبط-تيكت").setDescription("إعداد التذاكر: كاتيقوري + رتبة الدعم")
    .addChannelOption(o => o.setName("كاتيقوري").setDescription("Category للتذاكر").setRequired(true))
    .addRoleOption(o => o.setName("رتبة-الدعم").setDescription("رتبة الدعم").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("ارسال-بانل-تيكت").setDescription("يرسل لوحة التيكيت في روم")
    .addChannelOption(o => o.setName("روم").setDescription("روم إرسال اللوحة").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // Reset
  new SlashCommandBuilder()
    .setName("تصفير-السيرفر").setDescription("⚠️ تصفير كامل بيانات البوت لهذا السيرفر (XP + إعدادات)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(c => c.toJSON());

// ============ REGISTER GLOBAL COMMANDS ============
async function registerCommandsGlobal() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ Global Slash commands registered");
}

// ============ INTERACTIONS ============
client.on("interactionCreate", async (i) => {
  try {
    // Buttons (Tickets)
    if (i.isButton()) {
      await i.deferReply({ ephemeral: true });

      if (i.customId === "ticket_create") return createTicket(i);
      if (i.customId === "ticket_close") return closeTicket(i);

      return i.editReply("❓ زر غير معروف.");
    }

    // Slash
    if (!i.isChatInputCommand()) return;

    await i.deferReply({ ephemeral: false });

    const guild = i.guild;
    if (!guild) return i.editReply("هذا الأمر للسيرفر فقط.");

    const cfg = getGuildConfig(guild.id);

    // = XP
    if (i.commandName === "لفلي") {
      const u = getUser(guild.id, i.user.id);
      return i.editReply(`🏅 **المستوى:** ${u.level}\n✨ **XP:** ${u.xp}/${xpToNext(u.level)}\n🎧 **دقائق صوتي:** ${u.voiceMins || 0}`);
    }

    if (i.commandName === "توب") {
      const list = topUsers(guild.id, 10);
      if (!list.length) return i.editReply("مافي بيانات للحين.");

      const lines = list.map((x, idx) =>
        `**${idx + 1})** <@${x.userId}> — Lv **${x.level}** | XP **${x.xp}** | 🎧 **${x.voiceMins}m**`
      );
      return i.editReply(`🏆 **توب 10**\n${lines.join("\n")}`);
    }

    if (i.commandName === "اعطاء-اكسبي") {
      const user = i.options.getUser("عضو", true);
      const amount = i.options.getInteger("كمية", true);

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return i.editReply("❌ ما قدرت أجيب العضو.");

      addXP(guild, member, amount, null);
      const u = getUser(guild.id, user.id);
      return i.editReply(`✅ تم إضافة **${amount} XP** لـ ${user}\n🏅 Lv: **${u.level}** | XP: **${u.xp}/${xpToNext(u.level)}**`);
    }

    if (i.commandName === "تصفير-اكسبي") {
      const user = i.options.getUser("عضو", true);
      const k = keyOf(guild.id, user.id);
      levelsDB[k] = { xp: 0, level: 1, lastMsgAt: 0, voiceMins: 0 };
      writeJSON(LEVELS_FILE, levelsDB);
      return i.editReply(`✅ تم تصفير XP لـ ${user}`);
    }

    if (i.commandName === "تفعيل-اكسبي") {
      const on = i.options.getBoolean("تشغيل", true);
      cfg.xpEnabled = on;
      configDB[guild.id] = cfg;
      writeJSON(CONFIG_FILE, configDB);
      return i.editReply(`✅ تم ${on ? "تشغيل" : "إيقاف"} نظام XP.`);
    }

    if (i.commandName === "قفل-اكسبي-الروم") {
      const ch = i.options.getChannel("روم", true);
      cfg.xpChannelLock[ch.id] = true;
      writeJSON(CONFIG_FILE, configDB);
      return i.editReply(`✅ تم إيقاف XP في ${ch}`);
    }

    if (i.commandName === "فتح-اكسبي-الروم") {
      const ch = i.options.getChannel("روم", true);
      delete cfg.xpChannelLock[ch.id];
      writeJSON(CONFIG_FILE, configDB);
      return i.editReply(`✅ تم تشغيل XP في ${ch}`);
    }

    if (i.commandName === "ربط-رتبة") {
      const lvl = i.options.getInteger("لفل", true);
      const role = i.options.getRole("رتبة", true);

      cfg.levelRoles[String(lvl)] = role.id;
      writeJSON(CONFIG_FILE, configDB);

      return i.editReply(`✅ تم ربط **لفل ${lvl}** بـ رتبة ${role}`);
    }

    if (i.commandName === "عرض-الرتب") {
      const map = cfg.levelRoles || {};
      const entries = Object.entries(map).sort((a, b) => Number(a[0]) - Number(b[0]));
      if (!entries.length) return i.editReply("ما فيه رتب مربوطة بالمستويات.");

      const lines = entries.map(([lvl, roleId]) => `Lv **${lvl}** → <@&${roleId}>`);
      return i.editReply(`📌 **الرتب المربوطة:**\n${lines.join("\n")}`);
    }

    // = Congrats
    if (i.commandName === "تحديد-التبريكات") {
      const ch = i.options.getChannel("روم", true);
      cfg.congratsChannelId = ch.id;
      writeJSON(CONFIG_FILE, configDB);
      return i.editReply(`✅ تم تحديد روم التبريكات: ${ch}`);
    }

    // = Lock / Unlock
    if (i.commandName === "قفل-الروم") {
      const ch = i.options.getChannel("روم", true);
      if (!ch.isTextBased()) return i.editReply("❌ هذا مو روم كتابي.");
      await ch.permissionOverwrites.edit(guild.roles.everyone.id, { SendMessages: false }).catch(() => {});
      return i.editReply(`🔒 تم قفل ${ch}`);
    }

    if (i.commandName === "فتح-الروم") {
      const ch = i.options.getChannel("روم", true);
      if (!ch.isTextBased()) return i.editReply("❌ هذا مو روم كتابي.");
      await ch.permissionOverwrites.edit(guild.roles.everyone.id, { SendMessages: null }).catch(() => {});
      return i.editReply(`🔓 تم فتح ${ch}`);
    }

    // = Tickets
    if (i.commandName === "ضبط-تيكت") {
      const cat = i.options.getChannel("كاتيقوري", true);
      const role = i.options.getRole("رتبة-الدعم", true);

      if (cat.type !== ChannelType.GuildCategory) return i.editReply("❌ لازم تختار Category.");

      cfg.ticket.categoryId = cat.id;
      cfg.ticket.supportRoleId = role.id;
      writeJSON(CONFIG_FILE, configDB);

      return i.editReply(`✅ تم ضبط التيكت:\n📁 الكاتيقوري: ${cat}\n🛡️ رتبة الدعم: ${role}`);
    }

    if (i.commandName === "ارسال-بانل-تيكت") {
      const ch = i.options.getChannel("روم", true);
      if (!ch.isTextBased()) return i.editReply("❌ لازم روم كتابي.");

      await ch.send({ embeds: [ticketPanelEmbed()], components: [ticketButtonsRow()] }).catch(() => {});
      cfg.ticket.panelChannelId = ch.id;
      writeJSON(CONFIG_FILE, configDB);

      return i.editReply(`✅ تم إرسال بانل التيكت في ${ch}`);
    }

    // = Reset guild
    if (i.commandName === "تصفير-السيرفر") {
      // امسح مستويات السيرفر
      for (const k of Object.keys(levelsDB)) {
        if (k.startsWith(guild.id + ":")) delete levelsDB[k];
      }
      writeJSON(LEVELS_FILE, levelsDB);

      // امسح إعدادات السيرفر
      delete configDB[guild.id];
      writeJSON(CONFIG_FILE, configDB);

      return i.editReply("✅ تم تصفير بيانات البوت لهذا السيرفر (XP + إعدادات).");
    }

    return i.editReply("❓ أمر غير معروف.");
  } catch (e) {
    try {
      const msg = `⚠️ خطأ: ${e?.message || e}`;
      if (i.deferred || i.replied) return i.editReply(msg);
      return i.reply({ content: msg, ephemeral: true });
    } catch {}
  }
});

// ============ READY ============
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommandsGlobal().catch(err => console.log("❌ register error:", err?.message || err));
});

client.login(TOKEN);
