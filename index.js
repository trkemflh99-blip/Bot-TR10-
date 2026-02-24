// ================= KEEP ALIVE =================
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Bot Running"));
app.listen(process.env.PORT || 3000);

// ================= DISCORD =================
const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionsBitField
} = require("discord.js");

const fs = require("fs");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.log("❌ حط TOKEN و CLIENT_ID في Environment");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// ================= DATABASE =================
if (!fs.existsSync("./data.json")) {
  fs.writeFileSync("./data.json", JSON.stringify({
    users: {},
    settings: {},
    lastDaily: Date.now(),
    lastWeekly: Date.now()
  }, null, 2));
}

let db = JSON.parse(fs.readFileSync("./data.json"));

function saveDB() {
  fs.writeFileSync("./data.json", JSON.stringify(db, null, 2));
}

function getUser(guild, user) {
  if (!db.users[guild]) db.users[guild] = {};
  if (!db.users[guild][user]) {
    db.users[guild][user] = {
      text: 0,
      voice: 0,
      dailyText: 0,
      dailyVoice: 0,
      weeklyText: 0,
      weeklyVoice: 0,
      level: 0
    };
  }
  return db.users[guild][user];
}

// ================= LEVEL SYSTEM =================
function checkLevel(member, guildId) {
  const user = getUser(guildId, member.id);
  const total = user.text + user.voice;
  const needed = (user.level + 1) * 500;

  if (total >= needed) {
    user.level++;

    const settings = db.settings[guildId] || {};
    const msgTpl = settings.levelMsg || "🎉 {user} وصلت لفل {level}!";
    const chId = settings.levelChannel;

    if (chId) {
      const ch = member.guild.channels.cache.get(chId);
      if (ch)
        ch.send(
          msgTpl.replace("{user}", `<@${member.id}>`)
                .replace("{level}", user.level)
        );
    }

    if (settings.levelRole && user.level >= settings.levelRole.level) {
      const role = member.guild.roles.cache.get(settings.levelRole.roleId);
      if (role) member.roles.add(role).catch(() => {});
    }

    saveDB();
  }
}

// ================= TEXT XP =================
client.on("messageCreate", msg => {
  if (!msg.guild || msg.author.bot) return;

  const user = getUser(msg.guild.id, msg.author.id);

  user.text += 10;
  user.dailyText += 10;
  user.weeklyText += 10;

  checkLevel(msg.member, msg.guild.id);
  saveDB();

  if (msg.content === "!help") {
    msg.reply("استخدم /help لعرض الأوامر");
  }
});

// ================= VOICE XP =================
setInterval(() => {
  client.guilds.cache.forEach(guild => {
    guild.members.cache.forEach(member => {
      if (member.voice.channel && !member.user.bot) {
        const user = getUser(guild.id, member.id);
        user.voice += 5;
        user.dailyVoice += 5;
        user.weeklyVoice += 5;
        checkLevel(member, guild.id);
      }
    });
  });
  saveDB();
}, 60000);

// ================= RESET SYSTEM =================
setInterval(() => {
  const now = Date.now();

  if (now - db.lastDaily >= 24 * 60 * 60 * 1000) {
    for (const g in db.users)
      for (const u in db.users[g]) {
        db.users[g][u].dailyText = 0;
        db.users[g][u].dailyVoice = 0;
      }
    db.lastDaily = now;
    console.log("🔄 Daily Reset");
  }

  if (now - db.lastWeekly >= 7 * 24 * 60 * 60 * 1000) {
    for (const g in db.users)
      for (const u in db.users[g]) {
        db.users[g][u].weeklyText = 0;
        db.users[g][u].weeklyVoice = 0;
      }
    db.lastWeekly = now;
    console.log("🔄 Weekly Reset");
  }

  saveDB();
}, 60000);

// ================= COMMANDS =================
const commands = [
  new SlashCommandBuilder()
    .setName("xp")
    .setDescription("عرض الاكس بي")
    .addStringOption(o =>
      o.setName("mode")
        .setDescription("v = صوتي / t = دردشة")
        .addChoices(
          { name: "voice", value: "v" },
          { name: "text", value: "t" }
        )
    )
    .addStringOption(o =>
      o.setName("type")
        .setDescription("day / week")
        .addChoices(
          { name: "day", value: "day" },
          { name: "week", value: "week" }
        )
    ),

  new SlashCommandBuilder().setName("top").setDescription("توب 10 كلي"),
  new SlashCommandBuilder().setName("topweek").setDescription("توب أسبوعي"),
  new SlashCommandBuilder().setName("help").setDescription("عرض الأوامر"),

  new SlashCommandBuilder()
    .setName("setlevelchannel")
    .setDescription("تحديد روم التبريكات")
    .addChannelOption(o =>
      o.setName("channel").setDescription("اختر روم").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  new SlashCommandBuilder()
    .setName("setlevelmsg")
    .setDescription("تغيير رسالة التبريك")
    .addStringOption(o =>
      o.setName("message").setDescription("استخدم {user} و {level}").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  new SlashCommandBuilder()
    .setName("setlevelrole")
    .setDescription("تحديد رتبة لفل معين")
    .addIntegerOption(o =>
      o.setName("level").setDescription("رقم اللفل").setRequired(true))
    .addRoleOption(o =>
      o.setName("role").setDescription("اختر رتبة").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
].map(c => c.toJSON());

// ================= REGISTER & DELETE OLD =================
const rest = new REST({ version: "10" }).setToken(TOKEN);

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // حذف الأوامر القديمة
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });

  // تسجيل الجديدة
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
});

// ================= INTERACTION =================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply();

  const guildId = interaction.guild.id;
  const user = getUser(guildId, interaction.user.id);

  if (interaction.commandName === "xp") {
    const mode = interaction.options.getString("mode");
    const type = interaction.options.getString("type");

    let text = user.text;
    let voice = user.voice;

    if (type === "day") {
      text = user.dailyText;
      voice = user.dailyVoice;
    }
    if (type === "week") {
      text = user.weeklyText;
      voice = user.weeklyVoice;
    }

    if (mode === "v") return interaction.editReply(`🎙️ Voice XP: ${voice}`);
    if (mode === "t") return interaction.editReply(`💬 Text XP: ${text}`);

    return interaction.editReply(
      `📊 Text: ${text}\n🎙️ Voice: ${voice}\n🏅 Level: ${user.level}`
    );
  }

  if (interaction.commandName === "top") {
    const users = db.users[guildId] || {};
    const sorted = Object.entries(users)
      .sort((a, b) => (b[1].text + b[1].voice) - (a[1].text + a[1].voice))
      .slice(0, 10);

    let msg = "🏆 Top 10\n\n";
    sorted.forEach((u, i) => {
      msg += `${i + 1}. <@${u[0]}> - ${u[1].text + u[1].voice}\n`;
    });

    return interaction.editReply(msg);
  }

  if (interaction.commandName === "topweek") {
    const users = db.users[guildId] || {};
    const sorted = Object.entries(users)
      .sort((a, b) => (b[1].weeklyText + b[1].weeklyVoice) - (a[1].weeklyText + a[1].weeklyVoice))
      .slice(0, 10);

    let msg = "🏆 Top Weekly\n\n";
    sorted.forEach((u, i) => {
      msg += `${i + 1}. <@${u[0]}> - ${u[1].weeklyText + u[1].weeklyVoice}\n`;
    });

    return interaction.editReply(msg);
  }

  if (interaction.commandName === "help") {
    return interaction.editReply(`
📘 أوامر البوت

/xp
/top
/topweek
/setlevelchannel
/setlevelmsg
/setlevelrole
!help
`);
  }
});

client.login(TOKEN);
