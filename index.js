require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const https = require('https');

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

// ====== Configuration ======
const CONFIG = {
    TOKEN: process.env.TOKEN || process.env.DISCORD_TOKEN,
    ALLOWED_USER_IDS: (process.env.ALLOWED_USER_IDS || '').split(',').map(id => id.trim()),
    AUTO_RECONNECT: true,
    MAX_RECONNECT_ATTEMPTS: 3,
    SLOW_THRESHOLD: 30000,
    RECONNECT_DELAY: 5000,
    EMOJI_DELAY: 2000,
    OPERATION_DELAY: 200
};

// ====== Check Environment Variables ======
if (!CONFIG.TOKEN) {
    log.error('❌ TOKEN is not set in environment variables!');
    log.info('📝 Please set TOKEN or DISCORD_TOKEN in GitHub Secrets');
    log.info('🔧 Go to: Repository Settings → Secrets and variables → Actions');
    process.exit(1);
}

if (!CONFIG.ALLOWED_USER_IDS || CONFIG.ALLOWED_USER_IDS.length === 0 || CONFIG.ALLOWED_USER_IDS[0] === '') {
    log.error('❌ ALLOWED_USER_IDS is not set!');
    log.info('📝 Please set ALLOWED_USER_IDS in GitHub Secrets (comma separated)');
    log.info('👤 Example: 123456789012345678,987654321098765432');
    process.exit(1);
}

// ====== Banner ======
log.header(`
╔══════════════════════════════════════════╗
║   DISCORD SERVER CLONER BOT              ║
║     Version: discord.js-selfbot-v13@1.3.0║
╚══════════════════════════════════════════╝`);

log.info(`✅ Token loaded: ${CONFIG.TOKEN.substring(0, 10)}...`);
log.info(`✅ Allowed users: ${CONFIG.ALLOWED_USER_IDS.join(', ')}`);

// ====== Helper Functions ======
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function downloadImage(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
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
        }).on('error', reject);
    });
}

// ====== Connection Manager ======
class ConnectionManager {
    constructor(client) {
        this.client = client;
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
            // Destroy current client
            this.client.destroy();
            await delay(CONFIG.RECONNECT_DELAY);
            
            // Create new client
            const newClient = new Client();
            
            // Set up event listeners for new client
            setupClientEvents(newClient);
            
            // Login
            await newClient.login(CONFIG.TOKEN);
            
            log.success('✅ Reconnected successfully!');
            this.client = newClient;
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            
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
                log.warning('⚡ Slow operation detected, reconnecting...');
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

// ====== Server Cloner ======
class ServerCloner {
    constructor(client, connectionManager) {
        this.client = client;
        this.connectionManager = connectionManager;
        this.roleMapping = new Map();
        this.stats = {
            rolesCreated: 0,
            categoriesCreated: 0,
            channelsCreated: 0,
            emojisCreated: 0,
            reconnects: 0,
            failed: 0
        };
        this.isCloning = false;
        this.currentOperation = null;
    }

    async safeOperation(operation, description) {
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                this.connectionManager.updateActivity();
                const result = await operation();
                this.connectionManager.updateActivity();
                return result;
            } catch (error) {
                attempts++;
                
                if (attempts >= maxAttempts) {
                    throw error;
                }
                
                if (error.message.includes('rate limit') || error.message.includes('timeout') || error.message.includes('slow')) {
                    log.warning(`🔄 Retrying ${description} (${attempts}/${maxAttempts})...`);
                    
                    if (attempts === 2 && CONFIG.AUTO_RECONNECT) {
                        log.warning('⚡ Reconnecting to improve speed...');
                        await this.connectionManager.reconnect();
                        this.stats.reconnects++;
                    }
                    
                    await delay(1000 * attempts);
                } else {
                    throw error;
                }
            }
        }
    }

    async cloneServer(sourceGuildId, targetGuildId, cloneEmojis = true, progressChannel = null) {
        if (this.isCloning) {
            throw new Error('Already cloning a server!');
        }

        this.isCloning = true;
        this.connectionManager.startSlowDetection(() => {
            this.stats.reconnects++;
            this.sendProgress('🔄 Auto-reconnected to improve speed', progressChannel);
        });

        try {
            const sourceGuild = this.client.guilds.cache.get(sourceGuildId);
            const targetGuild = this.client.guilds.cache.get(targetGuildId);

            if (!sourceGuild) {
                throw new Error('Source server not found! Make sure you are in the server.');
            }

            if (!targetGuild) {
                throw new Error('Target server not found! Make sure you are in the server and have Admin permissions.');
            }

            this.sendProgress(`🚀 Starting clone: ${sourceGuild.name} → ${targetGuild.name}`, progressChannel);
            this.sendProgress('⏳ This may take several minutes...', progressChannel);

            // Delete existing content
            await this.deleteExistingContent(targetGuild, progressChannel);
            
            // Clone roles
            await this.cloneRoles(sourceGuild, targetGuild, progressChannel);
            
            // Clone categories
            await this.cloneCategories(sourceGuild, targetGuild, progressChannel);
            
            // Clone channels
            await this.cloneChannels(sourceGuild, targetGuild, progressChannel);
            
            // Clone emojis
            if (cloneEmojis) {
                await this.cloneEmojis(sourceGuild, targetGuild, progressChannel);
            }
            
            // Clone server settings
            await this.cloneServerSettings(sourceGuild, targetGuild, progressChannel);

            // Show statistics
            this.showStatistics(progressChannel);
            this.sendProgress('🎉 Server cloned successfully!', progressChannel);

        } catch (error) {
            this.sendProgress(`❌ Clone failed: ${error.message}`, progressChannel);
            throw error;
        } finally {
            this.isCloning = false;
            this.connectionManager.stopSlowDetection();
        }
    }

    async deleteExistingContent(guild, progressChannel) {
        this.currentOperation = 'Deleting existing content';
        this.sendProgress('🗑️  Deleting existing channels and roles...', progressChannel);
        
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

        this.sendProgress('✅ Cleanup completed', progressChannel);
    }

    async cloneRoles(sourceGuild, targetGuild, progressChannel) {
        this.currentOperation = 'Cloning roles';
        this.sendProgress('👑 Cloning roles...', progressChannel);
        
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
                    this.stats.rolesCreated++;
                }, `Create role ${role.name}`);
                
                await delay(CONFIG.OPERATION_DELAY);

            } catch (error) {
                this.sendProgress(`⚠️ Failed role ${role.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
            }
        }

        this.sendProgress(`✅ Created ${this.stats.rolesCreated} roles`, progressChannel);
    }

    async cloneCategories(sourceGuild, targetGuild, progressChannel) {
        this.currentOperation = 'Cloning categories';
        this.sendProgress('📁 Cloning categories...', progressChannel);
        
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

                    this.stats.categoriesCreated++;
                }, `Create category ${category.name}`);
                
                await delay(CONFIG.OPERATION_DELAY);

            } catch (error) {
                this.sendProgress(`⚠️ Failed category ${category.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
            }
        }

        this.sendProgress(`✅ Created ${this.stats.categoriesCreated} categories`, progressChannel);
    }

    async cloneChannels(sourceGuild, targetGuild, progressChannel) {
        this.currentOperation = 'Cloning channels';
        this.sendProgress('💬 Cloning channels...', progressChannel);
        
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
                    this.stats.channelsCreated++;
                }, `Create channel ${channel.name}`);
                
                await delay(CONFIG.OPERATION_DELAY);

            } catch (error) {
                this.sendProgress(`⚠️ Failed channel ${channel.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
            }
        }

        this.sendProgress(`✅ Created ${this.stats.channelsCreated} channels`, progressChannel);
    }

    async cloneEmojis(sourceGuild, targetGuild, progressChannel) {
        this.currentOperation = 'Cloning emojis';
        this.sendProgress('😀 Cloning emojis...', progressChannel);
        
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

                    this.stats.emojisCreated++;
                }, `Create emoji ${emoji.name}`);
                
                await delay(CONFIG.EMOJI_DELAY);

            } catch (error) {
                this.sendProgress(`⚠️ Failed emoji ${emoji.name}: ${error.message}`, progressChannel);
                this.stats.failed++;
                continue;
            }
        }

        this.sendProgress(`✅ Created ${this.stats.emojisCreated} emojis`, progressChannel);
    }

    async cloneServerSettings(sourceGuild, targetGuild, progressChannel) {
        this.currentOperation = 'Cloning server settings';
        this.sendProgress('⚙️  Cloning server settings...', progressChannel);
        
        try {
            let iconData = null;
            
            if (sourceGuild.iconURL()) {
                try {
                    iconData = await downloadImage(sourceGuild.iconURL({ format: 'png', size: 1024 }));
                } catch (error) {
                    this.sendProgress('⚠️ Could not download server icon', progressChannel);
                }
            }

            await this.safeOperation(async () => {
                await targetGuild.setName(sourceGuild.name);
                
                if (iconData) {
                    await targetGuild.setIcon(iconData);
                }
            }, 'Update server settings');

            this.sendProgress(`✅ Updated server name: ${sourceGuild.name}`, progressChannel);
            if (iconData) {
                this.sendProgress('✅ Updated server icon', progressChannel);
            }

        } catch (error) {
            this.sendProgress(`⚠️ Failed server settings: ${error.message}`, progressChannel);
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

    showStatistics(progressChannel) {
        const total = this.stats.rolesCreated + this.stats.categoriesCreated + 
                     this.stats.channelsCreated + this.stats.emojisCreated;
        const successRate = total > 0 ? Math.round((total/(total + this.stats.failed)) * 100) : 0;
        
        const statsMessage = `
📊 **Clone Statistics:**
✅ Roles: ${this.stats.rolesCreated}
✅ Categories: ${this.stats.categoriesCreated}
✅ Channels: ${this.stats.channelsCreated}
✅ Emojis: ${this.stats.emojisCreated}
🔄 Reconnects: ${this.stats.reconnects}
❌ Failed: ${this.stats.failed}
📈 Success Rate: ${successRate}%`;
        
        this.sendProgress(statsMessage, progressChannel);
    }
    
    sendProgress(message, progressChannel) {
        this.connectionManager.updateActivity();
        
        if (progressChannel) {
            progressChannel.send(message).catch(() => {});
        }
        
        // Log to console
        const cleanMessage = message.replace(/\*\*/g, '').trim();
        
        if (message.includes('❌') || message.includes('Failed')) {
            log.error(cleanMessage);
        } else if (message.includes('✅') || message.includes('Created') || message.includes('Updated')) {
            log.success(cleanMessage);
        } else if (message.includes('⚠️')) {
            log.warning(cleanMessage);
        } else {
            log.info(cleanMessage);
        }
    }
}

// ====== Global Variables ======
const client = new Client();
const connectionManager = new ConnectionManager(client);
const serverCloner = new ServerCloner(client, connectionManager);

// Store for user inputs
const userData = new Map();

// ====== Setup Client Events ======
function setupClientEvents(client) {
    client.on('ready', () => {
        log.success(`✅ Logged in as ${client.user.tag}`);
        log.info(`📊 Servers: ${client.guilds.cache.size}`);
        log.info('🤖 Bot is ready! Use !clone to start cloning');
    });

    client.on('messageCreate', async (message) => {
        // Ignore bot messages
        if (message.author.bot) return;
        
        // Check if user is allowed
        if (!CONFIG.ALLOWED_USER_IDS.includes(message.author.id)) {
            return;
        }

        // Handle !clone command - Show interactive form
        if (message.content.startsWith('!clone')) {
            const userState = userData.get(message.author.id);
            
            if (userState && userState.step) {
                message.channel.send('❌ You already have an active cloning process!');
                return;
            }

            // Start interactive form
            userData.set(message.author.id, {
                step: 'awaiting_token',
                token: null,
                sourceId: null,
                targetId: null,
                channel: message.channel
            });

            // Send instructions via DM
            try {
                const dm = await message.author.createDM();
                
                const instructions = `
🔧 **Discord Server Cloner - Setup**

Please send the following information in this DM:

1️⃣ **Your Discord Token**
Send: \`token YOUR_TOKEN_HERE\`
*(Get token from: F12 → Application → Local Storage → token)*

2️⃣ **Source Server ID**
Send: \`source SERVER_ID\`
*(Right-click server → Copy ID)*

3️⃣ **Target Server ID**
Send: \`target SERVER_ID\`
*(You need Admin permissions in target server)*

⚠️ **Important:**
• This will DELETE ALL content in target server
• Keep your token private
• Cancel anytime by sending \`cancel\`
                `;
                
                dm.send(instructions);
                message.channel.send('📨 I\'ve sent you a DM with instructions. Please check your DMs!');
            } catch (error) {
                message.channel.send('❌ Cannot send you a DM. Please enable DMs from server members.');
                userData.delete(message.author.id);
            }
        }

        // Handle cancel command
        if (message.content.toLowerCase() === 'cancel') {
            const userState = userData.get(message.author.id);
            if (userState) {
                userData.delete(message.author.id);
                message.channel.send('✅ Operation cancelled.');
            }
        }

        // Handle help command
        if (message.content === '!help') {
            const helpMessage = `
📖 **Server Cloner Commands:**

\`!clone\` - Start server cloning process
\`!status\` - Check bot status
\`!servers\` - List servers you're in
\`cancel\` - Cancel current operation

**How to use:**
1. Type \`!clone\` in any channel
2. Follow instructions in DMs
3. Send token and server IDs
4. Confirm and wait for completion

**Auto-Reconnect Feature:**
• Automatically reconnects if cloning slows down
• Resumes from where it left off
• Max 3 reconnection attempts
            `;
            
            message.channel.send(helpMessage);
        }

        // Handle status command
        if (message.content === '!status') {
            const uptime = process.uptime();
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = Math.floor(uptime % 60);
            
            const statusMessage = `
📊 **Bot Status:**
• Logged in: ${client.user?.tag || 'Not connected'}
• Uptime: ${hours}h ${minutes}m ${seconds}s
• Auto-reconnect: ${CONFIG.AUTO_RECONNECT ? '✅ Enabled' : '❌ Disabled'}
• Max reconnects: ${CONFIG.MAX_RECONNECT_ATTEMPTS}
• Active clones: ${userData.size}
            `;
            
            message.channel.send(statusMessage);
        }

        // Handle servers command
        if (message.content === '!servers') {
            const servers = client.guilds.cache.map(guild => 
                `• **${guild.name}** - \`${guild.id}\``
            ).join('\n');
            
            const serverList = `📋 **Servers (${client.guilds.cache.size}):**\n${servers}`;
            
            if (serverList.length > 2000) {
                const chunks = serverList.match(/.{1,2000}/g);
                for (const chunk of chunks) {
                    message.channel.send(chunk);
                    await delay(500);
                }
            } else {
                message.channel.send(serverList);
            }
        }
    });

    // Handle DM messages for data collection
    client.on('messageCreate', async (message) => {
        if (message.channel.type !== 'DM' || message.author.bot) return;
        
        const userState = userData.get(message.author.id);
        if (!userState) return;
        
        const content = message.content.trim();
        
        if (content.toLowerCase() === 'cancel') {
            userData.delete(message.author.id);
            message.channel.send('✅ Operation cancelled.');
            return;
        }
        
        if (userState.step === 'awaiting_token') {
            if (content.startsWith('token ')) {
                const token = content.slice(6).trim();
                userState.token = token;
                userState.step = 'awaiting_source';
                userData.set(message.author.id, userState);
                
                message.channel.send('✅ Token received! Now send source server ID: `source SERVER_ID`');
            } else {
                message.channel.send('❌ Please send token in format: `token YOUR_TOKEN_HERE`');
            }
        } 
        else if (userState.step === 'awaiting_source') {
            if (content.startsWith('source ')) {
                const sourceId = content.slice(7).trim();
                if (!/^\d+$/.test(sourceId)) {
                    message.channel.send('❌ Invalid server ID! Must be numbers only.');
                    return;
                }
                userState.sourceId = sourceId;
                userState.step = 'awaiting_target';
                userData.set(message.author.id, userState);
                
                message.channel.send('✅ Source server ID received! Now send target server ID: `target SERVER_ID`');
            } else {
                message.channel.send('❌ Please send source ID in format: `source SERVER_ID`');
            }
        }
        else if (userState.step === 'awaiting_target') {
            if (content.startsWith('target ')) {
                const targetId = content.slice(7).trim();
                if (!/^\d+$/.test(targetId)) {
                    message.channel.send('❌ Invalid server ID! Must be numbers only.');
                    return;
                }
                userState.targetId = targetId;
                userState.step = 'ready';
                userData.set(message.author.id, userState);
                
                // Ask for confirmation
                const confirmMessage = `
✅ **All data received!**

**Source Server:** \`${userState.sourceId}\`
**Target Server:** \`${userState.targetId}\`

⚠️ **WARNING:** This will DELETE ALL existing content in the target server!

Reply with \`confirm\` to start cloning or \`cancel\` to abort.
                `;
                
                message.channel.send(confirmMessage);
            } else {
                message.channel.send('❌ Please send target ID in format: `target SERVER_ID`');
            }
        }
        else if (userState.step === 'ready') {
            if (content.toLowerCase() === 'confirm') {
                // Start cloning process
                message.channel.send('🚀 Starting cloning process... This may take several minutes.');
                userState.channel.send(`🔄 <@${message.author.id}> has started cloning process...`);
                
                // Create selfbot client with user's token
                try {
                    const selfbotClient = new Client();
                    await selfbotClient.login(userState.token);
                    
                    const userConnectionManager = new ConnectionManager(selfbotClient);
                    const userCloner = new ServerCloner(selfbotClient, userConnectionManager);
                    
                    // Clone the server
                    await userCloner.cloneServer(
                        userState.sourceId, 
                        userState.targetId, 
                        true, 
                        userState.channel
                    );
                    
                    // Clean up
                    selfbotClient.destroy();
                    
                } catch (error) {
                    userState.channel.send(`❌ Cloning failed: ${error.message}`);
                    log.error(`Cloning failed for user ${message.author.id}: ${error.message}`);
                } finally {
                    userData.delete(message.author.id);
                }
            } 
            else if (content.toLowerCase() === 'cancel') {
                userData.delete(message.author.id);
                message.channel.send('✅ Operation cancelled.');
            }
        }
    });

    client.on('error', (error) => {
        log.error(`Client error: ${error.message}`);
    });

    client.on('warn', (warning) => {
        log.warning(`Client warning: ${warning}`);
    });
}

// ====== Initialize ======
setupClientEvents(client);

// ====== Error Handling ======
process.on('unhandledRejection', (error) => {
    log.error(`Unhandled rejection: ${error.message}`);
});

process.on('uncaughtException', (error) => {
    log.error(`Uncaught exception: ${error.message}`);
    process.exit(1);
});

// ====== Start Bot ======
client.login(CONFIG.TOKEN).then(() => {
    log.success('🤖 Bot started successfully!');
}).catch((error) => {
    log.error(`❌ Login failed: ${error.message}`);
    process.exit(1);
});
