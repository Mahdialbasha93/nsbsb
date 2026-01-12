require('dotenv').config();
const { Client, Intents, MessageEmbed, MessageActionRow, MessageButton, MessageSelectMenu } = require('discord.js');
const https = require('https');

// ====== Configuration ======
const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    ALLOWED_USER_IDS: (process.env.ALLOWED_USER_IDS || '').split(',').map(id => id.trim()),
    AUTO_RECONNECT: true,
    MAX_RECONNECT_ATTEMPTS: 3,
    SLOW_THRESHOLD: 30000,
    RECONNECT_DELAY: 5000,
    EMOJI_DELAY: 2000,
    OPERATION_DELAY: 200
};

// ====== Check Environment Variables ======
if (!CONFIG.BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is not set in environment variables!');
    console.info('📝 Please set BOT_TOKEN in GitHub Secrets');
    console.info('🔧 Get bot token from: https://discord.com/developers/applications');
    process.exit(1);
}

if (!CONFIG.ALLOWED_USER_IDS || CONFIG.ALLOWED_USER_IDS.length === 0 || CONFIG.ALLOWED_USER_IDS[0] === '') {
    console.error('❌ ALLOWED_USER_IDS is not set!');
    console.info('📝 Please set ALLOWED_USER_IDS in GitHub Secrets (comma separated user IDs)');
    process.exit(1);
}

// ====== Colors for Console ======
const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    white: '\x1b[37m',
    reset: '\x1b[0m'
};

// ====== Logger ======
const log = {
    success: (msg) => console.log(`${colors.green}[+] ${msg}${colors.reset}`),
    error: (msg) => console.log(`${colors.red}[-] ${msg}${colors.reset}`),
    warning: (msg) => console.log(`${colors.yellow}[!] ${msg}${colors.reset}`),
    info: (msg) => console.log(`${colors.cyan}[i] ${msg}${colors.reset}`),
    header: (msg) => console.log(`${colors.magenta}${msg}${colors.reset}`)
};

// ====== Banner ======
log.header(`
╔══════════════════════════════════════════╗
║     DISCORD SERVER CLONER BOT           ║
║      with Interactive Menu              ║
╚══════════════════════════════════════════╝`);

log.info(`✅ Bot token loaded: ${CONFIG.BOT_TOKEN.substring(0, 10)}...`);
log.info(`✅ Allowed users: ${CONFIG.ALLOWED_USER_IDS.join(', ')}`);

// ====== Helper Functions ======
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function downloadImage(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const base64 = buffer.toString('base64');
                const mimeType = res.headers['content-type'] || 'image/png';
                resolve(`data:${mimeType};base64,${base64}`);
            });
            res.on('error', reject);
        });
        
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('Download timeout'));
        });
        
        req.on('error', reject);
    });
}

// ====== Discord Client Setup ======
const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.DIRECT_MESSAGES,
        Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
        Intents.FLAGS.GUILD_INVITES
    ],
    partials: ['CHANNEL', 'MESSAGE', 'REACTION']
});

// ====== Store for Active Cloning Operations ======
const activeOperations = new Map(); // userID -> { state, data, logChannel, logs }

// ====== Discord Selfbot Module (Will be loaded dynamically) ======
let DiscordSelfbot;
try {
    DiscordSelfbot = require('discord.js-selfbot-v13');
    log.success('✅ Selfbot module loaded successfully');
} catch (error) {
    log.error('❌ Failed to load selfbot module. Make sure discord.js-selfbot-v13 is installed.');
    log.info('📦 Run: npm install discord.js-selfbot-v13');
    process.exit(1);
}

// ====== Server Cloner Class ======
class ServerCloner {
    constructor(selfbotClient, connectionManager) {
        this.selfbotClient = selfbotClient;
        this.connectionManager = connectionManager;
        this.roleMapping = new Map();
        this.stats = {
            roles: 0,
            categories: 0,
            channels: 0,
            emojis: 0,
            reconnects: 0,
            failed: 0
        };
        this.isCloning = false;
        this.logChannel = null;
        this.userId = null;
    }

    async safeOperation(operation, description) {
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                this.connectionManager.updateActivity();
                const result = await Promise.race([
                    operation(),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Operation timeout')), 60000)
                    )
                ]);
                this.connectionManager.updateActivity();
                return result;
            } catch (error) {
                attempts++;
                
                if (attempts >= maxAttempts) {
                    throw error;
                }
                
                if (error.message.includes('timeout') || error.message.includes('rate limit') || 
                    error.message.includes('slow') || error.message.includes('ECONNRESET')) {
                    
                    this.addLog(`🔄 Retrying ${description} (${attempts}/${maxAttempts})...`);
                    
                    if (attempts === 2 && CONFIG.AUTO_RECONNECT) {
                        this.addLog('⚡ Auto-reconnecting to improve speed...');
                        await this.connectionManager.reconnect();
                        this.stats.reconnects++;
                    }
                    
                    await delay(2000 * attempts);
                } else {
                    throw error;
                }
            }
        }
    }

    async cloneServer(sourceGuildId, targetGuildId, cloneEmojis = true) {
        if (this.isCloning) {
            throw new Error('Already cloning a server!');
        }

        this.isCloning = true;
        this.connectionManager.startSlowDetection(() => {
            this.stats.reconnects++;
            this.addLog('🔄 Auto-reconnected to improve speed');
        });

        try {
            const sourceGuild = this.selfbotClient.guilds.cache.get(sourceGuildId);
            const targetGuild = this.selfbotClient.guilds.cache.get(targetGuildId);

            if (!sourceGuild) {
                throw new Error('Source server not found! Make sure you are a member.');
            }

            if (!targetGuild) {
                throw new Error('Target server not found! Make sure you are a member with Admin permissions.');
            }

            this.addLog(`🚀 Starting clone: **${sourceGuild.name}** → **${targetGuild.name}**`);
            this.addLog('⏳ This may take several minutes...');

            // Delete existing content
            await this.deleteExistingContent(targetGuild);
            
            // Clone roles
            await this.cloneRoles(sourceGuild, targetGuild);
            
            // Clone categories
            await this.cloneCategories(sourceGuild, targetGuild);
            
            // Clone channels
            await this.cloneChannels(sourceGuild, targetGuild);
            
            // Clone emojis
            if (cloneEmojis) {
                await this.cloneEmojis(sourceGuild, targetGuild);
            }
            
            // Clone server settings
            await this.cloneServerSettings(sourceGuild, targetGuild);

            // Show statistics
            this.showStats();
            this.addLog('🎉 **Server cloned successfully!**');

        } catch (error) {
            this.addLog(`❌ **Clone failed:** ${error.message}`);
            throw error;
        } finally {
            this.isCloning = false;
            this.connectionManager.stopSlowDetection();
        }
    }

    async deleteExistingContent(guild) {
        this.addLog('🗑️  Deleting existing channels and roles...');
        
        // Delete channels
        const channels = guild.channels.cache.filter(ch => ch.deletable);
        for (const [, channel] of channels) {
            try {
                await this.safeOperation(() => channel.delete(), `Delete channel ${channel.name}`);
                await delay(CONFIG.OPERATION_DELAY);
            } catch (error) {
                this.stats.failed++;
            }
        }

        // Delete roles
        const roles = guild.roles.cache.filter(role => 
            role.name !== '@everyone' && 
            !role.managed && 
            role.editable
        );
        
        for (const [, role] of roles) {
            try {
                await this.safeOperation(() => role.delete(), `Delete role ${role.name}`);
                await delay(CONFIG.OPERATION_DELAY);
            } catch (error) {
                this.stats.failed++;
            }
        }

        this.addLog('✅ Cleanup completed');
    }

    async cloneRoles(sourceGuild, targetGuild) {
        this.addLog('👑 Cloning roles...');
        
        const roles = sourceGuild.roles.cache
            .filter(role => role.name !== '@everyone')
            .sort((a, b) => a.position - b.position);

        for (const [, role] of roles) {
            try {
                await this.safeOperation(async () => {
                    const newRole = await targetGuild.roles.create({
                        name: role.name,
                        color: role.hexColor,
                        permissions: role.permissions,
                        hoist: role.hoist,
                        mentionable: role.mentionable,
                        reason: 'Server cloning'
                    });

                    this.roleMapping.set(role.id, newRole.id);
                    this.stats.roles++;
                }, `Create role ${role.name}`);
                
                await delay(CONFIG.OPERATION_DELAY);

            } catch (error) {
                this.addLog(`⚠️ Failed role **${role.name}**: ${error.message}`);
                this.stats.failed++;
            }
        }

        this.addLog(`✅ Created **${this.stats.roles}** roles`);
    }

    async cloneCategories(sourceGuild, targetGuild) {
        this.addLog('📁 Cloning categories...');
        
        const categories = sourceGuild.channels.cache
            .filter(ch => ch.type === 'GUILD_CATEGORY')
            .sort((a, b) => a.position - b.position);

        for (const [, category] of categories) {
            try {
                await this.safeOperation(async () => {
                    const overwrites = this.mapPermissionOverwrites(category.permissionOverwrites, targetGuild);
                    
                    await targetGuild.channels.create(category.name, {
                        type: 'GUILD_CATEGORY',
                        permissionOverwrites: overwrites || [],
                        position: category.position,
                        reason: 'Server cloning'
                    });

                    this.stats.categories++;
                }, `Create category ${category.name}`);
                
                await delay(CONFIG.OPERATION_DELAY);

            } catch (error) {
                this.addLog(`⚠️ Failed category **${category.name}**: ${error.message}`);
                this.stats.failed++;
            }
        }

        this.addLog(`✅ Created **${this.stats.categories}** categories`);
    }

    async cloneChannels(sourceGuild, targetGuild) {
        this.addLog('💬 Cloning channels...');
        
        const channels = sourceGuild.channels.cache
            .filter(ch => ch.type === 'GUILD_TEXT' || ch.type === 'GUILD_VOICE')
            .sort((a, b) => a.position - b.position);

        for (const [, channel] of channels) {
            try {
                await this.safeOperation(async () => {
                    const overwrites = this.mapPermissionOverwrites(channel.permissionOverwrites, targetGuild);
                    const parent = channel.parent ? 
                        targetGuild.channels.cache.find(c => c.name === channel.parent.name && c.type === 'GUILD_CATEGORY') : 
                        null;

                    const channelOptions = {
                        type: channel.type,
                        parent: parent?.id,
                        permissionOverwrites: overwrites || [],
                        position: channel.position,
                        reason: 'Server cloning'
                    };

                    if (channel.type === 'GUILD_TEXT') {
                        channelOptions.topic = channel.topic || '';
                        channelOptions.nsfw = channel.nsfw;
                        channelOptions.rateLimitPerUser = channel.rateLimitPerUser;
                    } else if (channel.type === 'GUILD_VOICE') {
                        channelOptions.bitrate = channel.bitrate;
                        channelOptions.userLimit = channel.userLimit;
                    }

                    await targetGuild.channels.create(channel.name, channelOptions);
                    this.stats.channels++;
                }, `Create channel ${channel.name}`);
                
                await delay(CONFIG.OPERATION_DELAY);

            } catch (error) {
                this.addLog(`⚠️ Failed channel **${channel.name}**: ${error.message}`);
                this.stats.failed++;
            }
        }

        this.addLog(`✅ Created **${this.stats.channels}** channels`);
    }

    async cloneEmojis(sourceGuild, targetGuild) {
        this.addLog('😀 Cloning emojis...');
        
        const emojis = sourceGuild.emojis.cache;
        
        for (const [, emoji] of emojis) {
            try {
                if (!emoji.url) {
                    this.stats.failed++;
                    continue;
                }

                await this.safeOperation(async () => {
                    const imageData = await downloadImage(emoji.url);
                    
                    await targetGuild.emojis.create(imageData, emoji.name, {
                        reason: 'Server cloning'
                    });

                    this.stats.emojis++;
                }, `Create emoji ${emoji.name}`);
                
                await delay(CONFIG.EMOJI_DELAY);

            } catch (error) {
                this.addLog(`⚠️ Failed emoji **${emoji.name}**: ${error.message}`);
                this.stats.failed++;
                continue;
            }
        }

        this.addLog(`✅ Created **${this.stats.emojis}** emojis`);
    }

    async cloneServerSettings(sourceGuild, targetGuild) {
        this.addLog('⚙️  Cloning server settings...');
        
        try {
            let iconData = null;
            
            if (sourceGuild.iconURL()) {
                try {
                    iconData = await downloadImage(sourceGuild.iconURL({ format: 'png', size: 1024 }));
                } catch (error) {
                    this.addLog('⚠️ Could not download server icon');
                }
            }

            await this.safeOperation(async () => {
                await targetGuild.setName(sourceGuild.name);
                
                if (iconData) {
                    await targetGuild.setIcon(iconData);
                }
            }, 'Update server settings');

            this.addLog(`✅ Updated server name: **${sourceGuild.name}**`);
            if (iconData) {
                this.addLog('✅ Updated server icon');
            }

        } catch (error) {
            this.addLog(`⚠️ Failed server settings: ${error.message}`);
            this.stats.failed++;
        }
    }

    mapPermissionOverwrites(overwrites, targetGuild) {
        const mappedOverwrites = [];

        if (!overwrites || !overwrites.cache) {
            return mappedOverwrites;
        }

        overwrites.cache.forEach((overwrite) => {
            try {
                let targetId = overwrite.id;

                if (overwrite.type === 'role') {
                    const newRoleId = this.roleMapping.get(overwrite.id);
                    if (newRoleId) {
                        targetId = newRoleId;
                    } else {
                        return;
                    }
                }

                if (overwrite.allow !== undefined && overwrite.deny !== undefined) {
                    mappedOverwrites.push({
                        id: targetId,
                        type: overwrite.type,
                        allow: overwrite.allow,
                        deny: overwrite.deny
                    });
                }
            } catch (error) {
                // Skip error
            }
        });

        return mappedOverwrites;
    }

    showStats() {
        const total = this.stats.roles + this.stats.categories + 
                     this.stats.channels + this.stats.emojis;
        const successRate = total > 0 ? Math.round((total/(total + this.stats.failed)) * 100) : 0;
        
        const statsMessage = `
📊 **Clone Statistics:**
✅ Roles: ${this.stats.roles}
✅ Categories: ${this.stats.categories}
✅ Channels: ${this.stats.channels}
✅ Emojis: ${this.stats.emojis}
🔄 Auto-Reconnects: ${this.stats.reconnects}
❌ Failed: ${this.stats.failed}
📈 Success Rate: ${successRate}%`;
        
        this.addLog(statsMessage);
    }

    addLog(message) {
        if (this.logChannel) {
            // Clean message for Discord
            const discordMessage = message.replace(/\*\*/g, '**');
            this.logChannel.send(discordMessage).catch(() => {});
        }
        
        // Log to console
        const cleanMessage = message.replace(/\*\*/g, '').trim();
        
        if (message.includes('❌') || message.includes('Failed')) {
            log.error(`[User ${this.userId}] ${cleanMessage}`);
        } else if (message.includes('✅') || message.includes('Created') || message.includes('Updated')) {
            log.success(`[User ${this.userId}] ${cleanMessage}`);
        } else if (message.includes('⚠️')) {
            log.warning(`[User ${this.userId}] ${cleanMessage}`);
        } else {
            log.info(`[User ${this.userId}] ${cleanMessage}`);
        }
    }
}

// ====== Connection Manager ======
class ConnectionManager {
    constructor(selfbotClient) {
        this.selfbotClient = selfbotClient;
        this.reconnectAttempts = 0;
        this.lastActivityTime = Date.now();
        this.slowDetectionInterval = null;
        this.isReconnecting = false;
    }

    updateActivity() {
        this.lastActivityTime = Date.now();
    }

    isSlow() {
        return Date.now() - this.lastActivityTime > CONFIG.SLOW_THRESHOLD;
    }

    async reconnect() {
        if (this.isReconnecting || this.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
            return false;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        log.warning(`🔄 Reconnecting... (${this.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})`);

        try {
            this.selfbotClient.destroy();
            await delay(CONFIG.RECONNECT_DELAY);
            
            // Create new selfbot client
            const newSelfbotClient = new DiscordSelfbot.Client();
            await newSelfbotClient.login(this.selfbotClient.token);
            
            log.success('✅ Reconnected successfully!');
            this.selfbotClient = newSelfbotClient;
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            this.updateActivity();
            
            return true;
        } catch (error) {
            log.error(`❌ Reconnect failed: ${error.message}`);
            this.isReconnecting = false;
            return false;
        }
    }

    startSlowDetection(callback) {
        if (this.slowDetectionInterval) {
            clearInterval(this.slowDetectionInterval);
        }

        this.slowDetectionInterval = setInterval(() => {
            if (CONFIG.AUTO_RECONNECT && this.isSlow() && !this.isReconnecting) {
                log.warning('⚡ Slow operation detected, auto-reconnecting...');
                this.reconnect().then(success => {
                    if (success && callback) {
                        callback();
                    }
                });
            }
        }, 10000);
    }

    stopSlowDetection() {
        if (this.slowDetectionInterval) {
            clearInterval(this.slowDetectionInterval);
            this.slowDetectionInterval = null;
        }
    }
}

// ====== Bot Events ======
client.on('ready', () => {
    log.success(`✅ Bot logged in as ${client.user.tag}`);
    log.info(`📊 Bot is in ${client.guilds.cache.size} servers`);
    log.info('🤖 Use !clone to start cloning process');
});

client.on('messageCreate', async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;
    
    // Check if user is allowed
    if (!CONFIG.ALLOWED_USER_IDS.includes(message.author.id)) {
        return;
    }

    // !clone command - Show menu
    if (message.content === '!clone') {
        const userOp = activeOperations.get(message.author.id);
        
        if (userOp && userOp.state === 'cloning') {
            message.channel.send('❌ You already have an active cloning operation!');
            return;
        }

        // Create embed with form
        const embed = new MessageEmbed()
            .setColor('#7289da')
            .setTitle('🚀 Discord Server Cloner')
            .setDescription('Please fill in the following information to clone a server:')
            .addFields(
                { name: '🔑 Selfbot Token', value: 'Your Discord account token (for selfbot)' },
                { name: '📤 Source Server ID', value: 'The server you want to copy FROM' },
                { name: '📥 Target Server ID', value: 'The server you want to copy TO' }
            )
            .setFooter('⚠️ WARNING: This will delete all content in the target server!')
            .setTimestamp();

        // Create action rows with buttons
        const row1 = new MessageActionRow()
            .addComponents(
                new MessageButton()
                    .setCustomId('start_clone')
                    .setLabel('📝 Start Cloning Process')
                    .setStyle('PRIMARY')
            );

        const row2 = new MessageActionRow()
            .addComponents(
                new MessageButton()
                    .setCustomId('cancel_clone')
                    .setLabel('❌ Cancel')
                    .setStyle('DANGER')
            );

        // Send the message
        const menuMessage = await message.channel.send({
            embeds: [embed],
            components: [row1, row2]
        });

        // Store operation state
        activeOperations.set(message.author.id, {
            state: 'awaiting_start',
            data: {},
            logChannel: message.channel,
            logs: [],
            menuMessage: menuMessage
        });

        // Create a DM channel for sensitive info
        try {
            const dmChannel = await message.author.createDM();
            
            const dmEmbed = new MessageEmbed()
                .setColor('#ff9900')
                .setTitle('🔒 Security Notice')
                .setDescription('For security, please send the following information in this DM:')
                .addFields(
                    { name: '1️⃣ Your Discord Token', value: 'Send: `token YOUR_TOKEN_HERE`' },
                    { name: '2️⃣ Source Server ID', value: 'Send: `source SERVER_ID`' },
                    { name: '3️⃣ Target Server ID', value: 'Send: `target SERVER_ID`' },
                    { name: '🔧 Example', value: '```\ntoken abc123...\nsource 1234567890\ntarget 9876543210\n```' }
                )
                .setFooter('This information will be deleted after cloning')
                .setTimestamp();

            dmChannel.send({ embeds: [dmEmbed] });
            
            // Update operation with DM channel
            const op = activeOperations.get(message.author.id);
            op.dmChannel = dmChannel;
            activeOperations.set(message.author.id, op);
            
        } catch (error) {
            message.channel.send('❌ Cannot send DM. Please enable DMs from server members.');
        }
    }

    // Handle DM messages for cloning data
    if (message.channel.type === 'DM' && !message.author.bot) {
        const userOp = activeOperations.get(message.author.id);
        
        if (!userOp || userOp.state !== 'awaiting_start') {
            return;
        }

        const content = message.content.trim().toLowerCase();
        
        if (content.startsWith('token ')) {
            const token = message.content.slice(6).trim();
            userOp.data.token = token;
            message.channel.send('✅ Token received! Now send source server ID: `source SERVER_ID`');
        } 
        else if (content.startsWith('source ')) {
            const sourceId = message.content.slice(7).trim();
            if (!/^\d+$/.test(sourceId)) {
                message.channel.send('❌ Invalid server ID! Must be numbers only.');
                return;
            }
            userOp.data.sourceId = sourceId;
            message.channel.send('✅ Source server ID received! Now send target server ID: `target SERVER_ID`');
        } 
        else if (content.startsWith('target ')) {
            const targetId = message.content.slice(7).trim();
            if (!/^\d+$/.test(targetId)) {
                message.channel.send('❌ Invalid server ID! Must be numbers only.');
                return;
            }
            userOp.data.targetId = targetId;
            userOp.state = 'data_received';
            
            // Ask for confirmation
            const confirmEmbed = new MessageEmbed()
                .setColor('#00ff00')
                .setTitle('✅ All Data Received!')
                .setDescription('Please confirm to start cloning:')
                .addFields(
                    { name: 'Source Server ID', value: userOp.data.sourceId, inline: true },
                    { name: 'Target Server ID', value: userOp.data.targetId, inline: true },
                    { name: 'Clone Emojis?', value: 'Yes (default)', inline: true }
                )
                .setFooter('React with ✅ to confirm or ❌ to cancel')
                .setTimestamp();

            const confirmMessage = await message.channel.send({ embeds: [confirmEmbed] });
            await confirmMessage.react('✅');
            await confirmMessage.react('❌');
            
            userOp.confirmMessage = confirmMessage;
            activeOperations.set(message.author.id, userOp);
        }
    }
});

// Handle button clicks
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    
    const userOp = activeOperations.get(interaction.user.id);
    if (!userOp) return;
    
    if (interaction.customId === 'start_clone') {
        if (userOp.state === 'data_received') {
            // Start the cloning process
            userOp.state = 'cloning';
            activeOperations.set(interaction.user.id, userOp);
            
            await interaction.update({
                content: '🚀 Starting cloning process... This may take several minutes.',
                components: [],
                embeds: []
            });
            
            // Create selfbot client with user's token
            try {
                const selfbotClient = new DiscordSelfbot.Client();
                await selfbotClient.login(userOp.data.token);
                
                const connectionManager = new ConnectionManager(selfbotClient);
                const cloner = new ServerCloner(selfbotClient, connectionManager);
                
                // Set log channel and user ID
                cloner.logChannel = userOp.logChannel;
                cloner.userId = interaction.user.id;
                
                // Start cloning
                await cloner.cloneServer(userOp.data.sourceId, userOp.data.targetId, true);
                
                // Clean up
                selfbotClient.destroy();
                activeOperations.delete(interaction.user.id);
                
                // Delete DM messages for security
                if (userOp.dmChannel) {
                    try {
                        const messages = await userOp.dmChannel.messages.fetch({ limit: 50 });
                        messages.forEach(msg => {
                            if (msg.author.id === client.user.id || msg.content.includes('token')) {
                                msg.delete().catch(() => {});
                            }
                        });
                    } catch (e) {}
                }
                
            } catch (error) {
                userOp.logChannel.send(`❌ Cloning failed: ${error.message}`);
                log.error(`Cloning failed for user ${interaction.user.id}: ${error.message}`);
                activeOperations.delete(interaction.user.id);
            }
        } else {
            await interaction.reply({
                content: '❌ Please provide all required information in DMs first!',
                ephemeral: true
            });
        }
    } 
    else if (interaction.customId === 'cancel_clone') {
        activeOperations.delete(interaction.user.id);
        await interaction.update({
            content: '❌ Cloning cancelled.',
            components: [],
            embeds: []
        });
    }
});

// Handle reaction confirmation
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    
    const userOp = activeOperations.get(user.id);
    if (!userOp || !userOp.confirmMessage) return;
    
    if (reaction.message.id === userOp.confirmMessage.id) {
        if (reaction.emoji.name === '✅') {
            userOp.state = 'ready_to_start';
            activeOperations.set(user.id, userOp);
            
            // Update menu message in main channel
            const updatedEmbed = new MessageEmbed()
                .setColor('#00ff00')
                .setTitle('✅ Ready to Start!')
                .setDescription('All data received and confirmed!')
                .addFields(
                    { name: 'Source Server ID', value: userOp.data.sourceId, inline: true },
                    { name: 'Target Server ID', value: userOp.data.targetId, inline: true },
                    { name: 'Status', value: '✅ Ready to start', inline: true }
                )
                .setFooter('Click "Start Cloning Process" button to begin')
                .setTimestamp();

            // Update buttons
            const row1 = new MessageActionRow()
                .addComponents(
                    new MessageButton()
                        .setCustomId('start_clone')
                        .setLabel('🚀 Start Cloning Now!')
                        .setStyle('SUCCESS')
                );

            const row2 = new MessageActionRow()
                .addComponents(
                    new MessageButton()
                        .setCustomId('cancel_clone')
                        .setLabel('❌ Cancel')
                        .setStyle('DANGER')
                );

            await userOp.menuMessage.edit({
                embeds: [updatedEmbed],
                components: [row1, row2]
            });
            
            // Send confirmation in DM
            userOp.dmChannel.send('✅ Confirmed! Return to the server channel and click "Start Cloning Now!"');
            
        } else if (reaction.emoji.name === '❌') {
            activeOperations.delete(user.id);
            userOp.dmChannel.send('❌ Cloning cancelled.');
            userOp.menuMessage.edit({
                content: '❌ Cloning cancelled by user.',
                components: [],
                embeds: []
            });
        }
    }
});

// Error handling
client.on('error', (error) => {
    log.error(`Bot error: ${error.message}`);
});

process.on('unhandledRejection', (error) => {
    log.error(`Unhandled rejection: ${error.message}`);
});

process.on('uncaughtException', (error) => {
    log.error(`Uncaught exception: ${error.message}`);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
    log.warning('Shutting down bot...');
    client.destroy();
    process.exit(0);
});

// Login bot
client.login(CONFIG.BOT_TOKEN).catch((error) => {
    log.error(`Bot login failed: ${error.message}`);
    process.exit(1);
});
